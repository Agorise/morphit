#!/bin/sh
# morphit-tor-egress.sh — on a TOR-ONLY node, nothing but Tor and i2pd may
# reach the internet, and the OS jobs that would try are switched off.
#
# WHY. A tor-only node's own services reach the chain only over Tor and I2P,
# and the OS around them was moved off clearnet piece by piece (apt over Tor,
# no NTP, no news fetches: morphit-tor-only-os.sh). That is a promise kept by
# configuration, one program at a time: snapd, fwupd, pollinate, Ubuntu Pro's
# timer, i2pd's reseed and anything installed later still went out directly.
# This makes the promise a rule the kernel enforces: an allowlist on outgoing
# traffic by the PROGRAM'S USER (nftables `meta skuid`).
#
# WHAT (one list, shared by the Ansible tor role and `morphit-ops upgrade`):
#   egress  table inet morphit_egress, loaded at boot before the network by
#           morphit-tor-egress.service from /etc/morphit/tor-egress.nft.
#           Leaving the box is allowed only for: the Tor daemon's user
#           (debian-tor) and i2pd's user (i2pd, whose I2P router talks to
#           other routers directly — that is how I2P works); replies on
#           connections that came in (SSH, the hidden services); loopback and
#           the Docker bridges (local); DHCP, IPv6 neighbour discovery and
#           link-local (the box keeps its address); and the LOCAL NETWORK —
#           RFC 1918 (10/8, 172.16/12, 192.168/16) and IPv6 ULA (fc00::/7) —
#           because zero-clearnet means no INTERNET, and Morphit's own
#           hidden-only policy treats those addresses as local too (a LAN
#           homeserver or peer given as an IP literal; a NAS, a printer, your
#           own laptop). DNS (TCP and UDP port 53, and DNS-over-TLS 853) is
#           refused to EVERY address but loopback, IPv4 and IPv6, from every
#           user — Tor and i2pd included — and from containers: the LAN,
#           link-local (a router advertises its fe80:: or 169.254 address as
#           the resolver) and the internet alike. Any resolver off the box
#           forwards the names it is asked to the internet, and nothing on a
#           tor-only node needs one: Tor resolves names at its exit, and i2pd
#           hands its reseed host name to Tor's SOCKS port. A resolver on
#           loopback (systemd-resolved's 127.0.0.53) is still asked, and has
#           nowhere to send the question. A LAN host that relays to the
#           internet for you (a proxy you set up) would carry traffic out;
#           that is yours to avoid. Everything else — including root — is
#           refused at once (so a program fails fast instead of hanging) and
#           counted. Containers are held to the same rule (forwarded traffic
#           may stay on the bridges or reach private networks only). apt,
#           Docker pulls, the indexer and the relay all go THROUGH Tor's
#           SocksPort on 127.0.0.1.
#   units   snapd, fwupd's metadata refresh, pollinate and Ubuntu Pro's timer
#           are masked (each would otherwise just fail against the rule).
#   i2pd    its reseed (the first download of router addresses) goes through
#           Tor: reseed.proxy = socks://<SocksPort> in /etc/i2pd/i2pd.conf.
#   docker  the Docker daemon pulls images through Tor (a systemd drop-in
#           setting its proxy to socks5://<SocksPort>).
#
# Usage:  morphit-tor-egress.sh <mode> [backup-dir]
#   render                 print the nft ruleset for this box (stdout)
#   egress-check           0 when the live table is this box's ruleset
#   egress-apply <dir>     write /etc/morphit/tor-egress.nft (+ the unit is the
#                          caller's), load it; backups into <dir>
#   egress-revert <dir>    delete the table, put the file back
#   egress-probe           as user nobody, try to reach 192.0.2.1:9 (a
#                          documentation address, never routed); 0 when the
#                          rule refused it (its counter rose), 1 when not
#   units-check | units-apply <dir> | units-revert <dir>
#   quiet-check | quiet-apply <dir> | quiet-revert <dir>
#                          the same for the units EVERY node turns off (a
#                          clearnet one too): fwupd's daily firmware-metadata
#                          fetch (cdn.fwupd.org) and pollinate's boot-time
#                          fetch from entropy.ubuntu.com. Neither is needed
#                          on a server; snapd and Ubuntu Pro's timer stay on
#                          a clearnet node (installed snaps and an attached
#                          Pro subscription need them).
#   i2pd-check  | i2pd-apply <dir>  | i2pd-revert <dir>
#   docker-check | docker-apply <dir> | docker-revert <dir>
#       *-check: 0 = already so, 1 = not (reason printed), 2 = usage.
# Env:
#   MORPHIT_TOR_SOCKS  Tor's SocksPort as <IPv4>:<port> (default 127.0.0.1:9050)
#   MORPHIT_OS_ROOT    prefix for every path (tests only; empty on a real box)
#   MORPHIT_NFT, MORPHIT_SYSTEMCTL, MORPHIT_RUNUSER  the binaries (tests only)
#   MORPHIT_EGRESS_UIDS  the allowed uids, comma-separated (tests only;
#                      default: those of debian-tor and i2pd)
# POSIX sh. Must run as root on a real box. Never resolves a name.
set -u

