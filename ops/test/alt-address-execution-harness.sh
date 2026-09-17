#!/usr/bin/env bash
# ops/test/alt-address-execution-harness.sh — EXECUTE the parts of the
# vanity-address path that can silently do the wrong thing.
#
# WHY THIS EXISTS
# Adding a vanity `.i2p` / `.loki` address was covered only by text-matching
# smokes. This session established what that is worth: nine production-only
# failures walked past 130+ text assertions, and three guards written for
# specific fixes passed while guarding nothing. Before touching a live instance
# the address-resolution logic gets executed, against real config layouts.
#
# WHAT SPECIFICALLY COULD GO WRONG HERE, and is checked below:
#   1. A vanity NAME (morphit.i2p) is not a b32. The config/router check
#      compares b32s, so if the name were picked up as "the address" it would
#      never equal what i2pd reports and would cry wolf forever.
#   2. The address was read by grepping the whole config for ANY b32 and taking
#      the first. A hidden RPC endpoint or peer hint in the same file would hand
#      a STRANGER's address to the comparison — the same defect as the unscoped
#      i2pd console scrape, one file over.
#   3. Legacy key (`..._I2P_ADDRESS`) must still work — an instance configured
#      before the modern key existed must not suddenly report no address.
#   4. Adding a name must not DISPLACE the b32, which stays the address of
#      record: a `.i2p` name only resolves for routers subscribed to a registry
#      carrying it, so losing the b32 would cut off everyone else.
#
# Hermetic: temp config files, no network, no root, nothing installed.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SEED="$REPO/ops/ipfs/morphit-ipfs-seed.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fails=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

OWN_B32="of65zlzj7b4sjlg47weanpi3uwyer6abprh2xwwztgq3qqzxvspq.b32.i2p"
PEER_B32="zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa.b32.i2p"
VANITY="morphit.i2p"

# Extract the address-resolution region and run it against a given config pair.
python3 - "$SEED" "$WORK/region.sh" <<'PY'
import sys
src = open(sys.argv[1], encoding='utf-8').read()
start = src.index('_i2p="${MORPHIT_SEED_I2P:-}"')
end = src.index('# \u2500\u2500 Does the config match what the ROUTER actually hosts?', start)
open(sys.argv[2], 'w', encoding='utf-8').write(src[start:end])
PY

resolve() { # $1=CFG contents  $2=ALTCFG contents
	printf '%s\n' "$1" > "$WORK/cfg.env"
	printf '%s\n' "$2" > "$WORK/alt.env"
	dash -c "
set -u
CFG='$WORK/cfg.env'
ALTCFG='$WORK/alt.env'
. '$WORK/region.sh'
printf '%s' \"\${_i2p:-}\"
" 2>/dev/null
}

echo "── vanity alt-address resolution, executed ─────────────────────"

# 1. b32 + vanity name together — the exact shape after adding morphit.i2p.
got="$(resolve "MORPHIT_INSTANCE_I2P_B32_ADDRESS=$OWN_B32
MORPHIT_INSTANCE_I2P_NAME_ADDRESS=$VANITY" "")"
[ "$got" = "$OWN_B32" ] \
	&& ok "with a b32 AND a vanity name, the B32 is used for the router comparison" \
	|| no "wrong address picked with a vanity name present: [$got]"

# 2. a vanity name must never be mistaken for the address (it is not a b32).
[ "$got" != "$VANITY" ] \
	&& ok "…the vanity name is never treated as the b32 (it would never match i2pd)" \
	|| no "the vanity name was used as the address — permanent false mismatch"

# 3. A STRANGER's b32 elsewhere in the file must not win.
got="$(resolve "MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://$PEER_B32:8091
MORPHIT_INSTANCE_I2P_B32_ADDRESS=$OWN_B32" "")"
[ "$got" = "$OWN_B32" ] \
	&& ok "a peer's b32 earlier in the file does NOT win (key-scoped, not first-match)" \
	|| no "picked a stranger's address: [$got] — would cry wolf about a correct config"

# 4. legacy key must still resolve.
got="$(resolve "MORPHIT_INSTANCE_I2P_ADDRESS=$OWN_B32" "")"
[ "$got" = "$OWN_B32" ] \
	&& ok "the legacy address key still resolves (no regression for older installs)" \
	|| no "legacy key ignored: [$got]"

# 5. the second config file is consulted too (settings live in either).
got="$(resolve "" "MORPHIT_INSTANCE_I2P_B32_ADDRESS=$OWN_B32")"
[ "$got" = "$OWN_B32" ] \
	&& ok "the address is found in morphit.env as well as morphit.config.env" \
	|| no "not found in the alternate config file: [$got]"

