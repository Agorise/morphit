#!/bin/sh
# morphit-tor-only-os.sh — keep a TOR-ONLY (hidden-only) node's own operating
# system off clearnet. (v1.20.0, C13)
#
# WHY. Morphit's own services on a tor-only node reach nothing but Tor/I2P, yet
# the OS underneath kept talking to clearnet from the box's home IP: apt (the
# daily unattended-upgrades refresh) fetched from the Ubuntu mirrors directly,
# every apt refresh started Ubuntu Pro's "apt news" fetch, the motd news job
# fetched motd.ubuntu.com, and chrony polled public NTP pools. Each is a
# fingerprint (an ISP sees "this home IP runs Ubuntu and updates daily") and a
# DNS leak.
#
# WHAT THIS DOES (one list of changes, shared by the Ansible tor role for new
# installs and by `morphit-ops upgrade` for installed nodes, so both do exactly
# the same thing):
#   apt     every network apt source is rewritten to its Tor form (http:// ->
#           tor+http://, https:// -> tor+https://, the apt-transport-tor
#           scheme), AND a belt in /etc/apt/apt.conf.d/99morphit-tor-only.conf
#           points apt's http/https/tor proxy at Tor's SocksPort (socks5h: names
#           are resolved inside Tor, never by the box). The belt also covers
#           sources added later (a re-run of Ansible re-adding a plain https://
#           repo) and Ubuntu Pro's ESM cache refresh, which keeps apt's Acquire
#           settings. file:, cdrom: and copy: sources are local and left alone.
#   chrony  the network time sources (pool / server / peer / sourcedir lines,
#           which include DHCP-supplied NTP servers) are commented out, so
#           chronyd keeps the clock and the RTC but never sends NTP to anyone.
#           Time then comes from morphit-tor-timesync (HTTP Date headers of
#           several onion services, read over Tor). The CALLER only does this
#           after that Tor time check has been seen to work.
#   news    /etc/default/motd-news ENABLED=0, and Ubuntu Pro's apt news off
#           (`pro config set apt_news=false`) — both are clearnet fetches that
#           apt's proxy does not cover.
#
# Nothing here runs `apt-get update` or restarts a service: the caller does,
# and VERIFIES the result on the running system (an apt refresh over Tor; zero
# chrony sources), reverting with the matching *-revert mode if it did not take.
#
# Usage:  morphit-tor-only-os.sh <mode> [backup-dir]
#   apt-check | chrony-check | news-check
#       exit 0 when that part is already on its tor-only setting, 1 when not
#       (the reason is printed), 2 on a usage error.
#   apt-apply <dir> | chrony-apply <dir> | news-apply <dir>
#       back up every file it will touch into <dir> (once — a second apply into
#       the same dir keeps the ORIGINAL copies), then change it. Idempotent.
#   apt-revert <dir> | chrony-revert <dir> | news-revert <dir>
#       put back exactly what the matching apply backed up, byte for byte, and
#       remove what it created.
#   apt-verify
#       prove apt works over Tor on the RUNNING system: apt-check, then every
#       URI apt would fetch is tor+ (or local), then a real `apt-get update`
#       must fetch at least one index over Tor (a repository that is down for
#       its own reasons is named, not treated as a Tor failure). Waits for
#       apt's lock when unattended-upgrades holds it. Exit 0 = works over Tor,
#       1 = does not (the caller reverts), 3 = apt stayed busy (not verified),
#       10 = offline-install phase (apt points at the bundled repo): the
#       configuration was checked, the network fetch is left for later.
#       Last line: MORPHIT_TOR_APT result=<ok|failed|busy|config-only> ...
#       MORPHIT_APT_VERIFY_TIMEOUT (s, default 900) bounds lock wait + refresh;
#       MORPHIT_APT_LOCK_WAIT (s, default 300) bounds the lock wait alone.
#   apt-recover
#       an earlier switch left unverified (apt.pending) is verified now, or put
#       back. No marker: nothing to do.
# Env:
#   MORPHIT_TOR_SOCKS  Tor's SocksPort as <IPv4>:<port> (default 127.0.0.1:9050;
#                      the indexer's MORPHIT_INDEXER_TOR_SOCKS is the source).
#   MORPHIT_OS_ROOT    prefix for every path (tests only; empty on a real box).
#   MORPHIT_PRO_BIN    the Ubuntu Pro CLI (tests only; default `pro`).
# POSIX sh (dash-safe). Must run as root on a real box.
set -u

