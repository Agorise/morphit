#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
# Morphit indexer — daily PostgreSQL backup script.
#
# Promoted from the RUN-A-MORPHIT-NODE.md copy-paste recipe to a
# first-class repo file in Audit Part 32 (2026-05-04).  The
# `morphit-ops init` wizard installs this + its systemd timer
# by default; operators who want manual control can copy it to
# their own location and edit.
#
# What it does:
#   1. Reads operator-specific config from $BACKUP_ENV (default
#      /etc/morphit/backup.env).  This is a tiny shell-snippet
#      file with BACKUP_DIR, RETAIN_DAYS, DB_NAME, DB_USER lines
#      that the wizard generates.  Optional fields:
#        AGE_RECIPIENT      — age public key; backups encrypted
#                             before write when set
#        REMOTE_DESTINATION — rsync target; backups pushed there
#                             after local write when set
#        SSH_KEY            — SSH key for rsync auth (used when
#                             REMOTE_DESTINATION is set)
#        DB_HOST / DB_PORT  — Postgres host/port (default
#                             localhost:5432); used only for a
#                             HOST-reachable Postgres.
#        DB_CONTAINER       — name of a Docker container running
#                             Postgres.  When set, the dump runs
#                             THROUGH `docker exec "$DB_CONTAINER"
#                             pg_dump …` (Docker-aware path — for a
#                             containerized DB like a BunkerWeb /
#                             docker-compose Postgres).  The wizard
#                             auto-detects + fills this on install +
#                             every upgrade; DB_HOST/DB_PORT are
#                             ignored on this path (the pg_dump runs
#                             inside the container, hitting its
#                             container-local socket = trust/peer
#                             auth, no password).
#   2. pg_dump the indexer DB, gzip the output, optionally
#      pipe through `age -r "$AGE_RECIPIENT"` for encryption,
#      write to a .partial file first.  pg_dump's OWN exit status
#      is recorded through a status file, because POSIX sh has no
#      `pipefail` and the pipeline otherwise reports gzip's 0.
#   3. Atomically rename the .partial → final filename ONLY when
#      the dump exited 0 AND produced more than an empty stream.
#      Any earlier failure leaves a .partial behind that the next
#      run will see and clean up.
#   4. If REMOTE_DESTINATION is set, rsync the final file off
#      the host (using SSH_KEY if provided).
#   5. Prune local backups older than $RETAIN_DAYS days.
#   6. Print one line on success — systemd journald captures
#      this so the operator can grep `journalctl -u
#      morphit-backup.service`.
#
# Placeholder-value guardrail (cp131 hardening):
#   If AGE_RECIPIENT or REMOTE_DESTINATION still contains a
#   placeholder marker like "REPLACE", "XXXXX", or "example.com",
#   the script REFUSES to use that feature — same posture as the
#   indexer/relay PLACEHOLDER_DB_PASSWORDS denylist.  An operator
#   who hasn't filled in their real values gets unencrypted
#   local-only backups (the same as if the field were unset) plus
#   a journald warning, rather than silently shipping plaintext
#   off-host or to a misconfigured destination.
#
# Why systemd timer (not cron):
#   - Runs visible in `journalctl -u morphit-backup.service`
#     alongside the rest of the Morphit services.
#   - `OnFailure=` directive can email or page the operator
#     on a failed backup (operator wires this to their
#     existing alert chain).
#   - Persistent=true makes a missed run (laptop suspended at
#     4 AM, server rebooting, etc.) fire as soon as the
#     timer is next active — daily-ish becomes daily.
#
# Failure modes the script defends against:
#   - Half-written backup file (.partial → atomic rename)
#   - A FAILED dump being kept as a real backup (pg_dump's status
#     is captured explicitly; the pipeline's own status is gzip's,
#     which is 0 even when pg_dump died, and gzip-of-nothing is
#     ~20 bytes so an emptiness check alone cannot see it)
#   - World-readable backups leaking DB contents (umask 077,
#     explicit chmod 600)
#   - Backup-dir not yet created (mkdir -p, chmod 700)
#   - Old backups accumulating forever (find -mtime prune)
#   - pg_dump password prompt blocking the cron'd run (uses
#     ~/.pgpass OR peer auth via the morphit system user)
#   - Operator forgot to replace placeholder AGE_RECIPIENT and
#     ships plaintext (placeholder denylist refuses to use it)
#   - Remote-push failure breaking local-backup retention
#     (remote-push errors are warned but don't fail the run)
#
# Failure modes the script does NOT cover (operator's
# responsibility):
#   - Off-server age private key custody (OPERATIONS.md §37.12)
#   - Verifying restore actually works (operator should test
#     this once a quarter — restoring to a throwaway DB and
#     diffing the orderbook count against production)
#   - Encryption-at-rest of the on-host backup dir (filesystem-
#     level LUKS); script-level age encryption covers off-host
#     copies; LUKS covers the on-host disk
# ─────────────────────────────────────────────────────────────────────

