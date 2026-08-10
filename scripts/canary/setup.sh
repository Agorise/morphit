#!/usr/bin/env bash
#
# scripts/canary/setup.sh
#
# One-time, guided setup for this Morphit instance's warrant canary. Run this
# ONCE on the machine that will SIGN the canary (your "admin" machine); after
# that a weekly timer keeps the canary fresh on its own.
#
# It handles BOTH kinds of Morphit deployment, and asks you which you have:
#
#   • HOME HOSTING (local) — your Morphit runs on THIS computer (e.g. a Mint
#     box at home). The canary is signed here and placed straight into the
#     served build/ dir. Simplest; nothing to upload.
#
#   • REMOTE SERVER (VPS)  — your Morphit runs on a separate server. You sign
#     the canary HERE (so the signing key never sits on the internet-facing
#     box) and this script uploads the signed file to the server. This is the
#     stronger arrangement OPERATIONS.md §36 recommends.
#
# Why signing lives OFF the served box (for the remote case): a warrant canary
# has to go stale exactly when something is wrong — if you're compelled and
# gagged, if the box is seized, if something happens to you. A signer that runs
# on the served box would keep stamping "all-clear" forever, turning the canary
# into a lie. Keeping the key on your own machine makes silence mean something.
#
# This script is intentionally plain shell (gpg, curl, ssh, systemctl) so you
# can read every line before trusting it with a signing key.

set -euo pipefail

# ─── tiny UI helpers (prompts go to stderr so $(...) capture stays clean) ──

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'canary-setup: %s\n' "$*" >&2; }
die()  { printf 'canary-setup: %s\n' "$*" >&2; exit 1; }

ask() { # $1=prompt  $2=default(optional) -> echoes the answer
	local prompt="$1" def="${2:-}" ans
	if [ -n "$def" ]; then printf '%s [%s]: ' "$prompt" "$def" >&2
	else printf '%s: ' "$prompt" >&2; fi
	read -r ans || true
	printf '%s' "${ans:-$def}"
}

confirm() { # $1=prompt -> 0 if yes (default yes)
	local ans
	printf '%s [Y/n]: ' "$1" >&2
	read -r ans || true
	case "${ans:-y}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# ─── 0. Banner + locate the repo ─────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GENERATE="$REPO_ROOT/scripts/canary/generate.sh"
STATIC_DIR="$REPO_ROOT/apps/web/static"
BUILD_DIR="$REPO_ROOT/apps/web/build"
# cp693 — the SERVED build dir. On a manual/source install the source tree IS
# what nginx serves, so this defaults to $REPO_ROOT/apps/web/build. But on an
# ansible/home install the wizard runs this script from the SOURCE tarball
# (~/Downloads/morphit) while the frontend container serves the DEPLOYED tree
# (/opt/morphit/apps/web/build). The wizard passes MORPHIT_CANARY_SERVE_DIR so
# the signed canary + weekly refresh land where it's actually served, not in the
# source tree where nothing reads it.
SERVE_DIR="${MORPHIT_CANARY_SERVE_DIR:-$REPO_ROOT/apps/web/build}"

say ""
say "── Morphit warrant-canary setup ───────────────────────────────"
say ""
say "This sets up a PGP-signed warrant canary for your instance and keeps it"
say "refreshed automatically every week. It takes a couple of minutes."
say ""

[ -f "$GENERATE" ] || die "can't find generate.sh at $GENERATE — run this from inside your Morphit checkout."

# ─── 1. Tools ────────────────────────────────────────────────────

for tool in gpg curl node; do
	command -v "$tool" >/dev/null 2>&1 || die "required tool '$tool' is not installed."
done
[ -x "$REPO_ROOT/node_modules/.bin/tsx" ] || die "tsx not found — run 'npm ci' in $REPO_ROOT first (the canary's chain-head fetchers need it)."

# ─── 2. Which deployment? ────────────────────────────────────────

say "Where does your Morphit instance run?"
say "  1) On THIS computer — home hosting (sign + serve right here)"
say "  2) On a remote server / VPS (sign here, upload the canary there)"
MODE=""
while [ -z "$MODE" ]; do
	case "$(ask 'Enter 1 or 2' '1')" in
		1) MODE=local ;;
		2) MODE=remote ;;
		*) say "Please enter 1 or 2." ;;
	esac
done
say ""