R="${MORPHIT_OS_ROOT:-}"
SOCKS="${MORPHIT_TOR_SOCKS:-127.0.0.1:9050}"
MODE="${1:-}"
BK="${2:-}"
MARK='#morphit-tor-only: '
BELT="$R/etc/apt/apt.conf.d/99morphit-tor-only.conf"
METHODS="$R/usr/lib/apt/methods"

# Messages go to stderr, so a function's stdout stays its value.
log() { printf 'morphit-tor-only-os: %s\n' "$*" >&2; }
LIST="$(mktemp)" || exit 3
trap 'rm -f "$LIST"' EXIT

# Only an IPv4 literal and a port: a NAME here would be resolved by the system
# resolver (clearnet DNS), which is the thing this script exists to stop.
case "$SOCKS" in
	*[!0-9.:]* | '' | :* | *: ) log "MORPHIT_TOR_SOCKS must be <IPv4>:<port>, got '$SOCKS'"; exit 2 ;;
esac
PROXY="socks5h://apt-transport-tor@$SOCKS"

# ── backup / revert ──────────────────────────────────────────────────────────
need_bk() {
	[ -n "$BK" ] || { log "$MODE needs a backup directory"; exit 2; }
	mkdir -p "$BK/files" || { log "cannot create backup directory $BK"; exit 3; }
	touch "$BK/created"
}

# Keep the ORIGINAL of $1 once. A file that did not exist is recorded so a
# revert removes it again.
bk() {
	if [ -e "$BK/files$1" ] || [ -L "$BK/files$1" ] || grep -qxF -- "$1" "$BK/created"; then
		return 0
	fi
	if [ -e "$1" ] || [ -L "$1" ]; then
		mkdir -p "$BK/files$(dirname -- "$1")" && cp -a -- "$1" "$BK/files$1" || {
			log "could not back up $1 — changing nothing"
			exit 3
		}
	else
		printf '%s\n' "$1" >>"$BK/created"
	fi
}

revert_from() {
	[ -n "$BK" ] && [ -d "$BK/files" ] || { log "no backup at '$BK' — nothing to revert"; exit 1; }
	rc=0
	# Files first (restoring an original), then what the apply created.
	(cd "$BK/files" && find . \( -type f -o -type l \) -print) | while IFS= read -r rel; do
		p="${rel#.}"
		mkdir -p "$(dirname -- "$p")"
		cp -a -- "$BK/files$p" "$p" || { log "could not restore $p"; exit 1; }
	done || rc=1
	if [ -f "$BK/created" ]; then
		while IFS= read -r p; do
			[ -n "$p" ] && rm -f -- "$p"
		done <"$BK/created"
	fi
	return "$rc"
}

# Rewrite $1 through a filter command ($2…) only when the output differs;
# written to a temp file in the same dir, then renamed over (mode/owner kept).
rewrite() {
	f="$1"
	shift
	tmp="$(mktemp "$(dirname -- "$f")/.morphit-tor-only.XXXXXX")" || return 1
	if ! "$@" <"$f" >"$tmp"; then
		rm -f -- "$tmp"
		return 1
	fi
	if cmp -s -- "$f" "$tmp"; then
		rm -f -- "$tmp"
		return 0
	fi
	bk "$f"
	chmod --reference="$f" -- "$tmp" 2>/dev/null || chmod 0644 -- "$tmp"
	chown --reference="$f" -- "$tmp" 2>/dev/null || true
	mv -f -- "$tmp" "$f" && log "updated $f"
}

