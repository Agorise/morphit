#!/bin/sh
# morphit-ipfs-gc.sh — let go of superseded Morphit releases and indexer
# snapshots on this node's IPFS (Kubo), then reclaim the space. (v1.20.0, C16)
#
# WHY. Every upgrade adds (seeds) the new release directory (~35 MB) and the
# pin timer pins each new release CID; the canonical snapshot publisher pins a
# fresh ~600 kB indexer snapshot every day and stages a copy of it inside the
# IPFS repo. Nothing ever let go of the old ones, so the repo only grew.
#
# WHAT IS KEPT — decided from this node's own state, with no network at all
# (safe on a tor-only node; `--offline` stops Kubo from fetching anything):
#   releases   (a pin is a Morphit release when its metadata.json says so —
#              the file stage-release-dir.sh writes into every release dir)
#     - the CID the chain anchors for the CURRENT release, as this node's own
#       indexer serves it (/v1/release → distribution.ipfs_cid);
#     - every release at or above the anchored version (one this node has
#       seeded before its broadcast, e.g. on the release box between BLOCK 3
#       and BLOCK 5 of the ceremony);
#     - the PREVIOUS release (the newest one below the anchored version), for
#       rollback and for peers that have not upgraded yet;
#     - the release this node is running (its package.json version).
#     When the indexer does not answer, no release is let go.
#   snapshots  (a pin is an indexer snapshot when it is a gzip tar whose
#              manifest.json has snapshotFormatVersion + lastAppliedBlock)
#     - the snapshot the chain anchors, as the snapshot mirror last VERIFIED it
#       against the signed on-chain op (/var/lib/morphit/snapshot-mirror.json);
#     - every snapshot newer than that one (the publisher's not-yet-anchored
#       exports — any of them may be the one broadcast next);
#     - the KEEP_OLDER (2) newest older ones: fast-sync and the mirrors only
#       ever ask for the newest anchored snapshot, so two older copies cover a
#       newcomer that read the chain just before a new anchor landed.
#     When no mirror state exists yet, no snapshot is let go.
#   anything else pinned here is not ours to judge and is never touched.
# The staged copies the publisher keeps in <repo>/indexer-snapshots/ (tarball +
# payload json) go with their snapshot, after it is unpinned.
#
# Talks to the RUNNING daemon over its API (never opens the repo itself), so it
# runs as root without creating root-owned files in the ipfs user's repo.
#
# Usage:  morphit-ipfs-gc.sh [--dry-run]
# The last line is machine-readable:
#   MORPHIT_IPFS_GC result=<done|nothing-to-do|dry-run|no-daemon|partial>
#     pins_before=N pins_after=N unpinned=N staged_removed=N
#     kept_releases=<tags> kept_snapshots=<blocks> repo_bytes_before=N repo_bytes_after=N
# Exit status: 0 unless something it tried to remove could not be removed (1).
# POSIX sh (dash-safe).
set -u

log() { printf 'morphit-ipfs-gc: %s\n' "$*" >&2; }

[ -r /etc/morphit/ipfs-pin.env ] && . /etc/morphit/ipfs-pin.env

DRY=no
case "${1:-}" in
	--dry-run) DRY=yes ;;
	'') : ;;
	*) echo "usage: morphit-ipfs-gc.sh [--dry-run]" >&2; exit 2 ;;
esac

IPFS_REPO="${IPFS_PATH:-/var/lib/ipfs/.ipfs}"
IPFS_BIN="${MORPHIT_IPFS_BIN:-ipfs}"
RELEASE_URL="${MORPHIT_RELEASE_URL:-http://127.0.0.1:${MORPHIT_INDEXER_PORT:-8081}/v1/release}"
MIRROR_STATE="${MORPHIT_SNAPSHOT_MIRROR_STATE:-/var/lib/morphit/snapshot-mirror.json}"
INSTALL_DIR="${MORPHIT_INSTALL_DIR:-/opt/morphit}"
KEEP_OLDER="${MORPHIT_SNAPSHOT_KEEP_OLDER:-2}"
GC_TIMEOUT="${MORPHIT_IPFS_GC_TIMEOUT:-600}"
STAGE_DIR="$IPFS_REPO/indexer-snapshots"
case "$KEEP_OLDER$GC_TIMEOUT" in *[!0-9]*) log "numeric settings must be whole numbers"; exit 2 ;; esac

command -v "$IPFS_BIN" >/dev/null 2>&1 || { log "ipfs (Kubo) is not installed — nothing to do."; echo "MORPHIT_IPFS_GC result=no-daemon"; exit 0; }

