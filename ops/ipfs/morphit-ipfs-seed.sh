#!/bin/sh
# morphit-ipfs-seed.sh — make THIS node the origin IPFS host for a release.
# (v1.9.3)
#
# Sibling to morphit-ipfs-pin.sh, but for the ORIGIN. The pin script FETCHES an
# already-network-available CID (`ipfs pin add`); this script HOSTS a release the
# network may not have yet, by reconstructing the exact release directory and
# `ipfs add`ing it. Naturally run on the release box (the first node to hold the
# files); every other instance then pins from it via morphit-ipfs-pin.sh.
#
# Determinism: the directory is built by ops/ipfs/stage-release-dir.sh — the SAME
# script CI uses for its `--only-hash` CID — so the CID produced here EQUALS the
# canonical `ipfs_cid` CI anchored on-chain. This script asserts that equality and
# fails loud on mismatch (belt-and-suspenders against a Kubo default change or a
# staging drift). Proven end-to-end in the spike: a VPS `ipfs add` resolved
# on ipfs.io + dweb.link.
#
# Usage:  morphit-ipfs-seed.sh <tag> [expected_cid]
#   e.g.  morphit-ipfs-seed.sh v1.9.3 bafybeibebk6sxb...
#   - <tag>          the release tag to seed (vX.Y.Z).
#   - [expected_cid] the CID this MUST produce (the tag's anchored ipfs_cid). If
#                    omitted, it is read from the TAG's published
#                    distribution-anchor.env (release.yml attaches it) — the
#                    tag-authoritative CID. NOT /v1/release, which serves the
#                    CURRENTLY broadcast release and would be the WRONG (older)
#                    CID when seeding a newer release pre-broadcast (e.g. from the
#                    morphit-ops upgrade). If the anchor has no CID yet, the
#                    script just adds + prints (no assertion).
# Env:
#   IPFS_PATH                 Kubo repo (default /var/lib/ipfs/.ipfs)
#   MORPHIT_SEED_HIDDEN_ONLY  =1 on a hidden-only node (morphit-ops upgrade sets it
#                             from indexer.env). Also inferred from Kubo's own
#                             Routing.Type=none. Then: no clearnet anchor fetch, no
#                             download, no DHT announce.
#   MORPHIT_RELEASE_DOWNLOAD_BASE   base URL for release assets (fetch the tag's anchor when expected_cid omitted)
#   IPFS_ADD_TIMEOUT          seconds for the add (default 900)
# Run as the ipfs service user (the systemd unit / morphit-ops handle that):
#   sudo -u ipfs env IPFS_PATH=/var/lib/ipfs/.ipfs morphit-ipfs-seed.sh v1.9.3 <cid>
# POSIX sh. Idempotent (re-adding the same bytes is a no-op → same CID).
set -eu

log() { echo "morphit-ipfs-seed: $*" >&2; }
# Each step is shown at a terminal (or with MORPHIT_SEED_VERBOSE=1); piped into
# `morphit-ops upgrade`, only results and problems are. The bare CID on stdout
# is part of the steps (since v1.21.1); the result line on stderr ("hosted …" or
# "✓ CID matches …") always names it.
if [ -t 2 ] || [ "${MORPHIT_SEED_VERBOSE:-}" = 1 ]; then SEED_VERBOSE=1; else SEED_VERBOSE=0; fi
export SEED_VERBOSE
step() { [ "$SEED_VERBOSE" = 1 ] && log "$@"; return 0; }

# Braille spinner shown on stderr while a background PID runs, so the operator
# is never left staring at a frozen terminal during a slow step. TTY-guarded
# (`[ -t 2 ]`) so piped/logged runs stay clean. POSIX sh: frames are iterated as
# space-separated words (each braille glyph is one word), no bash substrings.
# Usage:  <slow-cmd> &  _spin "$!" "message";  wait "$!"
_spin() {
	_sp_pid="$1"
	_sp_msg="$2"
	[ -t 2 ] || return 0
	while kill -0 "$_sp_pid" 2>/dev/null; do
		for _sp_f in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do
			kill -0 "$_sp_pid" 2>/dev/null || break
			printf '\r  %s %s' "$_sp_f" "$_sp_msg" >&2
			sleep 0.1
		done
	done
	printf '\r\033[K' >&2
}