# ── apt ──────────────────────────────────────────────────────────────────────
# Every apt source file, one per line. A link is skipped (never written through;
# the proxy belt still covers what it names).
apt_source_files() {
	for f in "$R/etc/apt/sources.list" "$R"/etc/apt/sources.list.d/*.list "$R"/etc/apt/sources.list.d/*.sources; do
		[ -f "$f" ] && [ ! -L "$f" ] && printf '%s\n' "$f"
	done
}

# One awk program for both formats. MODE=fix prints the file with every network
# URI in an ACTIVE position turned into its tor+ form; MODE=count prints how
# many network URIs are still NOT on Tor. mawk-compatible (Ubuntu's awk).
APT_AWK='
function torline(s,   out, m) {
	s = " " s; out = ""
	while (match(s, /[ \t](mirror\+)?https?:\/\//)) {
		m = substr(s, RSTART, RLENGTH)
		out = out substr(s, 1, RSTART) "tor+" substr(m, 2)
		s = substr(s, RSTART + RLENGTH)
		bare++
	}
	return substr(out s, 2)
}
BEGIN { bare = 0; infield = 0 }
{
	line = $0
	if (line ~ /^[ \t]*#/) { if (mode == "fix") print line; next }
	if (deb822) {
		if (line ~ /^[ \t]*$/) { infield = 0 }
		else if (line ~ /^[^ \t]/) {
			infield = (tolower(line) ~ /^uris[ \t]*:/)
			if (infield) {
				c = index(line, ":")
				line = substr(line, 1, c) torline(substr(line, c + 1))
			}
		} else if (infield) {
			line = torline(line)
		}
	} else if (line ~ /^[ \t]*deb(-src)?[ \t]/) {
		line = torline(line)
	}
	if (mode == "fix") print line
}
END { if (mode == "count") print bare }
'
apt_fix_filter() { awk -v mode=fix -v deb822="$DEB822" "$APT_AWK"; }

apt_bare_count() {
	total=0
	apt_source_files >"$LIST"
	while IFS= read -r f; do
		case "$f" in *.sources) DEB822=1 ;; *) DEB822=0 ;; esac
		n="$(awk -v mode=count -v deb822="$DEB822" "$APT_AWK" <"$f")"
		if [ "${n:-0}" -gt 0 ]; then
			log "not on Tor yet: $f ($n network source address(es))"
			total=$((total + n))
		fi
	done <"$LIST"
	echo "$total"
}

belt_text() {
	cat <<EOF
// Managed by Morphit (tor-only node) — morphit-tor-only-os.sh. apt reaches
// every repository over Tor: tor+http(s) sources use Acquire::tor::Proxy, and
// any plain http(s) source (one added later, or Ubuntu Pro's ESM cache) uses
// the same Tor SocksPort through the two proxies below. socks5h means names are
// resolved inside Tor, never by this box. \`sudo morphit-ops upgrade\` keeps it.
Acquire::tor::Proxy "$PROXY";
Acquire::http::Proxy "$PROXY";
Acquire::https::Proxy "$PROXY";
EOF
}

apt_check() {
	ok=0
	for m in tor+http tor+https; do
		if [ ! -x "$METHODS/$m" ]; then
			log "apt cannot fetch tor+ addresses yet: $METHODS/$m is missing (apt-transport-tor)"
			ok=1
		fi
	done
	n="$(apt_bare_count)"
	[ "$n" -eq 0 ] || ok=1
	# The EFFECTIVE setting, as apt itself resolves it (a later file could
	# override ours), not just our file's text.
	eff="$(apt-config dump --format '%f=%v%n' Acquire 2>/dev/null)"
	for k in tor http https; do
		if ! printf '%s\n' "$eff" | grep -qxF "Acquire::$k::Proxy=$PROXY"; then
			log "apt's $k proxy is not Tor's SocksPort ($PROXY)"
			ok=1
		fi
	done
	# A per-host exception is the operator's own choice; say it, don't fail on it.
	printf '%s\n' "$eff" | grep -E '^Acquire::https?::Proxy::' | while IFS= read -r l; do
		log "note: apt has a per-host proxy exception: $l"
	done
	return "$ok"
}

apt_apply() {
	need_bk
	apt_source_files >"$LIST"
	while IFS= read -r f; do
		case "$f" in *.sources) DEB822=1 ;; *) DEB822=0 ;; esac
		rewrite "$f" apt_fix_filter || { log "could not rewrite $f"; exit 3; }
	done <"$LIST"
	want="$(belt_text)"
	if [ ! -f "$BELT" ] || [ "$(cat "$BELT")" != "$want" ]; then
		bk "$BELT"
		mkdir -p "$(dirname -- "$BELT")"
		printf '%s\n' "$want" >"$BELT.tmp.$$" && chmod 0644 "$BELT.tmp.$$" && mv -f "$BELT.tmp.$$" "$BELT" \
			|| { log "could not write $BELT"; exit 3; }
		log "wrote $BELT"
	fi
}

# Every URI `apt-get update` would fetch from the given source config must be
# on Tor or local. $@ = extra apt-get options.
apt_uris_on_tor() {
	out="$(apt-get "$@" --print-uris update 2>&1)" || { log "apt could not read its sources: $(printf '%s' "$out" | tail -n1)"; return 1; }
	bad="$(printf '%s\n' "$out" | sed -n "s/^'\([^']*\)'.*/\1/p" | grep -Ev '^(tor\+|file:|copy:|cdrom:)' | head -n3)"
	if [ -n "$bad" ]; then
		log "apt would still fetch directly: $(printf '%s' "$bad" | tr '\n' ' ')"
		return 1
	fi
	return 0
}

