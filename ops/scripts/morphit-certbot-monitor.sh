#!/bin/sh
# morphit-certbot-monitor.sh — TLS certificate renewal watch
#
# certbot renews on its own: its timer runs twice a day and renews a
# certificate once it is due — certbot 2.x (Ubuntu 24.04 ships 2.9) when
# fewer than 30 days are left, certbot 4+ when a third of its lifetime is left
# (or when Let's Encrypt's renewal window says so) — 30 days for Let's
# Encrypt's 90-day certificates either way.  So a certificate with 30 days
# left is NORMAL: certbot has not even tried yet.  This monitor speaks when a
# renewal is OVERDUE — due for a while and still not done — which is the one
# thing worth an alert: the renewal broke (DNS, port 80, firewall, rate limit,
# a stopped timer).  And whatever the settings, it is CRITICAL with a day left
# and once the certificate has expired.
#
# v1.23.4: it used to warn at 30 days left — the day before certbot is due, on
# every certificate, every cycle — and read the last renewal from
# /var/log/letsencrypt/letsencrypt.log, which certbot starts afresh on every
# run (log.py: "rotate on each invocation"), so it reported 999 days unless the
# newest run happened to be the renewal itself.  Now the certificate itself
# says when it was issued (notBefore) and when it expires (notAfter).
#
# Module name: "certbot".  Event names:
#   cert_expiry_warn     — WARN:     renewal overdue by the grace days
#                                    (23 days left on a 90-day certificate)
#   renewal_stalled      — CRITICAL: ≤ 7 days left and overdue, a day left,
#                                    or expired; not renewed in 14+ days (the
#                                    usual case)
#   cert_expiry_critical — CRITICAL: the same, issued under 14 days ago (a
#                                    short-lived certificate)
#   certbot_unavailable  — INFO:     openssl or the certificate dir missing
#
# Cadence: daily via systemd timer.
#
# Requires: openssl, /etc/letsencrypt/live/ populated.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
# A value that is not a plain whole number (up to 6 digits) is ignored, and
# leading zeros are dropped (dash reads 08 as bad octal), so a typo in the env
# file can neither stop the check nor break the alert's JSON.
whole() {
    case "${1:-}" in
        ''|*[!0-9]*) echo "$2"; return 0 ;;
    esac
    _w=$(printf '%s' "$1" | sed 's/^0*//')
    [ -n "$_w" ] || _w=0
    if [ "${#_w}" -le 6 ]; then echo "$_w"; else echo "$2"; fi
}
EXPIRY_CRITICAL_DAYS=$(whole "${MORPHIT_CERTBOT_EXPIRY_CRITICAL_DAYS:-}" 7)
# Days certbot gets past its renewal point before this warns (it tries twice a
# day, so a week is ~14 tries).  At most half the renewal window, at least 1.
RENEWAL_GRACE_DAYS=$(whole "${MORPHIT_CERTBOT_RENEWAL_GRACE_DAYS:-}" 7)
# Optional: warn at this many days left instead — honoured only when it is
# LOWER than the renewal point minus the grace (a warning before certbot is
# due can only ever be a false alarm).
EXPIRY_WARN_DAYS=$(whole "${MORPHIT_CERTBOT_EXPIRY_WARN_DAYS:-}" '')
# Not renewed in this many days, at the critical point: stalled.
RENEWAL_STALL_DAYS=$(whole "${MORPHIT_CERTBOT_RENEWAL_STALL_DAYS:-}" 14)

CERT_DIR=${MORPHIT_CERTBOT_CERT_DIR:-/etc/letsencrypt/live}
RENEWAL_DIR=${MORPHIT_CERTBOT_RENEWAL_DIR:-/etc/letsencrypt/renewal}

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="certbot"
MORPHIT_EMIT_TAG="morphit-certbot-monitor"

# ─── Bail if openssl / cert dir missing ────────────────────────
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

