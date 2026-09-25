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

# ── THE KEY THAT GETS STORED, NOT JUST THE KEY THAT GETS CHECKED ─────
#
# The checks above prove the INSPECTOR reads a base64 key correctly. They said
# nothing about what the IMPORT then stored — and it stored the wrong thing.
# `inspectI2pKeyFile` decoded base64 to validate it; `import-altnet-key` then
# encrypted the ORIGINAL file. A base64 export passed every check, printed
# "✓ Valid I2P private key … This key hosts: <b32>", and was stored as base64
# TEXT. Exported back to i2pd, that text hosts nothing, and nothing says why.
#
# Verified against i2pd 2.49 before this was written: the 679-byte binary key
# i2pd generated hosts its address; the same key as 908 base64 characters hosts
# no destination at all. Accepting base64, which 1.17.15 added, is what made the
# path reachable — before that it was refused, loudly.
#
# So this drives the REAL `import-altnet-key` and the REAL `export-altnet-key`
# with a base64 key, and requires the bytes that come back out to be the BINARY
# key. When i2pd is installed it also asks i2pd itself which address it hosts
# from them, because "byte-identical to what we expected" is our claim and
# "i2pd serves it" is the property.
#
# The negative case runs against a COPY of ops-cli in $WORK, never the real
# source: a mutation restored from the wrong backup destroyed a core module in
# round fourteen, and a copy cannot do that.
I2P_KEY_DIR="$WORK/i2pkey"; mkdir -p "$I2P_KEY_DIR"
( cd "$REPO/apps/ops-cli" && npx tsx -e "
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
// Ed25519 destination: 256 enc + 128 sign + cert(type 5, len 4, 00 07 00 00), then
// the private half — 679 bytes, the size Morphit's installer and i2pd both write.
const cert = Buffer.from([5, 0, 4, 0, 7, 0, 0]);
const dest = Buffer.concat([randomBytes(256), randomBytes(128), cert]);
const key = Buffer.concat([dest, randomBytes(679 - dest.length)]);
writeFileSync('$I2P_KEY_DIR/key.bin', key);
writeFileSync('$I2P_KEY_DIR/key.b64', key.toString('base64'));
" ) >/dev/null 2>&1

# One passphrase per chunk: the prompt resolves at the first newline and drops
# the rest of the chunk, which is harmless at a keyboard and fatal in a pipe.
feed_once()  { ( sleep 1; printf 'harness passphrase\n' ); }
# Answer each prompt only once it has APPEARED in the command's own log. Fixed
# sleeps raced a cold `tsx` start: inside the smoke battery (which exports
# TSX_TSCONFIG_PATH, so the ops-cli COPY compiles cold) both passphrases arrived
# in one chunk before the first prompt existed. The prompt keeps the first line
# and drops the rest, so the confirmation waited for input that never came, the
# import wrote nothing — and three checks failed for a reason that had nothing
# to do with what they check. Standalone, the cache was warm and it passed.
feed_on() { # <log> <prompt label>...
	local log="$1"; shift
	( for label in "$@"; do
		for _ in $(seq 1 600); do grep -q "$label" "$log" 2>/dev/null && break; sleep 0.1; done
		printf 'harness passphrase\n'
	  done )
}

roundtrip() { # $1 = ops-cli dir to run   $2 = scratch root   → prints exported path
	local cli="$1" root="$2"
	rm -rf "$root"; mkdir -p "$root"
	feed_on "$root/import.log" 'Relay passphrase' 'Confirm passphrase' | ( cd "$cli" && npx tsx src/main.ts import-altnet-key --network=i2p \
		--in="$I2P_KEY_DIR/key.b64" --out="$root" ) >"$root/import.log" 2>&1
	feed_on "$root/export.log" 'Passphrase' | ( cd "$cli" && npx tsx src/main.ts export-altnet-key --network=i2p \
		--repo="$root" --out="$root/exported.dat" ) >"$root/export.log" 2>&1
	printf '%s' "$root/exported.dat"
}

# v1.18.0 (F38): export now REPAIRS a key an older import stored as base64 text,
# and says so. That makes "the exported bytes are binary" true whatever was
# stored, so on its own it no longer proves the import stores binary — the
# property moved. What still tells the two apart is the repair notice: a key
# stored correctly exports WITHOUT it.
LEGACY_NOTICE='stored as base64 text by an older morphit-ops'
exported="$(roundtrip "$REPO/apps/ops-cli" "$WORK/rt-real")"
if [ ! -s "$exported" ]; then
	no "the base64 import/export round trip produced no key: $(tail -2 "$WORK/rt-real/import.log" | tr '\n' ' ' | cut -c1-80)"
elif grep -q "$LEGACY_NOTICE" "$WORK/rt-real/export.log"; then
	no "the import STORED the base64 text — the export had to repair it (the notice printed)"
elif cmp -s "$exported" "$I2P_KEY_DIR/key.bin"; then
	ok "a key imported as base64 is stored — and exported — as the BINARY key i2pd loads"
else
	no "a base64 key came back as $(stat -c %s "$exported") bytes, not the 679-byte binary key — i2pd will host nothing"
fi

# i2pd's own verdict, when i2pd is here to give one. Skipped LOUDLY otherwise:
# a leg that silently passes when its tool is missing is how a check stops
# checking without anyone noticing.
if command -v i2pd >/dev/null 2>&1 && [ -s "$exported" ]; then
	d="$WORK/i2pd"; mkdir -p "$d/data"
	cp "$exported" "$d/data/k.dat"
	printf '[t]\ntype = http\nhost = 127.0.0.1\nport = 18089\nkeys = k.dat\n' > "$d/tunnels.conf"
	printf 'log = file\nlogfile = %s/i2pd.log\nloglevel = info\n[http]\nenabled = false\n[httpproxy]\nenabled = false\n[socksproxy]\nenabled = false\n[sam]\nenabled = false\n[reseed]\nverify = false\nurls =\n' "$d" > "$d/i2pd.conf"
	timeout 12 i2pd --datadir="$d/data" --conf="$d/i2pd.conf" --tunconf="$d/tunnels.conf" >/dev/null 2>&1
	hosted="$(grep -oE '[a-z2-7]{52}\.b32\.i2p' "$d/i2pd.log" 2>/dev/null | sort -u | head -1)"
	expect="$( cd "$REPO/apps/ops-cli" && npx tsx -e "
import { readFileSync } from 'node:fs';
import { inspectI2pKeyFile } from './src/lib/i2pDestination.ts';
process.stdout.write(inspectI2pKeyFile(readFileSync('$I2P_KEY_DIR/key.bin')).address ?? '');
" 2>/dev/null )"
	if [ -n "$hosted" ] && [ "$hosted" = "$expect" ]; then
		ok "  …and i2pd itself hosts the address the import promised ($(printf '%s' "$hosted" | cut -c1-12)…)"
	else
		no "  …i2pd hosts '${hosted:-nothing}' from the exported key; the import promised $expect"
	fi
else
	echo "  - i2pd not installed: skipped asking i2pd itself (the byte check above still ran)"
fi

# ── A BARE DESTINATION IS REFUSED BY THE COMMAND, NOT ONLY FLAGGED ───
#
# The inspector check above proves a 391-byte destination is RECOGNISED. What
# matters is that the import then REFUSES it and writes nothing — i2pd cannot
# host with a destination, so storing one would make the address silently never
# serve. This is the exact shape of the key that prompted the check: 391 bytes,
# 524 base64 characters, ending BQAEAAcAAA== (Ed25519 key certificate).
( cd "$REPO/apps/ops-cli" && npx tsx -e "
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const cert = Buffer.from([5, 0, 4, 0, 7, 0, 0]);
writeFileSync('$I2P_KEY_DIR/dest.b64', Buffer.concat([randomBytes(256), randomBytes(128), cert]).toString('base64'));
" ) >/dev/null 2>&1
DR="$WORK/dest-only"; rm -rf "$DR"; mkdir -p "$DR"
feed_once | ( cd "$REPO/apps/ops-cli" && npx tsx src/main.ts import-altnet-key --network=i2p \
	--in="$I2P_KEY_DIR/dest.b64" --out="$DR" ) >"$DR/log" 2>&1
dest_rc=$?
if [ "$dest_rc" -ne 0 ] && [ ! -e "$DR/apps/relay/altnet/i2p-key.json" ] && grep -q "PUBLIC address, not a private key" "$DR/log"; then
	ok "a 391-byte destination (524 base64 chars) is REFUSED by the import and nothing is written"
else
	no "a bare destination was not refused: exit=$dest_rc keystore=$( [ -e "$DR/apps/relay/altnet/i2p-key.json" ] && echo WRITTEN || echo none)"
fi

# NEGATIVE CASE — the fix reverted, on a COPY. Must fail, or the check above is
# not a check.
CPY="$WORK/cli-copy"; mkdir -p "$CPY/apps"
for a in "$REPO"/apps/*; do n="$(basename "$a")"; [ "$n" = ops-cli ] && continue; ln -s "$a" "$CPY/apps/$n"; done
cp -r "$REPO/apps/ops-cli" "$CPY/apps/ops-cli"; rm -rf "$CPY/apps/ops-cli/node_modules"
ln -s "$REPO/apps/ops-cli/node_modules" "$CPY/apps/ops-cli/node_modules"
ln -s "$REPO/node_modules" "$CPY/node_modules"; ln -s "$REPO/packages" "$CPY/packages"; cp "$REPO/package.json" "$CPY/"
MUT_TARGET="$CPY/apps/ops-cli/src/commands/importAltnetKey.ts"
if grep -q 'envelope = encryptAltKey(toStore, passphrase, net);' "$MUT_TARGET"; then
	sed -i 's/envelope = encryptAltKey(toStore, passphrase, net);/envelope = encryptAltKey(plaintext, passphrase, net);/' "$MUT_TARGET"
	bad_export="$(roundtrip "$CPY/apps/ops-cli" "$WORK/rt-mutant")"
	# Caught by the repair notice now, not the bytes (see LEGACY_NOTICE above).
	if [ -s "$bad_export" ] && grep -q "$LEGACY_NOTICE" "$WORK/rt-mutant/export.log"; then
		ok "MUTANT: storing the file instead of the decoded key IS caught (the export had to repair it)"
	else
		no "MUTANT: reverting the fix went unnoticed — the round-trip check guards nothing"
	fi

	# ── F38: A KEY 1.17.15 ALREADY STORED AS TEXT ──────────────────────
	# The mutant import above IS 1.17.15's importer: it validates the decoded
	# key and stores the original text. So its keystore is exactly what an
	# operator who imported a base64 key on 1.17.15 has on disk today. The
	# REAL export must hand i2pd the binary key from it, and say what it did.
	feed_on "$WORK/rt-mutant/legacy.log" 'Passphrase' | ( cd "$REPO/apps/ops-cli" && npx tsx src/main.ts export-altnet-key --network=i2p \
		--repo="$WORK/rt-mutant" --out="$WORK/rt-mutant/legacy-real.dat" ) >"$WORK/rt-mutant/legacy.log" 2>&1
	if cmp -s "$WORK/rt-mutant/legacy-real.dat" "$I2P_KEY_DIR/key.bin" && grep -q "$LEGACY_NOTICE" "$WORK/rt-mutant/legacy.log"; then
		ok "a key a 1.17.15 import stored as base64 TEXT exports as the binary key i2pd loads, and says so"
	else
		no "a 1.17.15-stored key exported as $(stat -c %s "$WORK/rt-mutant/legacy-real.dat" 2>/dev/null || echo 0) bytes — i2pd would host nothing"
	fi
	# …and that repair is a check only if removing it is caught. On the copy:
	# the import back as it was (irrelevant here), the export's repair off.
	EXP_TARGET="$CPY/apps/ops-cli/src/commands/exportAltnetKey.ts"
	if grep -q "	if (net === 'i2p') {" "$EXP_TARGET"; then
		sed -i "s/	if (net === 'i2p') {/	if (false) {/" "$EXP_TARGET"
		feed_on "$WORK/rt-mutant/legacy-mutant.log" 'Passphrase' | ( cd "$CPY/apps/ops-cli" && npx tsx src/main.ts export-altnet-key --network=i2p \
			--repo="$WORK/rt-mutant" --out="$WORK/rt-mutant/legacy-mutant.dat" ) >"$WORK/rt-mutant/legacy-mutant.log" 2>&1
		if [ -s "$WORK/rt-mutant/legacy-mutant.dat" ] && ! cmp -s "$WORK/rt-mutant/legacy-mutant.dat" "$I2P_KEY_DIR/key.bin"; then
			ok "MUTANT: an export that does not repair a 1.17.15 key IS caught ($(stat -c %s "$WORK/rt-mutant/legacy-mutant.dat") bytes out)"
		else
			no "MUTANT: removing the export repair went unnoticed"
		fi
	else
		no "MUTANT: the export repair changed shape; update this harness"
	fi
else
	no "MUTANT: the store line changed shape; update this harness (a mutation that does not apply is not a catch)"
fi
# The real source must be untouched by any of the above. Checked, not assumed.
if grep -q 'envelope = encryptAltKey(toStore, passphrase, net);' "$REPO/apps/ops-cli/src/commands/importAltnetKey.ts" \
	&& grep -q "	if (net === 'i2p') {" "$REPO/apps/ops-cli/src/commands/exportAltnetKey.ts"; then
	ok "the real importAltnetKey.ts and exportAltnetKey.ts were not modified by the negative cases"
else
	no "the REAL source was modified — the negative case escaped its copy"
fi

echo ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m✗ %d alt-address check(s) failed\033[0m (%d passed)\n' "$fails" "$pass"; exit 1
fi
printf '\033[32m✓ all %d alt-address checks passed\033[0m\n' "$pass"