TAG="${1:-}"
EXPECTED="${2:-}"
if [ -z "$TAG" ]; then
	echo "usage: morphit-ipfs-seed.sh <tag> [expected_cid]" >&2
	exit 2
fi
case "$TAG" in
	v[0-9]*.[0-9]*.[0-9]*) : ;;
	*) log "tag '$TAG' is not vX.Y.Z"; exit 2 ;;
esac

export IPFS_PATH="${IPFS_PATH:-/var/lib/ipfs/.ipfs}"
ADD_TIMEOUT="${IPFS_ADD_TIMEOUT:-900}"

command -v ipfs >/dev/null 2>&1 || { log "ipfs (Kubo) not installed — run morphit-ipfs-setup.sh first."; exit 1; }

# Locate the staging script next to this one.
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
STAGER="$HERE/stage-release-dir.sh"
[ -x "$STAGER" ] || [ -f "$STAGER" ] || { log "stage-release-dir.sh not found next to this script"; exit 1; }

# 1. Daemon reachable? (the add needs it; the timer/unit starts it.)
if ! ipfs --timeout=10s id >/dev/null 2>&1; then
	log "Kubo daemon not reachable (IPFS_PATH=$IPFS_PATH) — is ipfs.service up?"
	exit 1
fi

# 1b. HIDDEN-ONLY?
# A hidden-only node must not touch clearnet or the public IPFS network from its
# home IP. This script used to, three ways: it curled git.agorise.net for the
# tag's anchor whenever no CID was passed (and `morphit-ops upgrade` never passed
# one), the stager downloads the release from there when no local copy is given,
# and step 5 announced this box as a provider on the public DHT — a list anyone
# can read to collect the home IPs of Morphit nodes. The caller says so
# (MORPHIT_SEED_HIDDEN_ONLY=1, from indexer.env, which this unprivileged user
# cannot read), and Kubo's own config says so too once the hidden-only posture
# is applied (Routing.Type=none), which covers a hand-run seed.
HIDDEN_ONLY=no
case "${MORPHIT_SEED_HIDDEN_ONLY:-}" in
	1|yes|true) HIDDEN_ONLY=yes ;;
esac
if [ "$HIDDEN_ONLY" = no ] && [ "$(ipfs config Routing.Type 2>/dev/null || true)" = "none" ]; then
	HIDDEN_ONLY=yes
fi
if [ "$HIDDEN_ONLY" = yes ]; then
	log "hidden-only node: nothing is fetched from or announced to clearnet; peers get the release from this node over Tor/I2P."
	if [ -z "${MORPHIT_STAGE_TARBALL:-}" ] || [ ! -s "${MORPHIT_STAGE_TARBALL}" ]; then
		log "no local copy of $TAG was given (MORPHIT_STAGE_TARBALL), and a hidden-only node does not download"
		log "it over clearnet. Nothing to seed now; the next upgrade seeds the release it installs."
		exit 1
	fi
	if [ -z "$EXPECTED" ]; then
		log "no expected CID was given, so the CID is not cross-checked this time"
		log "(morphit-ops upgrade passes the on-chain one; a hand run can pass it as the 2nd argument)."
	fi
fi

# 2. If no expected CID was passed, read it from the TAG's published
#    distribution-anchor.env (release.yml attaches it) — the tag-authoritative
#    CID. NOT /v1/release, which serves the CURRENTLY broadcast release (the
#    WRONG, older CID when seeding a newer release pre-broadcast).
#    Never on a hidden-only node: that is a clearnet request from its home IP.
if [ -z "$EXPECTED" ] && [ "$HIDDEN_ONLY" = no ] && command -v curl >/dev/null 2>&1; then
	ANCHOR_URL="${MORPHIT_RELEASE_DOWNLOAD_BASE:-https://git.agorise.net/agorise/morphit/releases/download}/$TAG/distribution-anchor.env"
	ANCHOR="$(curl -fsS --max-time 20 "$ANCHOR_URL" 2>/dev/null || true)"
	EXPECTED="$(printf '%s' "$ANCHOR" \
		| sed -n 's/^[[:space:]]*export MORPHIT_BUILD_IPFS_CID=//p' \
		| tr -d '"' | head -n1)"
	[ -n "$EXPECTED" ] && step "expected CID from $TAG anchor: $EXPECTED"