R="${MORPHIT_OS_ROOT:-}"
SOCKS="${MORPHIT_TOR_SOCKS:-127.0.0.1:9050}"
NFT="${MORPHIT_NFT:-nft}"
SYSTEMCTL="${MORPHIT_SYSTEMCTL:-systemctl}"
RUNUSER="${MORPHIT_RUNUSER:-runuser}"
MODE="${1:-}"
BK="${2:-}"
NFT_FILE="$R/etc/morphit/tor-egress.nft"
I2PD_CONF="$R/etc/i2pd/i2pd.conf"
DOCKER_DROPIN="$R/etc/systemd/system/docker.service.d/morphit-tor-proxy.conf"
UNITS="snapd.service snapd.socket snapd.seeded.service fwupd-refresh.timer fwupd-refresh.service pollinate.service ua-timer.timer ua-timer.service"
QUIET_UNITS="fwupd-refresh.timer fwupd-refresh.service pollinate.service"

log() { printf 'morphit-tor-egress: %s\n' "$*" >&2; }

case "$SOCKS" in
	*[!0-9.:]* | '' | :* | *:) log "MORPHIT_TOR_SOCKS must be <IPv4>:<port>, got '$SOCKS'"; exit 2 ;;
esac

# ── backup / revert (same contract as morphit-tor-only-os.sh) ───────────────
need_bk() {
	[ -n "$BK" ] || { log "$MODE needs a backup directory"; exit 2; }
	mkdir -p "$BK/files" || { log "cannot create backup directory $BK"; exit 3; }
	touch "$BK/created"
}
bk() {
	if [ -e "$BK/files$1" ] || grep -qxF -- "$1" "$BK/created"; then return 0; fi
	if [ -e "$1" ]; then
		mkdir -p "$BK/files$(dirname -- "$1")" && cp -a -- "$1" "$BK/files$1" || { log "could not back up $1 — changing nothing"; exit 3; }
	else
		printf '%s\n' "$1" >>"$BK/created"
	fi
}
restore() {
	[ -n "$BK" ] && [ -d "$BK/files" ] || { log "no backup at '$BK' — nothing to revert"; return 1; }
	for p in "$@"; do
		if [ -e "$BK/files$p" ]; then
			cp -a -- "$BK/files$p" "$p" || return 1
		elif grep -qxF -- "$p" "$BK/created" 2>/dev/null; then
			rm -f -- "$p"
		fi
	done
}
put() { # put <file> <mode>: stdin → file, only when different
	tmp="$(mktemp)" || return 1
	cat >"$tmp"
	if [ -f "$1" ] && cmp -s -- "$tmp" "$1"; then rm -f -- "$tmp"; return 0; fi
	bk "$1"
	mkdir -p "$(dirname -- "$1")"
	install -m "$2" -- "$tmp" "$1" && rm -f -- "$tmp" && log "wrote $1"
}

# ── egress ───────────────────────────────────────────────────────────────────
uid_of() { id -u "$1" 2>/dev/null; }