# 6. name ONLY, no b32 — must resolve to nothing rather than to the name.
got="$(resolve "MORPHIT_INSTANCE_I2P_NAME_ADDRESS=$VANITY" "")"
[ -z "$got" ] \
	&& ok "a name with no b32 yields NO address (rather than an unusable one)" \
	|| no "a bare vanity name produced an address: [$got]"

# 7. quoted values must resolve (operators quote things).
got="$(resolve "MORPHIT_INSTANCE_I2P_B32_ADDRESS=\"$OWN_B32\"" "")"
[ "$got" = "$OWN_B32" ] && ok "a quoted value resolves" || no "quoted value broke resolution: [$got]"

# ── the vanity name must be ADVERTISED, not just stored ──────────────
# A name nobody learns is useless: it has to reach the on-chain registration and
# the instance's own API, alongside — never instead of — the b32.
inst="$(cat "$REPO/apps/indexer/src/api/instance.ts")"
case "$inst" in
	*i2p_b32*) ok "the API exposes the b32 (the address of record)" ;;
	*) no "the API does not expose the b32" ;;
esac
case "$inst" in
	*i2p_name*) ok "…and the vanity name as a SEPARATE field, not a replacement" ;;
	*) no "the vanity name has no field of its own" ;;
esac
alt="$(cat "$REPO/apps/ops-cli/src/commands/altAddress.ts")"
case "$alt" in
	*MORPHIT_INSTANCE_I2P_NAME_ADDRESS*) ok "the wizard writes the name to its own key" ;;
	*) no "the wizard has no key for the vanity name" ;;
esac
case "$alt" in
	*"i2p_name"*"DOMAIN.i2p"*) ok "…and prompts for a DOMAIN.i2p, not a b32" ;;
	*) no "the wizard does not distinguish a name from a b32" ;;
esac

# ── an imported I2P key must be VERIFIED, not just length-checked ────
# Importing was validated by a length hint, and only for Tor — an I2P key got no
# check at all, so the wrong file imported silently and surfaced much later as
# "peers cannot reach this box". A length check cannot tell a correct key from a
# plausible wrong one; deriving the address the key ACTUALLY hosts can.
cat > "$WORK/derive.ts" <<TS
import { inspectI2pKeyFile } from '$REPO/apps/ops-cli/src/lib/i2pDestination.ts';
import { createHash, randomBytes } from 'node:crypto';
function destOnly(): Buffer {
  const cert = Buffer.alloc(7); cert[0] = 5; cert.writeUInt16BE(4, 1); cert.writeUInt16BE(7, 3);
  return Buffer.concat([randomBytes(256), randomBytes(128), cert]);
}
function makeKey(certLen: number): Buffer {
  const cert = Buffer.alloc(3 + certLen);
  cert[0] = 5; cert.writeUInt16BE(certLen, 1);
  return Buffer.concat([randomBytes(256), randomBytes(128), cert, randomBytes(96)]);
}
const out: string[] = [];
const k = makeKey(4);
const a = inspectI2pKeyFile(k);
out.push('shape:' + String(a.address !== null && a.address.length === 60 && a.address.endsWith('.b32.i2p')));
out.push('deterministic:' + String(inspectI2pKeyFile(k).address === a.address));
out.push('distinct:' + String(inspectI2pKeyFile(makeKey(4)).address !== a.address));
out.push('rejects-short:' + String(inspectI2pKeyFile(Buffer.alloc(100)).address === null));
out.push('rejects-text:' + String(inspectI2pKeyFile(Buffer.from('x'.repeat(600))).address === null));
out.push('accepts-base64:' + String(inspectI2pKeyFile(Buffer.from(makeKey(4).toString('base64'))).address !== null));
out.push('accepts-i2p-alphabet:' + String(inspectI2pKeyFile(Buffer.from(makeKey(4).toString('base64').replace(/\+/g, '-').replace(/\//g, '~'))).address !== null));
out.push('flags-destination-only:' + String(inspectI2pKeyFile(destOnly()).destinationOnly === true));
out.push('full-key-not-flagged:' + String(inspectI2pKeyFile(makeKey(4)).destinationOnly === false));
out.push('certlen-honoured:' + String(inspectI2pKeyFile(makeKey(0)).destinationBytes === 387 && inspectI2pKeyFile(makeKey(7)).destinationBytes === 394));
console.log(out.join(' '));
TS
res="$(cd "$REPO" && timeout 160 "$REPO/node_modules/.bin/tsx" --tsconfig "$REPO/tsconfig.smoke.json" "$WORK/derive.ts" 2>&1 | tail -1)"
for prop in shape deterministic distinct rejects-short rejects-text certlen-honoured accepts-base64 accepts-i2p-alphabet flags-destination-only full-key-not-flagged; do
	case "$res" in
		*"$prop:true"*) ok "i2p key derivation: $prop" ;;
		*) no "i2p key derivation FAILED: $prop  (got: $(printf '%s' "$res" | cut -c1-70))" ;;
	esac
done

# A real i2pd private key is 679 bytes — the size Morphit's OWN installer writes
# (render.ts: "679-byte private-keys blob"). A key of that size must be accepted
# as a private key, never mistaken for a bare destination.
cat > "$WORK/real.ts" <<TS
import { inspectI2pKeyFile } from '$REPO/apps/ops-cli/src/lib/i2pDestination.ts';
import { randomBytes } from 'node:crypto';
const cert = Buffer.alloc(7); cert[0] = 5; cert.writeUInt16BE(4, 1); cert.writeUInt16BE(7, 3);
const dest = Buffer.concat([randomBytes(256), randomBytes(128), cert]);   // 391
const key679 = Buffer.concat([dest, randomBytes(679 - dest.length)]);      // 679 exactly
const r = inspectI2pKeyFile(key679);
const b64 = inspectI2pKeyFile(Buffer.from(key679.toString('base64')));
console.log('bytes:' + key679.length + ' destOnly:' + r.destinationOnly + ' addr:' + (r.address !== null) +
  ' b64chars:' + key679.toString('base64').length + ' b64destOnly:' + b64.destinationOnly);
TS
rr="$(cd "$REPO" && timeout 160 node_modules/.bin/tsx --tsconfig tsconfig.smoke.json "$WORK/real.ts" 2>&1 | tail -1)"
case "$rr" in
	*"bytes:679"*"destOnly:false"*"addr:true"*) ok "a REAL 679-byte i2pd key is accepted as a private key" ;;
	*) no "a 679-byte key was not accepted: $(printf '%s' "$rr" | cut -c1-60)" ;;
esac
case "$rr" in
	*"b64chars:908"*"b64destOnly:false"*) ok "…and the same key as 908 base64 characters too" ;;
	*) no "the base64 form of a real key was misread: $(printf '%s' "$rr" | cut -c1-60)" ;;