fi

# 3. Reconstruct the canonical directory (SAME script CI hashed) + add it.
STAGE="$(mktemp -d)/morphit"
mkdir -p "$STAGE"
step "staging $TAG…"
sh "$STAGER" "$TAG" "$STAGE"

step "ipfs add (timeout ${ADD_TIMEOUT}s)…"
# Run in the background with a spinner so a slow add (large tree, busy daemon,
# or a Tor-routed box) never looks frozen. CID is captured via a temp file.
_cidfile="$(mktemp)"
ipfs --timeout="${ADD_TIMEOUT}s" add -rQ --cid-version 1 --chunker=size-262144 --raw-leaves "$STAGE" >"$_cidfile" 2>/dev/null &
_spin "$!" "hashing + storing $TAG into IPFS…"
wait "$!" 2>/dev/null || true
CID="$(cat "$_cidfile" 2>/dev/null | tr -d '[:space:]')"
rm -f "$_cidfile"
rm -rf "$(dirname "$STAGE")" 2>/dev/null || true
[ -n "$CID" ] || { log "ipfs add produced no CID"; exit 1; }
if [ -n "$EXPECTED" ]; then step "hosted $TAG → $CID"; else log "hosted $TAG → $CID"; fi

# 4. Determinism assertion — the produced CID MUST equal the anchored one.
if [ -n "$EXPECTED" ]; then
	if [ "$CID" != "$EXPECTED" ]; then
		log "✗ CID MISMATCH — produced $CID but the release anchors $EXPECTED."
		log "  Staging drifted or Kubo defaults changed. NOT the canonical bytes; refusing silently to seed a divergent CID."
		exit 1
	fi
	log "✓ CID matches the anchored ipfs_cid ($CID)."
fi

# 5. Announce it promptly so gateways + other instances can find it (best-effort).
# Not on a hidden-only node: a provider record on the
# public DHT names this box's home IP as a Morphit host. Its peers fetch the
# release by CID from its .onion/.b32.i2p gateway instead, which needs no DHT.
if [ "$HIDDEN_ONLY" = yes ]; then
	log "not announcing $CID to the public IPFS network (hidden-only node)."
else
	step "announcing to the network…"
	ipfs --timeout=60s routing provide "$CID" >/dev/null 2>&1 &
	_spin "$!" "announcing $CID to the DHT…"
	if wait "$!" 2>/dev/null; then
		step "announced $CID to the network."
	else
		log "routing provide did not complete (non-fatal) — the daemon reprovides on its own schedule."
	fi
fi

# 6. Self-verify we are a USABLE seeder — along the path a PEER actually uses.
# `ipfs add` only proves we PINNED it. The v1.17.1 check then curled the LOCAL
# gateway (127.0.0.1:8082) and announced "working seeder over every transport" —
# a FALSE ✓: on morphit.io that passed for weeks while UFW dropped the
# container-to-host connect, so the frontend returned 404 for every hidden
# request and morphitlat could not upgrade at all. So check the real hops:
#   (a) through the FRONTEND (what the .onion/.b32.i2p actually expose), and
#   (b) back over each configured hidden address, end to end.
CFG=/opt/morphit/morphit.config.env
# The OTHER config file. morphit.env is carried forward on every upgrade
# alongside morphit.config.env, and on all three live instances it is where the
# origin and the Tor/I2P addresses actually live — reading only morphit.config.env
# is why every box reported "no public origin" and "no hidden address" while
# plainly having both. The canary script searched here and found them; this did not.
ALTCFG=/opt/morphit/morphit.env
GW_PORT="$(ipfs config Addresses.Gateway 2>/dev/null | sed -n 's#.*/tcp/\([0-9]\{1,5\}\).*#\1#p' | head -1)" || true
[ -n "${GW_PORT:-}" ] || GW_PORT=8082
REL_PATH="/ipfs/${CID}/morphit-latest.tar.gz"
# Reachability probes use the SMALL sibling file in the same CID directory, not
# the ~33 MB tarball: identical nginx → gateway → kubo hop, but a Tor/I2P body
# fetch of the tarball routinely outruns a sane curl timeout and would report a
# healthy node as broken (the real upgrader allows 600s; we can't sit that long
# here). If metadata.json resolves end to end, so does the tarball beside it.
PROBE_PATH="/ipfs/${CID}/metadata.json"
# POSIX sh ONLY. `${@:3}` is a BASHISM: /bin/sh is dash on Ubuntu and dies with
# "Bad substitution" the first time this is called — which aborted this whole
# self-verify block (and the CID echo below it) on every real box in v1.17.2.
# And NEVER let curl's exit status escape: a refused/timed-out probe is exactly
# what we are here to diagnose, and under `set -e` a non-zero command
# substitution would kill the script before it could report anything.
_code() {
	_cu=$1
	_ct=${2:-45}
	shift 2
	curl -s -o /dev/null -w '%{http_code}' --max-time "$_ct" "$@" "$_cu" 2>/dev/null || true
}