# The daemon's API address: its own api file, else its config, else Kubo's default.
API="$(cat "$IPFS_REPO/api" 2>/dev/null | tr -d ' \t\r\n')"
[ -n "$API" ] || API="/ip4/127.0.0.1/tcp/5001"
IPFS() { "$IPFS_BIN" --api "$API" "$@"; }
if ! IPFS --timeout=15s id >/dev/null 2>&1; then
	log "the IPFS daemon is not answering at $API — nothing was changed (it runs again next week)."
	echo "MORPHIT_IPFS_GC result=no-daemon"
	exit 0
fi

WORK="$(mktemp -d)" || exit 2
trap 'rm -rf "$WORK"' EXIT

# ── semver helper: "1.20.0" → a fixed-width key that sorts as TEXT ("k…", so
# awk never compares it as a number); a pre-release sorts below its release.
vkey() { printf '%s\n' "$1" | awk -F'[.-]' '{ pre = ($4 == "") ? 1 : 0; printf "k%06d%06d%06d%d\n", $1, $2, $3, pre }'; }

repo_bytes() { IPFS --timeout=60s repo stat --size-only 2>/dev/null | awk '/RepoSize/ { print $2 }'; }

# ── 1. What is pinned, and what each pin is ───────────────────────────────────
IPFS --timeout=60s pin ls --type=recursive --quiet >"$WORK/pins" 2>/dev/null || {
	log "could not list this node's pins — nothing was changed."
	echo "MORPHIT_IPFS_GC result=partial"
	exit 1
}
pins_before="$(wc -l <"$WORK/pins" | tr -d ' ')"
bytes_before="$(repo_bytes)"
: >"$WORK/releases" # "<vkey> <tag> <cid>"
: >"$WORK/snaps"    # "<block> <cid>"
while IFS= read -r cid; do
	[ -n "$cid" ] || continue
	# A Morphit release directory? (metadata.json, as stage-release-dir.sh writes it)
	meta="$(IPFS --offline --timeout=30s cat -l 65536 "$cid/metadata.json" 2>/dev/null)"
	if [ -n "$meta" ]; then
		name="$(printf '%s' "$meta" | sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
		tag="$(printf '%s' "$meta" | sed -n 's/^[[:space:]]*"tag":[[:space:]]*"\(v[0-9][0-9.]*[-0-9A-Za-z.]*\)".*/\1/p' | head -n1)"
		tarball="$(printf '%s' "$meta" | sed -n 's/^[[:space:]]*"tarball":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
		if [ "$name" = "Morphit" ] && [ -n "$tag" ] && [ "$tarball" = "morphit-$tag.tar.gz" ]; then
			printf '%s %s %s\n' "$(vkey "${tag#v}")" "$tag" "$cid" >>"$WORK/releases"
			continue
		fi
	fi
	# An indexer snapshot? (a gzip tar carrying manifest.json)
	magic="$(IPFS --offline --timeout=30s cat -l 2 "$cid" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
	[ "$magic" = "1f8b" ] || continue
	man="$(IPFS --offline --timeout=120s cat "$cid" 2>/dev/null | tar -xzO -f - --occurrence=1 manifest.json 2>/dev/null | head -c 65536)"
	blk="$(printf '%s' "$man" | tr -d '\n' | sed -n 's/.*"lastAppliedBlock"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
	if [ -n "$blk" ] && printf '%s' "$man" | grep -q '"snapshotFormatVersion"'; then
		printf '%s %s\n' "$blk" "$cid" >>"$WORK/snaps"
	fi
done <"$WORK/pins"

# The publisher's staged copies: block → cid from each payload json.
: >"$WORK/staged" # "<block> <cid-or-dash>"
if [ -d "$STAGE_DIR" ] && [ ! -L "$STAGE_DIR" ]; then
	for f in "$STAGE_DIR"/indexer-snapshot-payload-*.json "$STAGE_DIR"/morphit-indexer-snapshot-*.tar.gz; do
		[ -f "$f" ] || continue
		b="$(basename "$f" | sed -n 's/^indexer-snapshot-payload-\([0-9][0-9]*\)\.json$/\1/p;s/^morphit-indexer-snapshot-\([0-9][0-9]*\)\.tar\.gz$/\1/p')"
		[ -n "$b" ] || continue
		c="-"
		case "$f" in *.json) c="$(sed -n 's/.*"ipfs_cid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -n1)" ;; esac
		printf '%s %s\n' "$b" "${c:--}" >>"$WORK/staged"
	done
fi