set -eu

# Drop default file mode to 600 so anything we create is private
# from the start.  Tightens against the small race window between
# file creation and an explicit chmod.
umask 077

# ─── Placeholder detection ────────────────────────────────────────────
# An operator who copied backup.env.example or ran the Ansible
# template without filling in real values would have placeholder
# strings in critical fields.  Using them silently would be:
#   - AGE_RECIPIENT: ship UNENCRYPTED data the operator believes
#                    is encrypted (worst case — false security)
#   - REMOTE_DESTINATION: rsync to a domain like example.com that
#                         either doesn't resolve or belongs to
#                         someone unrelated (leak vector)
# We refuse to use either placeholder value and log a clear
# warning.  Local plaintext-backup behavior continues — that's the
# pre-cp131 baseline, which is no worse than what an operator who
# never configured the optional fields gets.
is_placeholder() {
	# Echo nonempty string if $1 looks like a placeholder; empty
	# string if it looks like a real value.  Patterns are
	# case-insensitive on common placeholder words.
	value="$1"
	case "$value" in
		*REPLACE*|*replace*|*XXXXX*|*xxxxx*) echo "yes" ;;
		*example.com*|*example.org*) echo "yes" ;;
		*CHANGEME*|*CHANGE_ME*|*changeme*|*change_me*) echo "yes" ;;
		*) echo "" ;;
	esac
}

# ─── Load operator config ─────────────────────────────────────────────
# The wizard writes /etc/morphit/backup.env with operator-tunable
# values.  Manual installs can override $BACKUP_ENV via the
# systemd unit's Environment= directive.
BACKUP_ENV="${BACKUP_ENV:-/etc/morphit/backup.env}"

if [ ! -r "$BACKUP_ENV" ]; then
	echo "morphit-backup: error: cannot read $BACKUP_ENV" >&2
	echo "  Hint: run \`morphit-ops init\` (or edit the env file" >&2
	echo "  manually — see ops/backup/backup.env.example)." >&2
	exit 2
fi

# shellcheck source=/dev/null
. "$BACKUP_ENV"

: "${BACKUP_DIR:?BACKUP_DIR not set in $BACKUP_ENV}"
: "${RETAIN_DAYS:=30}"
: "${DB_NAME:=morphit_indexer}"
: "${DB_USER:=morphit_indexer}"
: "${DB_HOST:=}"
: "${DB_PORT:=}"
: "${DB_CONTAINER:=}"
: "${AGE_RECIPIENT:=}"
: "${REMOTE_DESTINATION:=}"
: "${SSH_KEY:=}"

# Filter placeholder values out of optional fields so they go
# unused rather than silently shipping a leak.
if [ -n "$AGE_RECIPIENT" ] && [ -n "$(is_placeholder "$AGE_RECIPIENT")" ]; then
	echo "morphit-backup: warning: AGE_RECIPIENT looks like a placeholder (\"$AGE_RECIPIENT\"); skipping age encryption" >&2
	echo "  Hint: generate a real age key with \`age-keygen -o ~/.age/morphit-backup.key\` and put its public side in /etc/morphit/backup.env" >&2
	AGE_RECIPIENT=""
fi
if [ -n "$REMOTE_DESTINATION" ] && [ -n "$(is_placeholder "$REMOTE_DESTINATION")" ]; then
	echo "morphit-backup: warning: REMOTE_DESTINATION looks like a placeholder (\"$REMOTE_DESTINATION\"); skipping off-host push" >&2
	echo "  Hint: set REMOTE_DESTINATION=user@your-backup-host:/morphit/ in /etc/morphit/backup.env" >&2
	REMOTE_DESTINATION=""