# (a) Local gateway, then the FRONTEND — the hop peers actually traverse.
# BunkerWeb fronts the site with SERVER_NAME=<this instance's hostname> and
# MULTISITE=no, so a request addressed to 127.0.0.1 arrives with the WRONG
# SNI/Host and is 403'd on EVERY path — including on a perfectly healthy box.
# Probing that way would turn v1.17.1's false ✓ into an equally wrong false ✗
# for every operator at once. So pin the REAL hostname to the loopback address:
# correct SNI + Host, connection still never leaves the box.
_gw=$(_code "http://127.0.0.1:${GW_PORT}${PROBE_PATH}" 20)
# Origin, from the first source that actually has one. This USED to read a single
# key from a single file, and on both real instances that key is absent — so the
# frontend check silently skipped on the canonical clearnet box, the one place it
# matters most. MORPHIT_SEED_ORIGIN is resolved by the caller (upgrade.ts, running
# as root) and wins when present; the rest are fallbacks for a hand-run seed.
_host=""
_hostsrc=""
for _src in \
	"env:${MORPHIT_SEED_ORIGIN:-}" \
	"cfg:$(sed -n 's#^[[:space:]]*MORPHIT_INSTANCE_ORIGIN=[[:space:]]*##p' "$CFG" 2>/dev/null | tail -1)" \
	"alt:$(sed -n 's#^[[:space:]]*MORPHIT_INSTANCE_ORIGIN=[[:space:]]*##p' "$ALTCFG" 2>/dev/null | tail -1)" \
	"idx:$(sed -n 's#^[[:space:]]*MORPHIT_INDEXER_PUBLIC_ORIGIN=[[:space:]]*##p' /etc/morphit/indexer.env 2>/dev/null | tail -1)" \
	"alx:$(sed -n 's#^[[:space:]]*MORPHIT_INDEXER_PUBLIC_ORIGIN=[[:space:]]*##p' "$ALTCFG" 2>/dev/null | tail -1)" \
	"waf:$(sed -n 's#^[[:space:]]*SERVER_NAME=[[:space:]]*##p' /opt/morphit/ops/bunkerweb/bunkerweb.env 2>/dev/null | tail -1 | cut -d' ' -f1)"
do
	_tag=${_src%%:*}
	_val=${_src#*:}
	[ -n "$_val" ] || continue
	_val=$(printf '%s' "$_val" | sed -e 's#^"\(.*\)"$#\1#' -e "s#^'\(.*\)'\$#\1#" -e 's#^https\{0,1\}://##' -e 's#[/:].*$##')
	if [ -n "$_val" ]; then
		_host=$_val
		_hostsrc=$_tag
		break
	fi
done
# Initialise BEFORE the case below: this script runs under `set -u`, and the
# hidden-origin check reads $_fe. On a CLEARNET box the case does not match, so
# _fe stayed unset and the read aborted the whole seed step ("_fe: parameter not
# set") — after announcing the CID but before the Tor/I2P verification. The test
# that was supposed to cover this pre-set _fe itself, so it never saw the bug.
_fe=""

# A HIDDEN origin cannot be probed this way, and must not be reported as broken.
# This check dials 127.0.0.1:443 — the clearnet edge. A zero-clearnet box has no
# 443 listener at all; it serves through its Tor/I2P tunnels to a different local
# port. So on such a box the probe ALWAYS fails, and it reported "the FRONTEND
# does not serve this" about an instance whose .onion and .b32.i2p checks passed
# two lines later. The hidden checks below are authoritative for those boxes —
# they test the real peer path — so skip the clearnet probe rather than cry wolf.
case "$_host" in
	*.onion|*.b32.i2p|*.i2p|*.loki)
		_fe="skip-hidden"
		;;
