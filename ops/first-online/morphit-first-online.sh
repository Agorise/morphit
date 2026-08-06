#!/bin/sh
# morphit-first-online.sh
#
# Runs the network-dependent TAIL of the install the first time this box sees a
# REAL internet connection, then retires itself.  This is what lets a Morphit
# node be installed completely offline — in an area with terrible or intermittent
# connectivity — and still finish itself the moment a link appears, with no human
# present.
#
# It is driven two ways, belt-and-braces, because connectivity is unpredictable:
#   • morphit-first-online.service  — fires on network-online.target (boot / link-up)
#   • morphit-first-online.timer    — retries every few minutes forever
# so it does not matter whether the internet is there at boot, arrives an hour
# later, or flaps in and out.
#
# Every step is IDEMPOTENT and checks its own done-marker plus real on-disk /
# on-chain state, so re-runs only do what is still outstanding.  When every
# outstanding step is resolved it disables its own timer and stops costing
# anything.  A step that can't finish yet (domain not resolving, relay
# underfunded) simply leaves its marker unset and is retried next tick.
#
# Paranoid by design: the "are we online?" gate is a REAL reachability probe
# against several independent Blurt RPC endpoints — never a single host, never
# mere link-up — so a censored or dead endpoint can't fool it either way.

set -eu

STATE_DIR="${MORPHIT_FIRST_ONLINE_STATE_DIR:-/var/lib/morphit/first-online}"
DONE_TLS="${STATE_DIR}/tls.done"
DONE_REGISTER="${STATE_DIR}/register.done"
DONE_RPC="${STATE_DIR}/rpc.done"
ENV_FILE="${MORPHIT_FIRST_ONLINE_ENV:-/etc/morphit/first-online.env}"
RELAY_ENV="${MORPHIT_FIRST_ONLINE_RELAY_ENV:-/etc/morphit/relay.env}"
INDEXER_ENV="${MORPHIT_FIRST_ONLINE_INDEXER_ENV:-/etc/morphit/indexer.env}"
LOG_TAG=morphit-first-online

# Baked fallback list — used only if the indexer env carries none.  Keep in sync
# with DEFAULT_BLURT_RPC_ENDPOINTS / group_vars morphit_indexer_blurt_rpc_endpoints.
FALLBACK_RPC='https://rpc.drakernoise.com https://blurtrpc.dagobert.uk https://rpc.blurt.blog https://rpc.beblurt.com https://rpc.blurt.one https://blurt-rpc.saboin.com'

mkdir -p "${STATE_DIR}"

log() { logger -t "${LOG_TAG}" -- "$*" 2>/dev/null || true; printf '[%s] %s\n' "${LOG_TAG}" "$*"; }

# ── Config (best-effort; a missing var must never abort the script) ──
# shellcheck disable=SC1090
[ -f "${ENV_FILE}" ] && . "${ENV_FILE}"
MORPHIT_DOMAIN="${MORPHIT_DOMAIN:-}"
MORPHIT_ACME_EMAIL="${MORPHIT_ACME_EMAIL:-}"
MORPHIT_AUTO_REGISTER="${MORPHIT_AUTO_REGISTER:-no}"
MORPHIT_TLS_STAGING="${MORPHIT_TLS_STAGING:-no}"
MORPHIT_OPS_DIR="${MORPHIT_OPS_DIR:-/opt/morphit}"

# RPC endpoints for the reachability probe: prefer the operator's configured
# list, fall back to the baked defaults.
rpc_endpoints() {
	eps=''
	if [ -f "${INDEXER_ENV}" ]; then
		# read the var in a subshell so we don't pollute our own env
		eps="$( (. "${INDEXER_ENV}" 2>/dev/null; printf '%s' "${MORPHIT_INDEXER_BLURT_RPC_ENDPOINTS:-}") )"
	fi
	if [ -n "${eps}" ]; then
		printf '%s' "${eps}" | tr ',' ' '
	else
		printf '%s' "${FALLBACK_RPC}"
	fi
}

# The internet GATE — real reachability, not link state.  Succeeds the moment
# ANY Blurt RPC answers a cheap chain call.  Tries them all before giving up.
check_online() {
	for ep in $(rpc_endpoints); do
		if curl -fsS --max-time 8 -o /dev/null \
			-H 'content-type: application/json' \
			--data '{"jsonrpc":"2.0","method":"condenser_api.get_dynamic_global_properties","params":[],"id":1}' \
			"${ep}" 2>/dev/null; then
			log "reachable: ${ep}"
			return 0
		fi
	done
	return 1
}