REMOTE_SSH=""
REMOTE_PATH=""
if [ "$MODE" = remote ]; then
	command -v ssh >/dev/null 2>&1 || die "'ssh' is required for the remote/VPS mode."
	command -v scp >/dev/null 2>&1 || die "'scp' is required for the remote/VPS mode."
	REMOTE_SSH="$(ask 'Server SSH login (e.g. root@morphit.io or user@1.2.3.4)' '')"
	[ -n "$REMOTE_SSH" ] || die "a server SSH login is required for the remote mode."
	REMOTE_PATH="$(ask 'Path to Morphit on the server' '/opt/morphit')"
	say "Checking SSH access to $REMOTE_SSH ..."
	ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_SSH" 'true' 2>/dev/null \
		|| die "couldn't connect to $REMOTE_SSH without a password. Set up an SSH key first (ssh-copy-id $REMOTE_SSH), then re-run."
	info "SSH OK."
	# cp622 — a fresh root install leaves the served build/ dir root-owned, so the
	# very FIRST canary upload from this (non-root) SSH login would hit "Permission
	# denied." If this login has passwordless sudo on the server, hand build/ to it
	# now so uploads just work — no manual chown. Best-effort: if sudo isn't
	# available we skip quietly (the one-time chown is in RUN-A-MORPHIT-NODE.md §9).
	_build_remote="$REMOTE_PATH/apps/web/build"
	if ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_SSH" 'sudo -n true' 2>/dev/null; then
		if ssh -o BatchMode=yes "$REMOTE_SSH" "sudo -n mkdir -p '$_build_remote' && sudo -n chown -R \"\$(id -un):\$(id -gn)\" '$_build_remote'" 2>/dev/null; then
			info "Made the served build/ dir writable for your canary uploads (via sudo)."
		else
			info "(Couldn't auto-adjust the served dir; if your first upload hits"
			info " 'Permission denied', see the one-time chown in RUN-A-MORPHIT-NODE.md §9.)"
		fi
	fi
	say ""
fi

# ─── 3. Signing key (find, or offer to create one) ───────────────

# Existing secret-key fingerprints, newest last.
KEY_ID="${MORPHIT_CANARY_PGP_KEY_ID:-}"
EXISTING=()
while IFS= read -r fpr; do [ -n "$fpr" ] && EXISTING+=("$fpr"); done < <(
	gpg --list-secret-keys --with-colons 2>/dev/null | awk -F: '$1=="fpr"{print $10}'
)

if [ -n "$KEY_ID" ]; then
	info "Using signing key from \$MORPHIT_CANARY_PGP_KEY_ID: $KEY_ID"