render() {
	allowed="${MORPHIT_EGRESS_UIDS:-}"
	if [ -z "$allowed" ]; then
		for u in debian-tor i2pd; do
			n="$(uid_of "$u")" && allowed="${allowed:+$allowed, }$n"
		done
	fi
	[ -n "$allowed" ] || { log 'neither debian-tor nor i2pd exists: refusing to block everything'; return 1; }
	cat <<EOF
# Managed by Morphit (ops/tor-only/morphit-tor-egress.sh) — a tor-only node:
# only Tor (debian-tor) and i2pd may reach the internet; the local network
# (RFC 1918, ULA, link-local) stays reachable; DNS goes nowhere but loopback.
add table inet morphit_egress
flush table inet morphit_egress
table inet morphit_egress {
	counter blocked {
	}
	chain output {
		type filter hook output priority filter; policy accept;
		oifname "lo" accept
		ct state established,related accept
		meta l4proto { tcp, udp } th dport { 53, 853 } counter name "blocked" reject with icmpx admin-prohibited
		meta skuid { $allowed } accept
		oifname "docker0" accept
		oifname "br-*" accept
		oifname "veth*" accept
		ip daddr 169.254.0.0/16 accept
		ip6 daddr fe80::/10 accept
		ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } accept
		ip6 daddr fc00::/7 accept
		udp dport { 67, 547 } accept
		icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert, mld2-listener-report } accept
		counter name "blocked" reject with icmpx admin-prohibited
	}
	chain forward {
		type filter hook forward priority filter; policy accept;
		ct state established,related accept
		meta l4proto { tcp, udp } th dport { 53, 853 } counter name "blocked" reject with icmpx admin-prohibited
		ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } accept
		ip6 daddr { fc00::/7, fe80::/10 } accept
		iifname "docker0" counter name "blocked" reject with icmpx admin-prohibited
		iifname "br-*" counter name "blocked" reject with icmpx admin-prohibited
	}
}
EOF
}

# The live table, normalised (counter values and handles dropped).
live_rules() { "$NFT" list table inet morphit_egress 2>/dev/null | sed -e 's/packets [0-9]* bytes [0-9]*//' -e 's/ *# handle [0-9]*//'; }

egress_check() {
	[ -f "$NFT_FILE" ] || { log "$NFT_FILE is missing"; return 1; }
	want="$(render)" || return 1
	printf '%s\n' "$want" | cmp -s - "$NFT_FILE" || { log "$NFT_FILE differs from this box's ruleset"; return 1; }
	live_rules | grep -q 'meta skuid' || { log 'the morphit_egress table is not loaded'; return 1; }
	live_rules | grep -q 'counter name "blocked" reject' || { log 'the morphit_egress table has no blocking rule'; return 1; }
	return 0
}

counter_packets() { "$NFT" list counter inet morphit_egress blocked 2>/dev/null | sed -n 's/.*packets \([0-9]*\).*/\1/p' | head -n 1; }

egress_probe() {
	before="$(counter_packets)"
	[ -n "$before" ] || { log 'no morphit_egress counter: the rule is not loaded'; return 1; }
	# As an unprivileged user, open a TCP connection to a documentation-only
	# address; the rule must refuse the very first packet.
	"$RUNUSER" -u nobody -- sh -c 'exec timeout 5 bash -c "exec 3<>/dev/tcp/192.0.2.1/9" ' >/dev/null 2>&1
	after="$(counter_packets)"
	if [ -n "$after" ] && [ "$after" -gt "$before" ]; then
		log "a connection attempt by user nobody was refused by the rule (counter $before -> $after)"
		return 0
	fi
	log "the rule did not see the probe (counter $before -> ${after:-?})"
	return 1
}

# ── units ────────────────────────────────────────────────────────────────────
present_units() { for u in $UNITS; do "$SYSTEMCTL" cat "$u" >/dev/null 2>&1 && printf '%s\n' "$u"; done; }
units_check() {
	bad=0
	for u in $(present_units); do
		s="$("$SYSTEMCTL" is-enabled "$u" 2>/dev/null)"
		[ "$s" = masked ] || { log "$u is $s, not masked"; bad=1; }
	done
	return "$bad"
}
units_apply() {
	need_bk
	for u in $(present_units); do
		s="$("$SYSTEMCTL" is-enabled "$u" 2>/dev/null)"
		[ "$s" = masked ] && continue
		grep -qxF -- "$u" "$BK/masked" 2>/dev/null || printf '%s\n' "$u" >>"$BK/masked"
		"$SYSTEMCTL" stop "$u" >/dev/null 2>&1
		"$SYSTEMCTL" mask "$u" >/dev/null 2>&1 && log "masked $u"
	done
	return 0
}
units_revert() {
	[ -f "$BK/masked" ] || return 0
	while IFS= read -r u; do [ -n "$u" ] && "$SYSTEMCTL" unmask "$u" >/dev/null 2>&1; done <"$BK/masked"
}