# ── 2. What the chain anchors (as this node already knows it) ─────────────────
REL_OK=no
anch_tag=""
anch_cid=""
# The configured URL first, then the indexer's standard local addresses — the
# same list (and override) morphit-ipfs-pin.sh uses.
# shellcheck disable=SC2086 # the candidate list is word-split on purpose
for u in "$RELEASE_URL" ${MORPHIT_RELEASE_URL_FALLBACKS:-http://127.0.0.1:8081/v1/release \
	http://172.18.0.1:8081/v1/release http://172.17.0.1:8081/v1/release}; do
	resp="$(curl -fsS --max-time 20 "$u" 2>/dev/null)" || continue
	anch_tag="$(printf '%s' "$resp" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')"
	anch_cid="$(printf '%s' "$resp" | grep -o '"ipfs_cid"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')"
	[ -n "$anch_tag" ] && REL_OK=yes
	break
done
anch_tag="v${anch_tag#v}"
running="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/package.json" 2>/dev/null | head -n1)"

SNAP_OK=no
anch_blk=""
anch_scid=""
if [ -r "$MIRROR_STATE" ]; then
	st="$(tr -d '\n' <"$MIRROR_STATE")"
	anch_scid="$(printf '%s' "$st" | sed -n 's/.*"cid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
	anch_blk="$(printf '%s' "$st" | sed -n 's/.*"lastAppliedBlock"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
	[ -n "$anch_scid" ] && [ -n "$anch_blk" ] && SNAP_OK=yes
fi