fi
# A placeholder DB_CONTAINER (Ansible template left unfilled, or auto-detection
# wrote a marker) → treat as unset and fall back to the host pg_dump path
# rather than docker-exec'ing a bogus container name.
if [ -n "$DB_CONTAINER" ] && [ -n "$(is_placeholder "$DB_CONTAINER")" ]; then
	echo "morphit-backup: warning: DB_CONTAINER looks like a placeholder (\"$DB_CONTAINER\"); ignoring it and using a host pg_dump" >&2
	DB_CONTAINER=""
fi

# If age encryption is requested, confirm `age` is on PATH BEFORE
# we run pg_dump — otherwise we'd waste a dump and then fail at
# the encryption step.  Loud-fail fast is the right posture.
if [ -n "$AGE_RECIPIENT" ]; then
	if ! command -v age >/dev/null 2>&1; then
		echo "morphit-backup: error: AGE_RECIPIENT is set but \`age\` binary is not on PATH" >&2
		echo "  Hint: \`apt install age\` (Debian/Ubuntu) or equivalent for your distro" >&2
		echo "  Refusing to run — operator expects encrypted backups but the encryption tool is missing." >&2
		exit 3
	fi
fi
# Same for rsync.
if [ -n "$REMOTE_DESTINATION" ]; then
	if ! command -v rsync >/dev/null 2>&1; then
		echo "morphit-backup: error: REMOTE_DESTINATION is set but \`rsync\` binary is not on PATH" >&2
		echo "  Hint: \`apt install rsync\`" >&2
		exit 3
	fi
fi
# Docker-aware path: if DB_CONTAINER is set we dump THROUGH `docker exec`, so
# `docker` must be on PATH AND runnable by the backup user. Loud-fail fast
# (same posture as age/rsync) rather than silently falling back to a host
# pg_dump the operator never configured — a silent fallback could dump the
# WRONG database (or nothing) while the operator believes their containerized
# DB is safely backed up.
if [ -n "$DB_CONTAINER" ]; then
	if ! command -v docker >/dev/null 2>&1; then
		echo "morphit-backup: error: DB_CONTAINER is set (\"$DB_CONTAINER\") but \`docker\` is not on PATH" >&2
		echo "  Hint: the backup runs as the systemd unit's user; ensure that user can run docker (add it to the 'docker' group), or unset DB_CONTAINER in /etc/morphit/backup.env to use a host pg_dump instead." >&2
		exit 3
	fi
fi

# ─── Prepare backup dir ───────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Filename suffix reflects whether the backup is encrypted —
# operators eyeballing $BACKUP_DIR can tell at a glance.
if [ -n "$AGE_RECIPIENT" ]; then
	SUFFIX="sql.gz.age"
else
	SUFFIX="sql.gz"
fi
OUTFILE="$BACKUP_DIR/morphit-$(date -u +%Y%m%d-%H%M%S).$SUFFIX"
TMPFILE="$OUTFILE.partial"

# ─── Build pg_dump command ────────────────────────────────────────────
# DB_HOST and DB_PORT default to empty: when empty, pg_dump falls
# through to local Unix-socket peer auth.  When set, they're
# forwarded as -h / -p flags so an operator can point at a non-
# colocated Postgres.
PG_ARGS="-U $DB_USER"
[ -n "$DB_HOST" ] && PG_ARGS="$PG_ARGS -h $DB_HOST"
[ -n "$DB_PORT" ] && PG_ARGS="$PG_ARGS -p $DB_PORT"

# When a DB_PASSWORD is configured, hand it to pg_dump via PGPASSWORD. Ansible
# installs authenticate as the indexer DB ROLE (e.g. morphit_indexer) over TCP
# with a password — because the service's OS user (morphit) doesn't match that
# role, so Unix-socket PEER auth would fail. Leaving DB_PASSWORD unset keeps the
# original local peer/trust behaviour (correct when the OS user matches the role,
# e.g. some manual installs / the in-container docker-exec path).
if [ -n "${DB_PASSWORD:-}" ]; then
	export PGPASSWORD="$DB_PASSWORD"
fi

# Choose HOST vs CONTAINER dump. For a containerized Postgres the pg_dump runs
# INSIDE the container via `docker exec`, connecting to the container's own
# local socket (trust/peer auth — no password, no host/port). DB_HOST/DB_PORT
# are host-relative and meaningless in-container, so the container path uses
# -U + DB_NAME only. Container names never contain whitespace, so the unquoted
# expansion in the pipeline below word-splits cleanly.
if [ -n "$DB_CONTAINER" ]; then
	DUMP_CMD="docker exec $DB_CONTAINER pg_dump -U $DB_USER"