apt_verify() {
	apt_check || { echo "MORPHIT_TOR_APT result=failed reason=config"; return 1; }
	if [ -f "$R/etc/apt/apt.conf.d/99-morphit-offline.conf" ]; then
		# Offline-appliance install phase: apt reads only the bundled repo until
		# morphit-first-online removes the override. Check the REAL sources'
		# configuration; the network fetch is proven by the next upgrade.
		apt_uris_on_tor -o "Dir::Etc::SourceList=$R/etc/apt/sources.list" -o "Dir::Etc::SourceParts=$R/etc/apt/sources.list.d" \
			|| { echo "MORPHIT_TOR_APT result=failed reason=config"; return 1; }
		log "offline install phase: apt's Tor configuration is in place; it is used once this node is online."
		echo "MORPHIT_TOR_APT result=config-only"
		return 10
	fi
	apt_uris_on_tor || { echo "MORPHIT_TOR_APT result=failed reason=config"; return 1; }
	# One overall deadline for lock waiting + the refresh (the caller may have
	# only minutes left before it is stopped): past it, apt-get is ended by
	# `timeout` itself (never left running, holding apt's lock) and the verdict
	# is "not verified" — the caller then puts apt back.
	budget="${MORPHIT_APT_VERIFY_TIMEOUT:-900}"
	case "$budget" in '' | *[!0-9]*) budget=900 ;; esac
	lockwait="${MORPHIT_APT_LOCK_WAIT:-300}"
	case "$lockwait" in '' | *[!0-9]*) lockwait=300 ;; esac
	t_end=$(($(date +%s) + budget))
	waited=0
	while :; do
		left=$((t_end - $(date +%s)))
		if [ "$left" -lt 5 ]; then
			log "ran out of time before apt could refresh over Tor — not verified this time."
			echo "MORPHIT_TOR_APT result=failed reason=timeout"
			return 1
		fi
		out="$(LC_ALL=C timeout -k 5 "$left" apt-get update 2>&1)"
		urc=$?
		if [ "$urc" -eq 124 ] || [ "$urc" -eq 137 ]; then
			log "the package-list refresh over Tor did not finish in ${left} s — not verified this time."
			echo "MORPHIT_TOR_APT result=failed reason=timeout"
			return 1
		fi
		case "$out" in
			*"Could not get lock"*)
				if [ "$waited" -ge "$lockwait" ] || [ $((t_end - $(date +%s))) -lt 10 ]; then
					log "apt stayed busy (another apt run holds its lock) — not verified this time."
					echo "MORPHIT_TOR_APT result=busy"
					return 3
				fi
				[ "$waited" -eq 0 ] && log "apt is busy (unattended-upgrades?); waiting for it to finish…"
				sleep 5
				waited=$((waited + 5))
				continue
				;;
		esac
		break
	done
	# Per SOURCE ("<tor+uri> <suite>", as apt prints it): fetched over Tor when
	# it has a Hit/Get line and no Err line or E:/W: error naming it. A "Get"
	# alone proves nothing (apt prints it before it learns the file is bad).
	verdict="$(printf '%s\n' "$out" | awk '
		/^(Hit|Get|Err):[0-9]+ tor\+/ { k = $2 " " $3; seen[k] = 1; if ($1 ~ /^Err/) bad[k] = 1; else good[k] = 1; next }
		/^[EW]: / {
			for (i = 1; i < NF; i++) { t = $i; gsub(/^'"'"'/, "", t); if (t ~ /^tor\+/) { u = $(i + 1); gsub(/[:'"'"']+$/, "", u); bad[t " " u] = 1; break } }
		}
		END { ok = 0; nb = 0; for (k in good) if (!(k in bad)) ok++; for (k in bad) if (k in seen) nb++; print ok, nb }')"
	fetched="${verdict% *}"
	failed="${verdict#* }"
	if [ "${fetched:-0}" -ge 1 ]; then
		printf '%s\n' "$out" | grep -E '^Err:[0-9]+ ' | sed 's/^Err:[0-9]* /did not answer over Tor this time (apt retries it on its daily run): /' | while IFS= read -r l; do log "$l"; done
		echo "MORPHIT_TOR_APT result=ok fetched=$fetched failed=$failed"
		return 0
	fi
	log "no repository answered over Tor:"
	printf '%s\n' "$out" | grep -E '^(Err|E|W):' | head -n 4 | while IFS= read -r l; do log "  $l"; done
	echo "MORPHIT_TOR_APT result=failed fetched=0 failed=$failed"
	return 1
}

