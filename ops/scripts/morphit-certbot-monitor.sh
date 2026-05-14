#!/bin/sh
# morphit-certbot-monitor.sh — TLS cert expiry + renewal-failure
#
# Two related concerns:
#   1. Cert expiry — fires if any cert expires soon.  This is
#      what most "renewal monitoring" actually does.
#   2. Renewal failure — fires if the cert is expiring AND
#      certbot's renew log shows no successful run recently.
#      This is the gap most monitoring misses: a cert renewing
#      fine 6 months ago can silently start failing for weeks
#      before it actually expires.
#
# Module name: "certbot".  Event names:
#   cert_expiry_critical          — CRITICAL: < 7 days to expiry
#   cert_expiry_warn              — WARN:     < 30 days to expiry
#   renewal_stalled               — CRITICAL: cert expiring AND
#                                   no successful renewal in last 14d
#   certbot_unavailable           — INFO:     certbot not installed
#
# Cadence: daily via systemd timer (twice-daily on Let's
# Encrypt's default, but daily is sufficient — renewal failures
# need to be caught with days of headroom, not hours).
#
# Requires: certbot installed, /etc/letsencrypt/live/ populated.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
EXPIRY_CRITICAL_DAYS=${MORPHIT_CERTBOT_EXPIRY_CRITICAL_DAYS:-7}
EXPIRY_WARN_DAYS=${MORPHIT_CERTBOT_EXPIRY_WARN_DAYS:-30}
# How long without a successful renewal counts as stalled, in days.
RENEWAL_STALL_DAYS=${MORPHIT_CERTBOT_RENEWAL_STALL_DAYS:-14}

CERT_DIR=${MORPHIT_CERTBOT_CERT_DIR:-/etc/letsencrypt/live}
RENEW_LOG=${MORPHIT_CERTBOT_RENEW_LOG:-/var/log/letsencrypt/letsencrypt.log}

# ─── Emit helper ───────────────────────────────────────────────
iso_now() {
    date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

emit() {
    ts=$(iso_now)
    payload=${3:-'{}'}
    printf '{"ts":"%s","level":"%s","module":"certbot","event":"%s","context":%s}\n' \
           "$ts" "$1" "$2" "$payload" \
        | systemd-cat -t morphit-certbot-monitor -p "$1"
}

json_str() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ─── Bail if certbot / cert dir missing ────────────────────────
if ! command -v openssl >/dev/null 2>&1; then
    emit info certbot_unavailable \
         '{"hint":"openssl required to read cert expiry; install via apt"}'
    exit 0
fi
if [ ! -d "$CERT_DIR" ]; then
    emit info certbot_unavailable \
         '{"hint":"cert dir not found; install certbot and run an initial issuance"}'
    exit 0
fi

# ─── Last successful renewal age (one-shot for all certs) ──────
last_success_age_days=999
if [ -r "$RENEW_LOG" ]; then
    # Look for the most recent "Congratulations" or "Renewal
    # was successful" line.  Format includes a date prefix like
    # "2026-04-30 04:00:13" at the start of relevant lines.
    last_success_line=$(grep -E 'Congratulations|Renewal was successful' "$RENEW_LOG" 2>/dev/null \
                         | tail -1 || true)
    if [ -n "$last_success_line" ]; then
        # Extract a YYYY-MM-DD prefix.
        date_str=$(echo "$last_success_line" \
                    | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' \
                    | head -1)
        if [ -n "$date_str" ]; then
            last_epoch=$(date -d "$date_str" +%s 2>/dev/null || echo 0)
            now_epoch=$(date +%s)
            last_success_age_days=$(( (now_epoch - last_epoch) / 86400 ))
        fi
    fi
fi

# ─── Iterate each live cert ────────────────────────────────────
found_any=0
for cert_path in "$CERT_DIR"/*/cert.pem; do
    [ -f "$cert_path" ] || continue
    found_any=1
    cert_name=$(basename "$(dirname "$cert_path")")

    # `openssl x509 -enddate` gives "notAfter=Jul 16 12:00:00 2026 GMT"
    end_date=$(openssl x509 -in "$cert_path" -noout -enddate 2>/dev/null \
                 | sed 's/^notAfter=//')
    [ -z "$end_date" ] && continue

    end_epoch=$(date -d "$end_date" +%s 2>/dev/null || echo 0)
    now_epoch=$(date +%s)
    days_left=$(( (end_epoch - now_epoch) / 86400 ))

    payload='{"cert":"'$(json_str "$cert_name")'","days_left":'$days_left',"last_renewal_success_age_days":'$last_success_age_days

    if [ "$days_left" -le "$EXPIRY_CRITICAL_DAYS" ] 2>/dev/null; then
        # Check renewal-stalled: cert is about to expire AND
        # the most recent successful renewal was a long time
        # ago.  This is the killer pattern.
        if [ "$last_success_age_days" -ge "$RENEWAL_STALL_DAYS" ] 2>/dev/null; then
            emit error renewal_stalled "${payload},\"stall_threshold_days\":${RENEWAL_STALL_DAYS}}"
        else
            emit error cert_expiry_critical "${payload},\"threshold_days\":${EXPIRY_CRITICAL_DAYS}}"
        fi
    elif [ "$days_left" -le "$EXPIRY_WARN_DAYS" ] 2>/dev/null; then
        emit warn cert_expiry_warn "${payload},\"threshold_days\":${EXPIRY_WARN_DAYS}}"
    fi
    # else: comfortably in the future, nothing to alert
done

# Emit nothing if no certs found (don't spam INFO on hosts
# that haven't run certbot yet — operators see the absence in
# their own setup).
[ "$found_any" = 0 ] && exit 0

exit 0