# The certificate's `renew_before_expiry` in days, when its renewal file sets
# one (certbot writes it commented out, and reads it only above the first
# [section]): `N`, `N day(s)`, `N week(s)` or `N month(s)` (30 days), quoted
# or not, any case, with or without a trailing comment.  Anything else:
# nothing, and the default applies.
renew_before_from_conf() {
    _conf="$RENEWAL_DIR/$1.conf"
    [ -r "$_conf" ] || return 0
    awk '
        /^[ \t]*\[/ { exit }
        {
            line = $0
            sub(/#.*/, "", line)
            if (line ~ /^[ \t]*renew_before_expiry[ \t]*=/) {
                sub(/^[ \t]*renew_before_expiry[ \t]*=/, "", line)
                gsub(/["\047]/, "", line)
                gsub(/^[ \t]+|[ \t]+$/, "", line)
                val = tolower(line)
            }
        }
        END {
            if (val == "") exit
            n = split(val, a, /[ \t]+/)
            if (a[1] !~ /^[0-9]+$/ || length(a[1]) > 6) exit
            if (n == 1) { print a[1] + 0; exit }
            if (n != 2) exit
            if (a[2] ~ /^days?$/) print a[1] + 0
            else if (a[2] ~ /^weeks?$/) print a[1] * 7
            else if (a[2] ~ /^months?$/) print a[1] * 30
        }
    ' "$_conf"
}

# ─── Iterate each live cert ────────────────────────────────────
for cert_path in "$CERT_DIR"/*/cert.pem; do
    [ -f "$cert_path" ] || continue
    cert_name=$(basename "$(dirname "$cert_path")")

    # `openssl x509 -startdate -enddate` gives
    # "notBefore=Sep  9 04:12:00 2026 GMT" / "notAfter=Dec  8 04:11:59 2026 GMT"
    dates=$(openssl x509 -in "$cert_path" -noout -startdate -enddate 2>/dev/null || true)
    start_date=$(printf '%s\n' "$dates" | sed -n 's/^notBefore=//p')
    end_date=$(printf '%s\n' "$dates" | sed -n 's/^notAfter=//p')
    [ -n "$start_date" ] && [ -n "$end_date" ] || continue
    start_epoch=$(date -d "$start_date" +%s 2>/dev/null) || continue
    end_epoch=$(date -d "$end_date" +%s 2>/dev/null) || continue
    now_epoch=$(date +%s)

    left_sec=$(( end_epoch - now_epoch ))
    # Whole days left, rounded down (also below zero: expired 12 h ago is -1).
    if [ "$left_sec" -ge 0 ]; then
        days_left=$(( left_sec / 86400 ))
    else
        days_left=$(( -((-left_sec + 86399) / 86400) ))
    fi
    issued_days_ago=$(( (now_epoch - start_epoch) / 86400 ))
    # Let's Encrypt's "90 days" is 90 days less a second: round to the nearest.
    lifetime_days=$(( (end_epoch - start_epoch + 43200) / 86400 ))

    # When certbot renews it: the renewal file's setting, else the earlier of
    # certbot 2.x's 30 days and certbot 4+'s third of the lifetime (half for a
    # certificate shorter than 10 days) — never a warning before either is due.
    renew_due=$(renew_before_from_conf "$cert_name")
    if [ -z "$renew_due" ]; then
        if [ "$lifetime_days" -lt 10 ]; then
            renew_due=$(( lifetime_days / 2 ))
        else
            renew_due=$(( lifetime_days / 3 ))
            [ "$renew_due" -le 30 ] || renew_due=30
        fi
    fi

    grace=$RENEWAL_GRACE_DAYS
    [ "$grace" -le $(( renew_due / 2 )) ] || grace=$(( renew_due / 2 ))
    [ "$grace" -ge 1 ] || grace=1
    warn_at=$(( renew_due - grace ))
    if [ -n "$EXPIRY_WARN_DAYS" ] && [ "$EXPIRY_WARN_DAYS" -lt "$warn_at" ]; then
        warn_at=$EXPIRY_WARN_DAYS
    fi
    crit_at=$EXPIRY_CRITICAL_DAYS
    [ "$crit_at" -le "$warn_at" ] || crit_at=$warn_at
    overdue_days=$(( (renew_due * 86400 - left_sec) / 86400 ))

    payload='{"cert":"'$(json_str "$cert_name")'","days_left":'$days_left',"issued_days_ago":'$issued_days_ago',"renew_due_days_left":'$renew_due',"overdue_days":'$overdue_days

    # Critical: overdue past the grace with the critical days left — or, with
    # any settings, expired, or a day left on a certificate of 3 weeks or more.
    critical=0
    if [ "$left_sec" -le 0 ]; then
        critical=1
    elif [ "$lifetime_days" -ge 21 ] && [ "$left_sec" -le 86400 ]; then
        critical=1
    elif [ "$left_sec" -le $(( crit_at * 86400 )) ]; then
        critical=1
    fi

    if [ "$critical" = 1 ]; then
        if [ "$issued_days_ago" -ge "$RENEWAL_STALL_DAYS" ]; then
            emit error renewal_stalled "${payload},\"stall_threshold_days\":${RENEWAL_STALL_DAYS}}"
        else
            emit error cert_expiry_critical "${payload},\"threshold_days\":${crit_at}}"
        fi
    elif [ "$left_sec" -le $(( warn_at * 86400 )) ]; then
        emit warn cert_expiry_warn "${payload},\"threshold_days\":${warn_at}}"
    fi
    # else: not due yet, or certbot still has its grace days — nothing to say
done

exit 0