# ── 3. Decide ─────────────────────────────────────────────────────────────────
: >"$WORK/unpin"   # "<cid> <what>"
: >"$WORK/rmstage" # "<block> <cid|->"
kept_rel=""
if [ "$REL_OK" = yes ] && [ -s "$WORK/releases" ]; then
	ak="$(vkey "${anch_tag#v}")"
	rk="-"
	[ -n "$running" ] && rk="$(vkey "$running")"
	# The previous release: the newest held version below the anchored one.
	prev="$(awk -v ak="$ak" '$1 < ak && $1 > p { p = $1 } END { print (p == "" ? "-" : p) }' "$WORK/releases")"
	awk -v ak="$ak" -v prev="$prev" -v rk="$rk" -v ac="$anch_cid" -v kf="$WORK/kept-rel" -v uf="$WORK/unpin" '
		{ if ($3 == ac || $1 >= ak || $1 == prev || $1 == rk) print $2 > kf; else print $3, "release", $2 > uf }
	' "$WORK/releases"
	kept_rel="$(sort -u "$WORK/kept-rel" 2>/dev/null | paste -sd, -)"
elif [ -s "$WORK/releases" ]; then
	log "this node's indexer did not say which release is current, so every release stays pinned this time."
	kept_rel="$(awk '{print $2}' "$WORK/releases" | sort -u | paste -sd, -)"
fi

kept_snap=""
if [ "$SNAP_OK" = yes ]; then
	# Every snapshot this node knows of (pinned or staged): "<block> <cid|->".
	# A BLOCK is kept when any rule keeps it; everything about a dropped block
	# (its pin, its staged tarball and payload) goes.
	cat "$WORK/snaps" "$WORK/staged" | awk -v b="$anch_blk" -v ac="$anch_scid" -v k="$KEEP_OLDER" '
		{ n++; blk[n] = $1; cid[n] = $2; if ($1 < b) older[$1] = 1; if ($2 == ac) anch[$1] = 1 }
		END {
			# the KEEP_OLDER newest distinct blocks below the anchored one
			m = 0; for (x in older) ob[++m] = x + 0
			for (i = 1; i <= m; i++) for (j = i + 1; j <= m; j++) if (ob[j] > ob[i]) { t = ob[i]; ob[i] = ob[j]; ob[j] = t }
			for (i = 1; i <= m && i <= k; i++) keep[ob[i]] = 1
			for (i = 1; i <= n; i++) if (blk[i] >= b || (blk[i] in anch) || (blk[i] in keep)) keep[blk[i]] = 1
			for (i = 1; i <= n; i++) print blk[i], ((blk[i] in keep) ? "keep" : "drop")
		}' | sort -u >"$WORK/snap-verdict"
	kept_snap="$(awk '$2 == "keep" { print $1 }' "$WORK/snap-verdict" | sort -nu | paste -sd, -)"
	while read -r blk cid; do
		grep -qx "$blk drop" "$WORK/snap-verdict" && printf '%s snapshot %s\n' "$cid" "$blk" >>"$WORK/unpin"
	done <"$WORK/snaps"
	while read -r blk cid; do
		grep -qx "$blk drop" "$WORK/snap-verdict" && printf '%s %s\n' "$blk" "$cid" >>"$WORK/rmstage"
	done <"$WORK/staged"
elif [ -s "$WORK/snaps" ] || [ -s "$WORK/staged" ]; then
	log "the snapshot mirror has not recorded the anchored snapshot yet, so every snapshot stays this time."
	kept_snap="$(cat "$WORK/snaps" "$WORK/staged" | awk '{print $1}' | sort -nu | paste -sd, -)"
fi

nun="$(wc -l <"$WORK/unpin" | tr -d ' ')"
nrm="$(awk '{print $1}' "$WORK/rmstage" | sort -u | wc -l | tr -d ' ')"
summary() {
	echo "MORPHIT_IPFS_GC result=$1 pins_before=$pins_before pins_after=${pins_after:-$pins_before} unpinned=${unpinned:-0} staged_removed=${removed:-0} kept_releases=${kept_rel:--} kept_snapshots=${kept_snap:--} repo_bytes_before=${bytes_before:-?} repo_bytes_after=${bytes_after:-${bytes_before:-?}}"
}

if [ "$nun" -eq 0 ] && [ "$nrm" -eq 0 ]; then
	log "nothing superseded to let go (kept releases: ${kept_rel:-none}; kept snapshots: ${kept_snap:-none})."
	summary nothing-to-do
	exit 0
fi
if [ "$DRY" = yes ]; then
	while read -r cid what id; do log "would unpin $what $id ($cid)"; done <"$WORK/unpin"
	awk '{print $1}' "$WORK/rmstage" | sort -nu | while read -r blk; do log "would remove the staged copy of snapshot $blk"; done
	summary dry-run
	exit 0
fi

# ── 4. Let go, VERIFYING each unpin on the daemon itself ───────────────────────
unpinned=0
bad=0
while read -r cid what id; do
	IPFS --timeout=60s pin rm "$cid" >/dev/null 2>&1
	if IPFS --timeout=30s pin ls --type=recursive "$cid" >/dev/null 2>&1; then
		log "could not unpin $what $id ($cid); it stays."
		bad=1
	else
		log "unpinned $what $id ($cid)"
		unpinned=$((unpinned + 1))
	fi
done <"$WORK/unpin"

if [ "$unpinned" -gt 0 ]; then
	log "reclaiming the space (repo gc, up to ${GC_TIMEOUT}s)…"
	IPFS --timeout="${GC_TIMEOUT}s" repo gc --quiet >/dev/null 2>&1 || log "repo gc did not finish this time; Kubo's own periodic gc finishes it."
fi

IPFS --timeout=60s pin ls --type=recursive --quiet >"$WORK/pins-after" 2>/dev/null || cp "$WORK/pins" "$WORK/pins-after"

# Staged copies go only now, and only when nothing still pins them: a filestore
# (nocopy) pin reads its data FROM the staged file, so removing a file whose
# CID is still pinned would break that pin. Regular files in the staging dir only.
removed=0
awk '{print $1}' "$WORK/rmstage" | sort -nu >"$WORK/rmblocks"
while read -r blk; do
	still=""
	for c in $(awk -v b="$blk" '$1 == b && $2 != "-" { print $2 }' "$WORK/rmstage"); do
		grep -qx "$c" "$WORK/pins-after" && still="$c"
	done
	if [ -n "$still" ]; then
		log "kept the staged copy of snapshot $blk: $still is still pinned."
		continue
	fi
	for f in "$STAGE_DIR/morphit-indexer-snapshot-$blk.tar.gz" "$STAGE_DIR/indexer-snapshot-payload-$blk.json"; do
		[ -f "$f" ] && [ ! -L "$f" ] || continue
		if rm -f -- "$f"; then removed=$((removed + 1)); log "removed $f"; else bad=1; fi
	done
done <"$WORK/rmblocks"

pins_after="$(wc -l <"$WORK/pins-after" | tr -d ' ')"
bytes_after="$(repo_bytes)"
# Every CID we decided to keep must still be pinned — say so if not.
for cid in $(awk '{print $3}' "$WORK/releases") $(awk '{print $2}' "$WORK/snaps"); do
	grep -q "^$cid " "$WORK/unpin" && continue
	grep -qx "$cid" "$WORK/pins-after" || { log "note: $cid was pinned before this run and is not now (something else unpinned it)."; }
done
log "done: unpinned $unpinned, removed $removed staged file(s); repo ${bytes_before:-?} → ${bytes_after:-?} bytes."
if [ "$bad" -eq 0 ]; then summary done; exit 0; fi
summary partial
exit 1