esac

imp="$(cat "$REPO/apps/ops-cli/src/commands/importAltnetKey.ts")"
case "$imp" in
	*"This key hosts:"*) ok "the import SHOWS which address the key hosts" ;;
	*) no "the import does not show the derived address" ;;
esac
case "$imp" in
	*"Your config advertises a DIFFERENT address"*)
		ok "…and warns when it disagrees with the advertised address" ;;
	*) no "a key/config disagreement is not reported" ;;
esac
case "$imp" in
	*"readConfiguredI2pAddress"*) ok "…comparing against the address KEY, not any b32 in the file" ;;
	*) no "the comparison is not key-scoped" ;;
esac
# Storage must stay as tight as the relay credential: 0700 dir, 0600 envelope.
case "$imp" in
	*"chmodSync(altDir, 0o700)"*) ok "the keystore directory is 0700" ;;
	*) no "the keystore directory is not 0700" ;;
esac
case "$imp" in
	*"chmodSync(outPath, 0o600)"*) ok "the encrypted key file is 0600" ;;
	*) no "the key file is not 0600" ;;
esac

# ── the registration must SHOW what it is about to publish ───────────
# The addresses were carried into the payload but never displayed, so an
# operator confirmed a PERMANENT on-chain op without seeing which addresses it
# announced. That is how an instance published a stale .b32.i2p its router no
# longer hosted: the confirmation prompt — the one moment to catch it — showed
# nothing. Peers reach you at whatever the op says.
reg="$(cat "$REPO/apps/ops-cli/src/commands/register.ts")"
case "$reg" in
	*"Alt addresses (peers will use these"*)
		ok "the registration preview SHOWS the alt addresses before signing" ;;
	*) no "the preview does not show what addresses the op will publish" ;;
esac
for field in "'Tor'" "'I2P (b32)'" "'I2P (name)'" "'Lokinet'"; do
	case "$reg" in
		*"$field"*) ok "  …including $field" ;;
		*) no "  …$field is not shown" ;;
	esac
done
# It must show them, not merely compute them: the payload already did that.
case "$reg" in
	*"altPresent.length > 0"*) ok "  …and only when at least one is configured" ;;
	*) no "  …the display is not conditional on any being set" ;;
esac

echo ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m✗ %d alt-address check(s) failed\033[0m (%d passed)\n' "$fails" "$pass"; exit 1
fi
printf '\033[32m✓ all %d alt-address checks passed\033[0m\n' "$pass"