# A switch that was never verified (an upgrade stopped mid-check) must not
# linger: verify it now, or put apt back. Run by morphit-tor-only-recover.timer
# (soon after boot, then every 6 hours) and cheap when there is nothing to do.
# The marker holds the backup directory; only one under the state dir counts.
apt_recover() {
	rec_state="$R/var/lib/morphit-tor-only"
	rec_marker="$rec_state/apt.pending"
	[ -f "$rec_marker" ] || { echo "MORPHIT_TOR_APT result=nothing-pending"; return 0; }
	BK="$(head -n1 "$rec_marker" | tr -d '\r')"
	case "$BK" in "$rec_state"/backup-*) : ;; *) log "ignoring a pending marker that does not name a backup here"; rm -f "$rec_marker"; return 0 ;; esac
	[ -d "$BK/files" ] || { log "the pending switch has no backup any more; leaving apt as it is"; rm -f "$rec_marker"; return 0; }
	apt_verify
	rc=$?
	case "$rc" in
		0) rm -f "$rec_marker"; log "the earlier switch of apt to Tor now checks out; kept." ;;
		10) printf '%s\n' "$BK" >"$rec_state/apt.unverified"; rm -f "$rec_marker" ;;
		*)
			revert_from || log "could not put every apt file back; the originals are kept in $BK"
			rm -f "$rec_marker" "$rec_state/apt.unverified"
			log "an earlier switch of apt to Tor could not be verified, so apt's previous settings were put back; the next upgrade tries again."
			;;
	esac
	return 0
}