elif [ "${#EXISTING[@]}" -gt 0 ]; then
	say "Found these PGP signing keys on this machine:"
	i=1
	for fpr in "${EXISTING[@]}"; do
		uid="$(gpg --list-keys --with-colons "$fpr" 2>/dev/null | awk -F: '$1=="uid"{print $10; exit}')"
		info "$i) $fpr  ${uid:-}"
		i=$((i + 1))
	done
	pick="$(ask "Which key should sign the canary? (1-${#EXISTING[@]})" '1')"
	case "$pick" in ''|*[!0-9]*) pick=1 ;; esac
	[ "$pick" -ge 1 ] && [ "$pick" -le "${#EXISTING[@]}" ] || pick=1
	KEY_ID="${EXISTING[$((pick - 1))]}"
	info "Using $KEY_ID."
else
	say "You don't have a PGP signing key on this machine yet — that's fine, I can"
	say "create one for you now. It's what signs your canary so readers can verify it."
	confirm "Create a signing key now?" || die "a signing key is required; re-run once you have one."
	kname="$(ask 'A name for the key (e.g. Jane, or your instance name)' "${MORPHIT_CANARY_OPERATOR_NAME:-}")"
	kemail="$(ask 'An email for the key (e.g. you@example.com)' '')"
	[ -n "$kname" ] && [ -n "$kemail" ] || die "a name and email are needed to create the key."
	say "Creating your key (no passphrase, so the weekly refresh can run on its own)..."
	# A passphrase-less key lets the timer sign unattended. On a home box this is
	# a deliberate trade-off; the security note at the end explains it.
	gpg --batch --passphrase '' --quick-generate-key "$kname <$kemail>" default sign 2y
	KEY_ID="$(gpg --list-secret-keys --with-colons "$kemail" 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}')"
	[ -n "$KEY_ID" ] || die "key creation appears to have failed."
	info "Created signing key $KEY_ID."
fi

# Confirm the key can actually sign without prompting (needed for the timer).
if ! printf 'canary-selftest' | gpg --batch --yes --local-user "$KEY_ID" --clearsign >/dev/null 2>&1; then
	warn "the chosen key asked for a passphrase (or failed to sign). For the weekly"
	warn "timer to run unattended, cache the passphrase in your gpg-agent, or use a"
	warn "passphrase-less key. Continuing — the first refresh below may prompt you."
fi

# Publish the PUBLIC key so readers can verify the canary (served at /pgp_keys.asc).
gpg --armor --export "$KEY_ID" > "$STATIC_DIR/pgp_keys.asc"
info "Exported your public key to apps/web/static/pgp_keys.asc (served at /pgp_keys.asc)."
say ""

# ─── 4. Instance identity (what the canary declares) ─────────────

say "A few details that appear in the signed canary:"
OPERATOR_NAME="$(ask 'Operator name (e.g. morphit.io)' "${MORPHIT_CANARY_OPERATOR_NAME:-}")"
INSTANCE_ORIGIN="$(ask 'Your instance URL (e.g. https://morphit.io)' "${MORPHIT_CANARY_INSTANCE_ORIGIN:-}")"
OPERATOR_ACCOUNT="$(ask 'Your Blurt operator account, no @ (e.g. morphit)' "${MORPHIT_CANARY_OPERATOR_ACCOUNT:-}")"
[ -n "$OPERATOR_NAME" ] && [ -n "$INSTANCE_ORIGIN" ] && [ -n "$OPERATOR_ACCOUNT" ] \
	|| die "operator name, instance URL, and Blurt account are all required."
OPERATOR_ACCOUNT="${OPERATOR_ACCOUNT#@}"
say ""

# ─── 5. Write the weekly refresh script ──────────────────────────

MORPHIT_HOME="$HOME/.morphit"
REFRESH="$MORPHIT_HOME/update-canary.sh"
mkdir -p "$MORPHIT_HOME"

{
	printf '#!/usr/bin/env bash\n'
	printf '# Auto-generated by scripts/canary/setup.sh — refreshes the Morphit warrant canary.\n'
	printf '# Re-run setup.sh to change anything here.\n'
	printf 'set -euo pipefail\n'
	printf "export MORPHIT_CANARY_PGP_KEY_ID='%s'\n" "$KEY_ID"
	printf "export MORPHIT_CANARY_OPERATOR_NAME='%s'\n" "$OPERATOR_NAME"
	printf "export MORPHIT_CANARY_INSTANCE_ORIGIN='%s'\n" "$INSTANCE_ORIGIN"
	printf "export MORPHIT_CANARY_OPERATOR_ACCOUNT='%s'\n" "$OPERATOR_ACCOUNT"
	printf "REPO='%s'\n" "$REPO_ROOT"
	printf "SERVE='%s'\n" "$SERVE_DIR"
	printf 'cd "$REPO"\n'
	printf 'bash scripts/canary/generate.sh\n'
	printf 'SIGNED="$REPO/apps/web/static/canary.txt"\n'
	printf 'PUBKEY="$REPO/apps/web/static/pgp_keys.asc"\n'
	if [ "$MODE" = local ]; then
		printf '# Home hosting: place the freshly-signed canary where nginx serves it.\n'
		printf 'DEST="$SERVE"\n'
		printf 'mkdir -p "$DEST"\n'
		printf '# Self-heal: an upgrade may re-root build/; take it back (best-effort sudo) before writing.\n'
		printf 'if [ ! -w "$DEST" ] && command -v sudo >/dev/null 2>&1; then sudo -n chown -R "$(id -un):$(id -gn)" "$DEST" 2>/dev/null || true; fi\n'
		printf 'install -m 0644 "$SIGNED" "$DEST/canary.txt"\n'
		printf 'install -m 0644 "$PUBKEY" "$DEST/pgp_keys.asc"\n'
		printf 'echo "canary: placed in $DEST/ (served at /canary.txt)"\n'
	else
		printf '# Remote server: upload the freshly-signed canary to the served build/ dir.\n'
		printf "REMOTE_SSH='%s'\n" "$REMOTE_SSH"
		printf "REMOTE_PATH='%s'\n" "$REMOTE_PATH"
		# Emit the self-heal (below) into the refresh script instead of a bare mkdir,
		# so an upgrade re-rooting build/ can never break the canary upload.
		cat <<'SELFHEAL'
# Self-heal: an in-place `morphit-ops upgrade` re-roots the served build/ dir, so
# make it ours (best-effort, via passwordless sudo) before uploading — a re-rooted
# dir can then never break the canary, on any version. No passwordless sudo → just
# ensure the dir exists and let the scp below surface any real permission problem.
if ssh -o BatchMode=yes "$REMOTE_SSH" 'sudo -n true' 2>/dev/null; then
	ssh -o BatchMode=yes "$REMOTE_SSH" "sudo -n mkdir -p '$REMOTE_PATH/apps/web/build' && sudo -n chown -R \"\$(id -un):\$(id -gn)\" '$REMOTE_PATH/apps/web/build'" 2>/dev/null || true
else
	ssh "$REMOTE_SSH" "mkdir -p '$REMOTE_PATH/apps/web/build'"
fi
SELFHEAL
		printf 'scp -q "$SIGNED" "$REMOTE_SSH:$REMOTE_PATH/apps/web/build/canary.txt"\n'
		printf 'scp -q "$PUBKEY" "$REMOTE_SSH:$REMOTE_PATH/apps/web/build/pgp_keys.asc"\n'
		printf 'echo "canary: uploaded to $REMOTE_SSH:$REMOTE_PATH/apps/web/build/"\n'
	fi
} > "$REFRESH"
chmod +x "$REFRESH"
info "Wrote your refresh script: $REFRESH"
say ""

# ─── 6. Install the weekly timer (systemd user timer, or cron) ───

TIMER_OK=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
	UNIT_DIR="$HOME/.config/systemd/user"
	mkdir -p "$UNIT_DIR"
	cat > "$UNIT_DIR/morphit-canary.service" <<UEOF
[Unit]
Description=Refresh the Morphit warrant canary

[Service]
Type=oneshot
ExecStart=$REFRESH
UEOF
	cat > "$UNIT_DIR/morphit-canary.timer" <<'UEOF'
[Unit]
Description=Weekly Morphit warrant-canary refresh

[Timer]
OnCalendar=Sun *-*-* 03:14:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UEOF
	systemctl --user daemon-reload
	systemctl --user enable --now morphit-canary.timer >/dev/null 2>&1 && TIMER_OK=1
	# Keep the timer running even when you're logged out.
	loginctl enable-linger "$USER" >/dev/null 2>&1 \
		|| info "(couldn't enable 'linger'; the timer runs while you're logged in)"
	[ "$TIMER_OK" = 1 ] && info "Weekly systemd timer armed (Sundays, 03:14 UTC)."
fi

if [ "$TIMER_OK" != 1 ]; then
	# Fall back to a cron line the operator can paste.
	CRON_LINE="14 3 * * 0 $REFRESH >> $MORPHIT_HOME/canary.log 2>&1"
	warn "no systemd user timer available. Add this weekly cron line yourself:"
	printf '\n    %s\n\n' "$CRON_LINE" >&2
	printf '%s\n' "$CRON_LINE" > "$MORPHIT_HOME/canary.cron"
	info "(also saved to $MORPHIT_HOME/canary.cron)"
fi
say ""

# ─── 7. First run (sign + place/upload now) ──────────────────────

say "Signing and publishing your first canary now..."
if bash "$REFRESH"; then
	info "First canary published. Check ${INSTANCE_ORIGIN%/}/canary.txt in a browser."
else
	die "the first refresh failed — see the messages above. Fix, then re-run: bash $REFRESH"
fi
say ""

# ─── 8. Summary + honest security note ───────────────────────────

say "── Done ───────────────────────────────────────────────────────"
info "Canary signed with key: $KEY_ID"
info "Refreshes weekly via:    $REFRESH"
if [ "$MODE" = remote ]; then
	info "Uploads to:              $REMOTE_SSH:$REMOTE_PATH/apps/web/build/"
else
	info "Served from:             $SERVE_DIR/"
fi
say ""
say "IMPORTANT — after every 'morphit-ops' UPGRADE, the rebuild wipes the served"
say "build/ dir, so re-run your refresh once to restore the canary:"
info "bash $REFRESH"
say ""
if [ "$MODE" = local ]; then
	say "SECURITY NOTE: your canary is signed on the SAME machine that serves it."
	say "That's fine for home hosting, but the strongest canary is signed on a"
	say "SEPARATE computer, so that a seizure of this box can't forge future"
	say '"all-clear" canaries. If you add a second machine later, re-run this in'
	say "remote mode from it."
fi