else
	DUMP_CMD="pg_dump $PG_ARGS"
fi

# ─── Dump → (optionally encrypt) → atomically rename ──────────────────
# Write to .partial first so a half-written file isn't named like
# a finished backup.  The umask above makes files 600 from
# creation; the explicit chmod is defense-in-depth.
#
# Pipeline shape:
#   pg_dump | gzip                              (plaintext path)
#   pg_dump | gzip | age -r "$AGE_RECIPIENT"    (encrypted path)
#
# `set -e` doesn't propagate pipefail by default in /bin/sh; we
# explicitly check $? after the pipeline AND set pipefail when
# available so that gzip's or age's failure isn't masked by the
# trailing redirect's success.
#
# `set -o pipefail` is NOT POSIX and dash rejects it outright.
#
# The guard MUST live in a CONDITION context. `set` is a SPECIAL
# builtin, so on an unsupported option dash exits the shell
# immediately -- it never reaches a trailing `|| true`, and a bare
# subshell's non-zero status then trips the parent's `set -e`. The
# previous form here, `( set -o pipefail 2>/dev/null || true )`,
# looked defensive but killed the script dead on every Ubuntu box
# (where /bin/sh is dash), with `2>/dev/null` swallowing the only
# clue -- a silent exit 2 before pg_dump ever ran, i.e. backups
# that never happened. Inside an `if` condition `set -e` is
# suppressed and the failing subshell simply reads as false.
# shellcheck disable=SC3040  # pipefail isn't POSIX; probed before use
if ( set -o pipefail ) 2>/dev/null; then
	set -o pipefail
fi
#
# ...BUT THE PROBE IS FALSE ON THE PLATFORM WE ACTUALLY TARGET, so it
# cannot be the only defence.  Debian/Ubuntu build dash WITHOUT pipefail
# (verified at runtime on 0.5.12-6ubuntu5: `set -o pipefail` is rejected),
# so on every production Morphit box the pipeline reports GZIP's status --
# which is 0 even when pg_dump died -- and `set -e` sees a clean run.
#
# The `-s` guard below could not save it either: gzip of a FAILED dump is
# still a valid ~20-byte member, and `age` of that is ~200 bytes, so both
# are NON-empty.  A refused DB connection therefore wrote a 20-byte file,
# renamed it to a real backup name, printed "wrote ... (20 bytes)" and
# exited 0 -- and `morphit-ops health` then reported that as a FRESH
# backup.  Truncated garbage is worse than nothing precisely because it
# also silences the freshness alarm added to catch nothing.
#
# So record pg_dump's OWN exit status through a file the pipeline cannot
# swallow, and size the artifact against what THIS pipeline yields for an
# empty dump.
DUMP_STATUS="$BACKUP_DIR/.morphit-backup-status.$$"
rm -f "$DUMP_STATUS"

run_dump() {
	# The `&&`/`||` list is load-bearing: a bare `$DUMP_CMD ...` would trip
	# `set -e` and kill this subshell BEFORE the status file is written,
	# leaving us unable to tell "dump failed" from "shell died".
	# shellcheck disable=SC2086  # DUMP_CMD/PG_ARGS deliberately word-split
	$DUMP_CMD "$DB_NAME" && dump_rc=0 || dump_rc=$?
	echo "$dump_rc" > "$DUMP_STATUS"
}

# ─── Guard: never write a backup of an UNMIGRATED (schemaless) database ───
# A dump taken before the indexer has run its migrations contains only
# pg_dump's header/SET boilerplate and NO `CREATE TABLE` — ~396 bytes gzipped,
# which sits ABOVE the empty-stream baseline, so the size check below would
# happily keep it and `morphit-ops health` would then report a bogus "failing"
# backup (a 396-byte "restore point" that restores nothing).  This happens on a
# fresh node when the very first run races schema readiness (e.g. a slow tor-only
# indexer that outran the install's port-wait).  SKIP only when the schema probe
# SUCCEEDS but finds no tables (genuinely unmigrated): exit 0 (nothing to back up
# yet, not a failure) so no fragment is written; the timer retries and captures a
# real dump once the schema exists.  If the probe itself FAILS (connection error,
# etc.) we do NOT skip — we fall through so the real dump runs and the DUMP_STATUS
# check below reports the failure honestly rather than masking it as "no schema".
# shellcheck disable=SC2086  # DUMP_CMD deliberately word-split
schema_probe=$($DUMP_CMD --schema-only "$DB_NAME" 2>/dev/null) && schema_probe_ok=1 || schema_probe_ok=0
if [ "$schema_probe_ok" = "1" ] && [ -n "$schema_probe" ] && ! printf '%s\n' "$schema_probe" | grep -qi 'CREATE TABLE'; then
	echo "morphit-backup: indexer schema not migrated yet (no tables) — skipping this run; the timer will capture a real backup once the schema exists." >&2
	exit 0