# Is every outstanding step resolved? (A step that does not apply counts as done.)
all_done() {
	_tls=no
	if [ -z "${MORPHIT_DOMAIN}" ] || [ -f "${DONE_TLS}" ] \
		|| [ -f "/etc/letsencrypt/live/${MORPHIT_DOMAIN}/fullchain.pem" ]; then _tls=yes; fi
	_reg=no
	if [ "${MORPHIT_AUTO_REGISTER}" != "yes" ] || [ -f "${DONE_REGISTER}" ]; then _reg=yes; fi
	_rpc=no
	if [ -f "${DONE_RPC}" ]; then _rpc=yes; fi
	[ "${_tls}" = yes ] && [ "${_reg}" = yes ] && [ "${_rpc}" = yes ]
}

retire_if_complete() {
	if all_done; then
		log 'all deferred steps complete — retiring morphit-first-online.timer'
		systemctl disable --now morphit-first-online.timer >/dev/null 2>&1 || true
	fi
}

# ── Fast path: nothing left to do → retire and exit. ──
if all_done; then
	log 'nothing outstanding — retiring'
	systemctl disable --now morphit-first-online.timer >/dev/null 2>&1 || true
	exit 0
fi

# ── Gate on real connectivity. ──
if ! check_online; then
	log 'no internet yet — will retry on the next tick / network-online event'
	exit 0
fi
log 'internet detected — running outstanding deferred completion steps'

# ── Step 0: restore normal apt (offline-appliance install only). ──
# An offline install redirected apt to the bundled local repo via an apt.conf.d
# override.  Now that we are online, remove it so the operator gets normal
# package updates again.  Idempotent: a no-op if the override isn't there.
if [ -f /etc/apt/apt.conf.d/99-morphit-offline.conf ]; then
	log 'restoring normal apt (removing the offline local-repo override)'
	rm -f /etc/apt/apt.conf.d/99-morphit-offline.conf
	apt-get update >/dev/null 2>&1 || true
fi

# ── Step 1: TLS — obtain the real Let's Encrypt certificate. ──
# Until now the site has been served on BunkerWeb's self-signed fallback (fine on
# a LAN).  certbot writes the real cert and its deploy-hook reloads BunkerWeb.
if [ -n "${MORPHIT_DOMAIN}" ] && [ ! -f "/etc/letsencrypt/live/${MORPHIT_DOMAIN}/fullchain.pem" ]; then
	_server='https://acme-v02.api.letsencrypt.org/directory'
	[ "${MORPHIT_TLS_STAGING}" = yes ] && _server='https://acme-staging-v02.api.letsencrypt.org/directory'
	log "requesting Let's Encrypt certificate for ${MORPHIT_DOMAIN}"
	if certbot certonly --standalone --non-interactive --agree-tos \
		--email "${MORPHIT_ACME_EMAIL}" --server "${_server}" -d "${MORPHIT_DOMAIN}" >/dev/null 2>&1 \
		&& [ -f "/etc/letsencrypt/live/${MORPHIT_DOMAIN}/fullchain.pem" ]; then
		log 'certificate obtained — reloading BunkerWeb'
		docker exec bunkerweb sh -c 'kill -HUP 1' >/dev/null 2>&1 || true
		touch "${DONE_TLS}"
	else
		log 'certbot not successful yet (domain may not resolve to this box) — will retry'
	fi
fi

# ── Step 2: RPC — nudge the indexer + relay to connect promptly. ──
# They retry on their own, but a restart the first time we are online makes them
# pick up the new link immediately instead of waiting out a backoff.
if [ ! -f "${DONE_RPC}" ]; then
	systemctl restart morphit-indexer.service >/dev/null 2>&1 || true
	systemctl restart morphit-relay.service   >/dev/null 2>&1 || true
	log 'nudged indexer + relay to connect to Blurt RPC'
	touch "${DONE_RPC}"
fi

# ── Step 3: on-chain registration (opt-in only). ──
# Idempotent: `register --non-interactive` no-ops if the account is already
# registered, and reads the relay key + passphrase exactly the way the relay
# service does (so no human need be present).  If the relay is underfunded or the
# key/passphrase isn't available unattended, it fails softly and we retry.
if [ "${MORPHIT_AUTO_REGISTER}" = "yes" ] && [ ! -f "${DONE_REGISTER}" ]; then
	log 'auto-registering this instance on chain (operator opted in)'
	# Source the relay env so MORPHIT_RELAY_* (key file + passphrase file) are set
	# the same as the relay unit sees them.
	# shellcheck disable=SC1090
	_reg_ok=no
	if ( [ -f "${RELAY_ENV}" ] && . "${RELAY_ENV}"; \
		cd "${MORPHIT_OPS_DIR}" && \
		npm exec --offline --workspace apps/ops-cli morphit-ops -- register --non-interactive ) >/dev/null 2>&1; then
		_reg_ok=yes
	fi
	if [ "${_reg_ok}" = yes ]; then
		log 'on-chain registration complete'
		touch "${DONE_REGISTER}"
	else
		log 'registration not complete yet (relay underfunded, or key/passphrase not available unattended) — will retry'
	fi
fi

retire_if_complete
exit 0