# ── chrony ───────────────────────────────────────────────────────────────────
chrony_files() {
	for f in "$R/etc/chrony/chrony.conf" "$R"/etc/chrony/conf.d/*.conf; do
		[ -f "$f" ] && [ ! -L "$f" ] && printf '%s\n' "$f"
	done
}
CHRONY_SRC_RE='^[[:space:]]*(pool|server|peer|sourcedir)([[:space:]]|$)'
chrony_fix_filter() { awk -v mark="$MARK" -v re="$CHRONY_SRC_RE" '{ if ($0 ~ re) print mark $0; else print }'; }

chrony_check() {
	ok=0
	chrony_files >"$LIST"
	while IFS= read -r f; do
		n="$(grep -cE "$CHRONY_SRC_RE" "$f" 2>/dev/null)"
		if [ "${n:-0}" -gt 0 ]; then
			log "chrony still names network time sources in $f ($n line(s))"
			ok=1
		fi
	done <"$LIST"
	return "$ok"
}

chrony_apply() {
	need_bk
	chrony_files >"$LIST"
	while IFS= read -r f; do
		rewrite "$f" chrony_fix_filter || { log "could not rewrite $f"; exit 3; }
	done <"$LIST"
}

# ── news (motd-news, Ubuntu Pro apt news) ────────────────────────────────────
MOTD="$R/etc/default/motd-news"
PRO="${MORPHIT_PRO_BIN:-pro}" # tests point this at a stub; never set on a real box
pro_apt_news() { command -v "$PRO" >/dev/null 2>&1 && "$PRO" config show apt_news 2>/dev/null | awk '{print $2}'; }

news_check() {
	ok=0
	if [ -f "$MOTD" ] && ! grep -qx 'ENABLED=0' "$MOTD"; then
		log "motd news still fetches motd.ubuntu.com ($MOTD)"
		ok=1
	fi
	if [ "$(pro_apt_news)" = "True" ]; then
		log "Ubuntu Pro apt news is still on"
		ok=1
	fi
	return "$ok"
}

news_apply() {
	need_bk
	if [ -f "$MOTD" ] && [ ! -L "$MOTD" ] && ! grep -qx 'ENABLED=0' "$MOTD"; then
		if grep -q '^ENABLED=' "$MOTD"; then
			rewrite "$MOTD" sed 's/^ENABLED=.*/ENABLED=0/' || exit 3
		else
			rewrite "$MOTD" sed '$a ENABLED=0' || exit 3
		fi
	fi
	if [ "$(pro_apt_news)" = "True" ]; then
		# Recorded so a revert turns it back on (it was on before).
		printf 'pro-apt-news=True\n' >>"$BK/state"
		if "$PRO" config set apt_news=false >/dev/null 2>&1; then
			log "turned Ubuntu Pro apt news off"
		else
			log "could not turn Ubuntu Pro apt news off"
			exit 3
		fi
	fi
}

news_revert() {
	revert_from || true
	if [ -f "$BK/state" ] && grep -qx 'pro-apt-news=True' "$BK/state" && command -v "$PRO" >/dev/null 2>&1; then
		"$PRO" config set apt_news=true >/dev/null 2>&1 || log "could not turn Ubuntu Pro apt news back on"
	fi
}

case "$MODE" in
	apt-check) apt_check ;;
	apt-apply) apt_apply ;;
	apt-revert) revert_from ;;
	apt-verify) apt_verify ;;
	apt-recover) apt_recover ;;
	chrony-check) chrony_check ;;
	chrony-apply) chrony_apply ;;
	chrony-revert) revert_from ;;
	news-check) news_check ;;
	news-apply) news_apply ;;
	news-revert) news_revert ;;
	*)
		echo "usage: morphit-tor-only-os.sh {apt|chrony|news}-{check|apply|revert} [backup-dir] | apt-verify | apt-recover" >&2
		exit 2
		;;
esac