esac
# Use a SEPARATE flag, not an emptied _host.
#
# Clearing _host to suppress the clearnet probe also tripped the pre-existing
# "no public origin found" branch, so a hidden-only box printed BOTH skip
# messages — the second telling a correctly-configured operator to set
# MORPHIT_INSTANCE_ORIGIN, which would be wrong for them. Overloading one
# variable as both a value and a signal is what caused it.
_fe_skip_hidden=0
if [ "$_fe" = "skip-hidden" ]; then
	log "• Frontend check skipped: this instance's origin is a hidden address ($_host),"
	log "  which is not reachable over the clearnet edge. The Tor/I2P checks below cover it."
	_fe=""
	_fe_skip_hidden=1
fi
if [ -n "$_host" ] && [ "$_fe_skip_hidden" = "0" ]; then
	_fe=$(_code "https://${_host}${PROBE_PATH}" 45 -k --resolve "${_host}:443:127.0.0.1")
	# BunkerWeb rate-limits (2 r/s); a 429 here is our own probing, not a fault.
	if [ "$_fe" = "429" ]; then
		sleep 3
		_fe=$(_code "https://${_host}${PROBE_PATH}" 45 -k --resolve "${_host}:443:127.0.0.1")
	fi
else
	_fe=""
fi

if [ "$_gw" != "200" ]; then
	log "⚠ WARNING: the local IPFS gateway is NOT serving $CID (127.0.0.1:${GW_PORT} → ${_gw:-none})."
	log "  Content is pinned but unreachable — this box is NOT a usable seeder."
elif [ "$_fe" = "200" ]; then
	log "✓ local gateway and the frontend both serve the release (clearnet path OK, host from ${_hostsrc})."
elif [ "$_fe_skip_hidden" = "1" ]; then
	: # already explained above — a hidden origin has no clearnet edge to probe
elif [ -z "$_fe" ]; then
	log "• Frontend check skipped: no public origin found (looked in MORPHIT_SEED_ORIGIN,"
	log "  MORPHIT_INSTANCE_ORIGIN in $CFG, MORPHIT_INDEXER_PUBLIC_ORIGIN in /etc/morphit/indexer.env,"
	log "  SERVER_NAME in /opt/morphit/ops/bunkerweb/bunkerweb.env)."
	log "  Set MORPHIT_INSTANCE_ORIGIN=https://<your-domain> in $CFG to enable this check."
	log "  The hidden checks below still prove the real peer path end to end."
elif [ "$_fe" = "403" ] || [ "$_fe" = "429" ]; then
	log "• Frontend check inconclusive (HTTP ${_fe}) — the edge refused our own local probe."
	log "  Not a seeding fault on its own; the hidden checks below are authoritative."
else
	log "⚠ WARNING: the gateway serves $CID but the FRONTEND does not (HTTP ${_fe:-timeout})."
	log "  Peers fetch through the frontend, so this box is NOT a usable seeder yet."
	log "  Usual cause: the firewall drops the container-to-host connect to ${GW_PORT}. Fix:"
	log "    sudo ufw allow from 172.20.0.0/16 to any port ${GW_PORT} proto tcp"
	log "  (morphit-ops upgrade now applies this automatically; run it again, or:"
	log "   sudo sh /opt/morphit/ops/ipfs/morphit-gateway-firewall-heal.sh)"
fi

