#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
# Morphit indexer — daily PostgreSQL backup script.
#
# Promoted from the RUN-A-MORPHIT-NODE.md copy-paste recipe to a
# first-class repo file in Audit Part 32 (2026-05-04).  The
# `morphit ops init` wizard installs this + its systemd timer
# by default; operators who want manual control can copy it to
# their own location and edit.
#
# What it does:
#   1. Reads operator-specific config from $BACKUP_ENV (default
#      /etc/morphit/backup.env).  This is a tiny shell-snippet
#      file with BACKUP_DIR, RETAIN_DAYS, DB_NAME, DB_USER lines
#      that the wizard generates.
#   2. pg_dump the indexer DB, gzip the output, write to a
#      .partial file first.
#   3. Atomically rename the .partial → final filename on
#      success.  Any earlier failure leaves a .partial behind
#      that the next run will see and ignore (find -mtime
#      cleanup keeps the dir tidy).
#   4. Prune backups older than $RETAIN_DAYS days.
#   5. Print one line on success — systemd journald captures
#      this so the operator can grep `journalctl -u
#      morphit-backup.service`.
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
#   - World-readable backups leaking DB contents (umask 077,
#     explicit chmod 600)
#   - Backup-dir not yet created (mkdir -p, chmod 700)
#   - Old backups accumulating forever (find -mtime prune)
#   - pg_dump password prompt blocking the cron'd run (uses
#     ~/.pgpass OR peer auth via the morphit system user)
#
# Failure modes the script does NOT cover (operator's
# responsibility):
#   - Off-server replication (rsync / rclone / s3 — see
#     RUN-A-MORPHIT-NODE.md §10 for recipes)
#   - Encryption-at-rest of the backup dir (filesystem-level
#     LUKS or per-backup gpg encryption)
#   - Verifying restore actually works (operator should test
#     this once a quarter — restoring to a throwaway DB and
#     diffing the orderbook count against production)
# ─────────────────────────────────────────────────────────────────────

set -eu

# Drop default file mode to 600 so anything we create is private
# from the start.  Tightens against the small race window between
# file creation and an explicit chmod.
umask 077

# ─── Load operator config ─────────────────────────────────────────────
# The wizard writes /etc/morphit/backup.env with operator-tunable
# values.  Manual installs can override $BACKUP_ENV via the
# systemd unit's Environment= directive.
BACKUP_ENV="${BACKUP_ENV:-/etc/morphit/backup.env}"

if [ ! -r "$BACKUP_ENV" ]; then
	echo "morphit-backup: error: cannot read $BACKUP_ENV" >&2
	echo "  Hint: run \`morphit ops init\` (or edit the env file" >&2
	echo "  manually — see ops/backup/backup.env.example)." >&2
	exit 2
fi

# shellcheck source=/dev/null
. "$BACKUP_ENV"

: "${BACKUP_DIR:?BACKUP_DIR not set in $BACKUP_ENV}"
: "${RETAIN_DAYS:=30}"
: "${DB_NAME:=morphit_indexer}"
: "${DB_USER:=morphit_indexer}"

# ─── Prepare backup dir ───────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

OUTFILE="$BACKUP_DIR/morphit-$(date -u +%Y%m%d-%H%M%S).sql.gz"
TMPFILE="$OUTFILE.partial"

# ─── Dump + atomically rename ─────────────────────────────────────────
# Write to .partial first so a half-written file isn't named like
# a finished backup.  The umask above makes both files 600 from
# creation; the explicit chmod is defense-in-depth in case umask
# isn't honored by the shell.
pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$TMPFILE"
chmod 600 "$TMPFILE"
mv "$TMPFILE" "$OUTFILE"

# ─── Prune old backups ────────────────────────────────────────────────
find "$BACKUP_DIR" -maxdepth 1 -name 'morphit-*.sql.gz' -mtime +"$RETAIN_DAYS" -delete

# Also clean up stale .partial files (failed runs from previous
# days).  Don't touch today's .partial — that's the current run's
# tmpfile, but at this point we've already mv'd it out.
find "$BACKUP_DIR" -maxdepth 1 -name '*.partial' -mtime +1 -delete

# ─── Success ──────────────────────────────────────────────────────────
SIZE=$(stat -c '%s' "$OUTFILE" 2>/dev/null || stat -f '%z' "$OUTFILE")
echo "morphit-backup: wrote $OUTFILE (${SIZE} bytes)"