# ── i2pd reseed through Tor ──────────────────────────────────────────────────
# The [reseed] section's `proxy` key (i2pd.conf is INI; a key before any
# section header is global, so the value is written inside [reseed]).
i2pd_reseed_proxy() { awk -F'=' '/^[ \t]*\[/{s=$0; gsub(/[ \t\[\]]/,"",s); next} s=="reseed" && $1 ~ /^[ \t]*proxy[ \t]*$/ {v=$2; gsub(/^[ \t]+|[ \t]+$/,"",v); print v}' "$I2PD_CONF" 2>/dev/null | tail -n 1; }
i2pd_check() {
	[ -f "$I2PD_CONF" ] || { log "no $I2PD_CONF (i2pd not installed): nothing to do"; return 0; }
	[ "$(i2pd_reseed_proxy)" = "socks://$SOCKS" ] || { log "i2pd reseeds directly (reseed.proxy is '$(i2pd_reseed_proxy)')"; return 1; }
}
i2pd_apply() {
	need_bk
	[ -f "$I2PD_CONF" ] || return 0
	awk -v want="proxy = socks://$SOCKS" '
		/^[ \t]*\[/ { if (sec == "reseed" && !done) { print want; done = 1 } s = $0; gsub(/[ \t\[\]]/, "", s); sec = s; print; next }
		sec == "reseed" && $0 ~ /^[ \t]*#*[ \t]*proxy[ \t]*=/ { if (!done) { print want; done = 1 } next }
		{ print }
		END { if (sec == "reseed" && !done) { print want; done = 1 } if (!done) { print ""; print "[reseed]"; print want } }
	' "$I2PD_CONF" | put "$I2PD_CONF" 0644
}

# ── Docker pulls through Tor ─────────────────────────────────────────────────
docker_dropin() {
	cat <<EOF
# Managed by Morphit (ops/tor-only/morphit-tor-egress.sh): on a tor-only node
# the Docker daemon pulls images through Tor, never directly.
[Service]
Environment="HTTP_PROXY=socks5://$SOCKS" "HTTPS_PROXY=socks5://$SOCKS" "NO_PROXY=localhost,127.0.0.0/8,::1"
EOF
}
# Written even before Docker is installed, so its very first pull goes
# through Tor.
docker_check() {
	docker_dropin | cmp -s - "$DOCKER_DROPIN" || { log "Docker would pull directly ($DOCKER_DROPIN missing or different)"; return 1; }
}

case "$MODE" in
	render) render ;;
	egress-check) egress_check ;;
	egress-apply)
		need_bk
		want="$(render)" || exit 1
		printf '%s\n' "$want" | put "$NFT_FILE" 0644 || exit 3
		"$NFT" -f "$NFT_FILE" || { log "nft refused $NFT_FILE"; exit 1; }
		;;
	egress-revert)
		"$NFT" delete table inet morphit_egress >/dev/null 2>&1
		restore "$NFT_FILE"
		;;
	egress-probe) egress_probe ;;
	quiet-check) UNITS="$QUIET_UNITS" units_check ;;
	quiet-apply) UNITS="$QUIET_UNITS" units_apply ;;
	quiet-revert) units_revert ;;
	units-check) units_check ;;
	units-apply) units_apply ;;
	units-revert) units_revert ;;
	i2pd-check) i2pd_check ;;
	i2pd-apply) i2pd_apply ;;
	i2pd-revert) restore "$I2PD_CONF" ;;
	docker-check) docker_check ;;
	docker-apply)
		need_bk
		docker_dropin | put "$DOCKER_DROPIN" 0644
		;;
	docker-revert) restore "$DOCKER_DROPIN" ;;
	*) log "usage: $0 render|egress-check|egress-apply <dir>|egress-revert <dir>|egress-probe|units-…|i2pd-…|docker-…"; exit 2 ;;
esac