# (b) End-to-end over each hidden address the operator actually advertises.
# Hidden addresses, widest net first. This script runs as the unprivileged `ipfs`
# user, and /var/lib/tor/<svc>/ is mode 700 owned by debian-tor — so the glob that
# used to be the only real source expanded to NOTHING and every instance reported
# "no hidden address configured" even with a live .onion. The caller resolves these
# as root and passes them down; the file reads remain as a hand-run fallback.
_onion="${MORPHIT_SEED_ONION:-}"
# NOTE: deliberately NOT /etc/morphit/indexer.env. That file holds
# MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS — other people's Blurt RPC onions — and
# grepping it would pick up a THIRD PARTY's address, probe it, and report
# "✓ Tor: the .onion serves the release" about a node that isn't ours.
[ -n "$_onion" ] || _onion=$(grep -hoE '[a-z2-7]{56}\.onion' "$CFG" "$ALTCFG" /var/lib/tor/*/hostname 2>/dev/null | head -1) || true
_i2p="${MORPHIT_SEED_I2P:-}"
# Read the ADDRESS KEY, not the first b32 anywhere in the file.
#
# A bare pattern grep with `head -1` takes whichever b32 appears first, which is
# only this instance's address if nothing else in the file has one. Hidden RPC
# endpoints, peer hints or a vanity-name comment can all carry someone else's
# b32 — and then the config/router check compares a STRANGER's address against
# the router's and cries wolf. That is exactly how the i2pd console scrape got
# this wrong, and the same mistake one file over.
#
# Key first (modern, then legacy), and only fall back to a bare pattern when no
# key is set at all.
if [ -z "$_i2p" ]; then
	for _k in MORPHIT_INSTANCE_I2P_B32_ADDRESS MORPHIT_INSTANCE_I2P_ADDRESS; do
		for _f in "$CFG" "$ALTCFG"; do
			[ -r "$_f" ] || continue
			_v=$(sed -n "s#^[[:space:]]*\(export *\)\{0,1\}${_k}[[:space:]]*=[[:space:]]*##p" "$_f" 2>/dev/null | tail -1) || true
			_v=$(printf '%s' "${_v:-}" | sed -e 's#^"\(.*\)"$#\1#' -e "s#^'\(.*\)'\$#\1#" -e 's#[[:space:]]*$##')
			case "${_v:-}" in
				*.b32.i2p) _i2p="$_v"; break ;;
			esac
		done
		[ -n "$_i2p" ] && break
	done
fi
# Last resort only: no key set anywhere.
[ -n "$_i2p" ] || _i2p=$(grep -hoE '[a-z2-7]{52}\.b32\.i2p' "$CFG" "$ALTCFG" 2>/dev/null | head -1) || true
# ── Does the config match what the ROUTER actually hosts? ────────────
# morphitlat advertised a .b32.i2p its own i2pd did not host: the tunnel key had
# been regenerated and the config never reconciled. Peers' I2P fetches to it
# failed for an unknown period, hidden by its .onion still working, and this very
# check blamed "slow tunnels" instead of saying the address was wrong. Tor and
# i2pd both publish the truth locally, so the mismatch is one comparison away.
_addr_mismatch=0
if [ -n "${MORPHIT_ROUTER_ONION:-}" ] && [ -n "${_onion:-}" ] && [ "$MORPHIT_ROUTER_ONION" != "$_onion" ]; then
	_addr_mismatch=1
	log "⚠ CONFIG/ROUTER MISMATCH — your .onion is advertised wrong."
	log "    config says : $_onion"
	log "    tor hosts   : $MORPHIT_ROUTER_ONION"
	log "  Peers use the ADVERTISED address, so they cannot reach this box over Tor."
	log "  Fix: set MORPHIT_INSTANCE_TOR_ADDRESS=$MORPHIT_ROUTER_ONION in $CFG,"
	log "  then re-publish: morphit-ops → 'Re-publish my registration on-chain'."
fi
if [ -n "${MORPHIT_ROUTER_I2P:-}" ] && [ -n "${_i2p:-}" ] && [ "$MORPHIT_ROUTER_I2P" != "$_i2p" ]; then
	_addr_mismatch=1
	log "⚠ CONFIG/ROUTER MISMATCH — your .b32.i2p is advertised wrong."
	log "    config says : $_i2p"
	log "    i2pd hosts  : $MORPHIT_ROUTER_I2P"
	log "  Peers use the ADVERTISED address, so they cannot reach this box over I2P."
	log "  Fix: set MORPHIT_INSTANCE_I2P_B32_ADDRESS=$MORPHIT_ROUTER_I2P in $CFG,"
	log "  then re-publish: morphit-ops → 'Re-publish my registration on-chain'."
fi
# Nothing configured, but the router IS hosting one? Say so — that address is
# useless to the federation until it is advertised.
if [ -z "${_onion:-}" ] && [ -n "${MORPHIT_ROUTER_ONION:-}" ]; then
	log "• Tor is hosting $MORPHIT_ROUTER_ONION but it is not in your config, so peers never learn it."
	_onion="$MORPHIT_ROUTER_ONION"
fi
if [ -z "${_i2p:-}" ] && [ -n "${MORPHIT_ROUTER_I2P:-}" ]; then
	log "• i2pd is hosting $MORPHIT_ROUTER_I2P but it is not in your config, so peers never learn it."
	_i2p="$MORPHIT_ROUTER_I2P"
fi

if [ -n "${_onion:-}" ]; then
	_sp=$(ss -lnt 2>/dev/null | grep -oE '127\.0\.0\.1:(9050|9150)' | head -1 | cut -d: -f2) || true
	[ -n "${_sp:-}" ] || _sp=9050
	_t=$(_code "http://${_onion}${PROBE_PATH}" 180 --socks5-hostname "127.0.0.1:${_sp}")
	[ "$_t" = "200" ] && log "✓ Tor: the .onion serves the release — hidden-only peers can upgrade from this box." \
		|| log "⚠ Tor: the .onion did NOT serve the release (HTTP ${_t:-timeout}) — hidden peers cannot fetch it here."
fi
if [ -n "${_i2p:-}" ]; then
	_i=$(_code "http://${_i2p}${PROBE_PATH}" 240 -x "http://127.0.0.1:4444")
	if [ "$_i" = "200" ]; then
		log "✓ I2P: the .b32.i2p serves the release — hidden-only peers can upgrade from this box."
	elif [ -z "${_i:-}" ] || [ "$_i" = "000" ]; then
		# No HTTP reply at all: the local proxy is unreachable or the tunnel has
		# not been built yet. THIS is the case that genuinely warrants patience.
		log "• I2P: no reply through the local i2pd proxy yet (tunnels take a few minutes to build after a restart)."
		log "  Re-check before treating it as broken: systemctl status i2pd"
	else
		# An HTTP status came BACK, so i2pd answered — the tunnel works and the
		# far end is the problem. Saying "tunnels are slow to warm up" here is
		# what talked an operator out of investigating a genuinely wrong address
		# for an unknown length of time. Do not explain away a real answer.
		log "⚠ I2P: i2pd replied HTTP ${_i} — the proxy works, so this is NOT a warm-up delay."
		if [ "$_addr_mismatch" = "1" ]; then
			log "  See the CONFIG/ROUTER MISMATCH above — that is almost certainly the cause."
		else
			log "  Check that $_i2p is the destination i2pd actually hosts:"
			log "    curl -s 'http://127.0.0.1:7070/?page=i2p_tunnels' | grep -o '[a-z2-7]\{52\}\.b32\.i2p'"
		fi
	fi
fi
if [ -z "${_onion:-}" ] && [ -z "${_i2p:-}" ]; then
	log "• No Tor/I2P address found in the config, so the hidden checks were skipped."
	log "  (If this box does have one it is simply not recorded in $CFG or $ALTCFG —"
	log "   peers may well reach it fine; only this self-check could not confirm it.)"
fi

[ "$SEED_VERBOSE" = 1 ] && echo "$CID"
if [ "$HIDDEN_ONLY" = yes ]; then
	step "done. Peers fetch it from this node's hidden addresses at /ipfs/$CID/morphit-latest.tar.gz"
else
	step "done. Resolve: https://ipfs.io/ipfs/$CID/metadata.json  |  ipns://<name>/morphit-latest.tar.gz"
fi