fi

if [ -n "$AGE_RECIPIENT" ]; then
	run_dump | gzip | age -r "$AGE_RECIPIENT" > "$TMPFILE"
	EMPTY_SIZE=$(printf '' | gzip | age -r "$AGE_RECIPIENT" | wc -c | tr -d ' ')
else
	run_dump | gzip > "$TMPFILE"
	EMPTY_SIZE=$(printf '' | gzip | wc -c | tr -d ' ')
fi

# A missing status file means the dump subshell never reached its final
# line (killed, OOM, disk full) -- treat that as failure, never success.
DUMP_RC=$(cat "$DUMP_STATUS" 2>/dev/null || echo 127)
rm -f "$DUMP_STATUS"
if [ "$DUMP_RC" != "0" ]; then
	echo "morphit-backup: error: pg_dump exited $DUMP_RC — refusing to keep a truncated backup" >&2
	echo "  The pipeline's own status is gzip's, so this is checked explicitly (see the note above)." >&2
	echo "  Hint: run the dump by hand to see the real error, e.g. \`$DUMP_CMD $DB_NAME >/dev/null\`" >&2
	rm -f "$TMPFILE"
	exit 4
fi

# Belt-and-braces: pg_dump CAN exit 0 having emitted nothing at all.
# Compare against the empty-stream baseline rather than a bare `-s`,
# because gzip/age of nothing is NOT zero bytes.
ACTUAL_SIZE=$(wc -c < "$TMPFILE" | tr -d ' ')
if [ "$ACTUAL_SIZE" -le "$EMPTY_SIZE" ]; then
	echo "morphit-backup: error: dump produced no data — $ACTUAL_SIZE bytes at $TMPFILE, at or below the ${EMPTY_SIZE}-byte empty-stream baseline" >&2
	rm -f "$TMPFILE"
	exit 4
fi
chmod 600 "$TMPFILE"
mv "$TMPFILE" "$OUTFILE"

# ─── Optionally push off-host ─────────────────────────────────────────
# Treat off-host push as best-effort: a network blip shouldn't
# delete the local backup we just wrote.  Errors are warned but
# don't fail the run.
if [ -n "$REMOTE_DESTINATION" ]; then
	RSYNC_ARGS="-a --partial --timeout=600"
	[ -n "$SSH_KEY" ] && RSYNC_ARGS="$RSYNC_ARGS -e \"ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30\""
	if eval "rsync $RSYNC_ARGS \"$OUTFILE\" \"$REMOTE_DESTINATION\"" 2>&1; then
		echo "morphit-backup: pushed $OUTFILE → $REMOTE_DESTINATION"
	else
		echo "morphit-backup: warning: rsync push to $REMOTE_DESTINATION failed; local backup at $OUTFILE is intact" >&2
	fi
fi

# ─── Prune old backups ────────────────────────────────────────────────
# Match both encrypted and plaintext extensions so a transition
# between modes doesn't leave old files behind.
find "$BACKUP_DIR" -maxdepth 1 \( -name 'morphit-*.sql.gz' -o -name 'morphit-*.sql.gz.age' \) -mtime +"$RETAIN_DAYS" -delete

# Also clean up stale .partial files (failed runs from previous
# days).  Don't touch today's .partial — that's the current run's
# tmpfile, but at this point we've already mv'd it out.
find "$BACKUP_DIR" -maxdepth 1 -name '*.partial' -mtime +1 -delete

# Same for a dump-status file leaked by a run that died between the
# pipeline and the status read (this run removes its own on both paths).
find "$BACKUP_DIR" -maxdepth 1 -name '.morphit-backup-status.*' -mtime +1 -delete

# ─── Success ──────────────────────────────────────────────────────────
SIZE=$(stat -c '%s' "$OUTFILE" 2>/dev/null || stat -f '%z' "$OUTFILE")
ENC=""
[ -n "$AGE_RECIPIENT" ] && ENC=" (age-encrypted)"
echo "morphit-backup: wrote $OUTFILE (${SIZE} bytes)$ENC"
