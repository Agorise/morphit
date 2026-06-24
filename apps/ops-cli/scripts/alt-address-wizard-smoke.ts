/**
 * alt-address-wizard-smoke (cp216).
 *
 * The alt-address wizard writes an operator-chosen string into
 * morphit.config.env, so its address VALIDATORS are the correctness boundary
 * (a wrong-network or malformed value would show a dead pill in the footer).
 * This pins the pure validators + the per-network wiring maps, plus structural
 * checks that the wizard is reachable and that the two generator scripts this
 * checkpoint FIXED stay fixed (i2pd-tools `vain` single-arg form; no
 * non-existent `lokinet-vanity`).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	type AltNet,
	validateAltAddress,
	normalizeAltAddress,
	isValidOnion,
	isValidLoki,
	isValidI2pB32,
	isValidI2pName,
	validateI2pName,
	ENV_KEY,
	GEN_SCRIPT,
	SUPPORTS_VANITY_PREFIX
} from '../src/lib/altAddressValidate.ts';
import { validateNostr } from '../src/commands/altAddress.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPS = join(__dirname, '..');
const REPO = join(__dirname, '..', '..', '..');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

// Real-format sample addresses (56 base32 onion; 52 base32z loki; 52 base32 b32).
const ONION = 'vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion';
const LOKI = '7okic5x5do3uh3usttnqz9ek3uuoemdrwzto1hciwim9f947or6y.loki';
const I2P = 'ggucqf2jmtfxcw7us5sts3x7u2qljseocfzlhzebfpihkyvhcqfa.b32.i2p';

// ── Valid addresses validate + normalize to themselves ───────────────
for (const [net, addr] of [
	['tor', ONION],
	['lokinet', LOKI],
	['lokinet', 'morphit.loki'], // an ONS-style readable name is also accepted
	['i2p', I2P]
] as [AltNet, string][]) {
	const r = validateAltAddress(net, addr);
	if (r.ok && r.value === addr) ok(`valid ${net}: ${addr.slice(0, 18)}…`);
	else bad(`valid ${net} should pass: ${addr}`, JSON.stringify(r));
}

// ── Normalization: scheme / trailing slash / case are cleaned ─────────
{
	const r = validateAltAddress('tor', `  HTTP://${ONION.toUpperCase()}/  `);
	if (r.ok && r.value === ONION) ok('tor address normalized (scheme/slash/case stripped)');
	else bad('tor normalization', JSON.stringify(r));
	if (normalizeAltAddress('  Https://Foo.B32.I2P// ') === 'foo.b32.i2p')
		ok('normalizeAltAddress lowercases + strips scheme + trailing slashes');
	else bad('normalizeAltAddress', normalizeAltAddress('  Https://Foo.B32.I2P// '));
}

// ── Rejections: empty, wrong suffix, cross-network confusion ──────────
const REJECT: [AltNet, string, string][] = [
	['tor', '', 'empty'],
	['tor', 'foo.onion', 'too short for v3'],
	['tor', I2P, 'i2p address under tor'],
	['tor', LOKI, 'loki address under tor'],
	['i2p', '', 'empty'],
	['i2p', ONION, 'onion address under i2p'],
	['i2p', 'short.b32.i2p', 'too short b32'],
	['lokinet', '', 'empty'],
	['lokinet', ONION, 'onion address under lokinet'],
	['lokinet', 'no-suffix-here', 'missing .loki']
];
for (const [net, addr, why] of REJECT) {
	const r = validateAltAddress(net, addr);
	if (!r.ok) ok(`reject ${net} (${why})`);
	else bad(`reject ${net} (${why}) should fail`, JSON.stringify(r));
}

// ── Per-validator spot checks ────────────────────────────────────────
if (isValidOnion(ONION) && !isValidOnion(I2P)) ok('isValidOnion accepts onion, rejects i2p');
else bad('isValidOnion');
if (isValidLoki(LOKI) && isValidLoki('morphit.loki') && !isValidLoki(ONION)) ok('isValidLoki accepts loki + ONS name, rejects onion');
else bad('isValidLoki');
if (isValidI2pB32(I2P) && !isValidI2pB32(ONION)) ok('isValidI2pB32 accepts b32, rejects onion');
else bad('isValidI2pB32');
if (
	isValidI2pName('morphit.i2p') &&
	isValidI2pName('shop.morphit.i2p') &&
	!isValidI2pName(I2P) &&
	!isValidI2pName(ONION)
)
	ok('isValidI2pName accepts DOMAIN.i2p (incl. subdomains), rejects .b32.i2p + onion');
else bad('isValidI2pName');
{
	const good = validateI2pName('  HTTP://Morphit.I2P/ ');
	if (good.ok && good.value === 'morphit.i2p')
		ok('validateI2pName normalizes scheme/case/slash → morphit.i2p');
	else bad('validateI2pName normalize', JSON.stringify(good));
	if (!validateI2pName(I2P).ok)
		ok('validateI2pName rejects the .b32.i2p hash form (belongs in the b32 slot)');
	else bad('validateI2pName should reject b32');
	if (!validateI2pName('not a host').ok && !validateI2pName('').ok)
		ok('validateI2pName rejects garbage + empty');
	else bad('validateI2pName garbage/empty');
}

// ── Wiring maps ──────────────────────────────────────────────────────
{
	const expectEnv: Record<AltNet, string> = {
		tor: 'MORPHIT_INSTANCE_TOR_ADDRESS',
		lokinet: 'MORPHIT_INSTANCE_LOKINET_ADDRESS',
		i2p: 'MORPHIT_INSTANCE_I2P_B32_ADDRESS'
	};
	let allEnv = true;
	for (const net of ['tor', 'lokinet', 'i2p'] as AltNet[]) {
		if (ENV_KEY[net] !== expectEnv[net]) {
			allEnv = false;
			bad(`ENV_KEY[${net}]`, `${ENV_KEY[net]} !== ${expectEnv[net]}`);
		}
	}
	if (allEnv) ok('ENV_KEY maps each network to its config var (i2p → I2P_B32, → footer i2p_b32)');

	if (
		GEN_SCRIPT.tor === 'scripts/generate-onion.sh' &&
		GEN_SCRIPT.i2p === 'scripts/generate-i2p.sh' &&
		GEN_SCRIPT.lokinet === 'scripts/generate-lokinet.sh'
	)
		ok('GEN_SCRIPT maps each network to its helper script');
	else bad('GEN_SCRIPT map', JSON.stringify(GEN_SCRIPT));

	if (SUPPORTS_VANITY_PREFIX.tor && SUPPORTS_VANITY_PREFIX.i2p && !SUPPORTS_VANITY_PREFIX.lokinet)
		ok('SUPPORTS_VANITY_PREFIX: tor+i2p yes, lokinet no (honest)');
	else bad('SUPPORTS_VANITY_PREFIX map', JSON.stringify(SUPPORTS_VANITY_PREFIX));
}

// ── Structural wiring: wizard reachable ──────────────────────────────
{
	const mainSrc = readFileSync(join(OPS, 'src', 'main.ts'), 'utf8');
	if (/import \{ runAltAddress \}/.test(mainSrc)) ok('WIRE main.ts imports runAltAddress');
	else bad('WIRE main.ts import', 'no runAltAddress import');
	if (/args\.subcommand === 'alt-address'/.test(mainSrc)) ok("WIRE main.ts dispatches 'alt-address'");
	else bad('WIRE main.ts dispatch', "no 'alt-address' case");

	const menuSrc = readFileSync(join(OPS, 'src', 'commands', 'mainMenu.ts'), 'utf8');
	if (/subcommand: 'alt-address'/.test(menuSrc)) ok('WIRE mainMenu.ts has an alt-address item');
	else bad('WIRE mainMenu.ts', 'no alt-address menu item');
}

// ── The three generator scripts exist + the two FIXED ones stay fixed ─
{
	for (const rel of Object.values(GEN_SCRIPT)) {
		if (existsSync(join(REPO, rel))) ok(`script exists: ${rel}`);
		else bad(`missing script: ${rel}`);
	}

	const i2pSrc = readFileSync(join(REPO, 'scripts', 'generate-i2p.sh'), 'utf8');
	// Fixed: real `vain <prefix>` form (no fabricated `-t N <prefix> <outfile>`),
	// recursive clone (submodules), and it derives the address from private.dat.
	if (!/vain\s+-t/.test(i2pSrc)) ok('generate-i2p.sh: no bogus `vain -t …` invocation');
	else bad('generate-i2p.sh still uses `vain -t …`');
	if (/--recursive/.test(i2pSrc)) ok('generate-i2p.sh: clones i2pd-tools --recursive (submodules)');
	else bad('generate-i2p.sh', 'missing --recursive clone');
	if (/private\.dat/.test(i2pSrc)) ok('generate-i2p.sh: reads private.dat (real vain output)');
	else bad('generate-i2p.sh', 'no private.dat handling');

	const lokiSrc = readFileSync(join(REPO, 'scripts', 'generate-lokinet.sh'), 'utf8');
	// Fixed: the non-existent `lokinet-vanity` tool is gone; honest keyfile + ONS.
	if (!/lokinet-vanity/.test(lokiSrc)) ok('generate-lokinet.sh: no non-existent `lokinet-vanity` tool');
	else bad('generate-lokinet.sh still references lokinet-vanity');
	if (/keyfile=/.test(lokiSrc) && /ONS/.test(lokiSrc)) ok('generate-lokinet.sh: honest keyfile= setup + ONS naming');
	else bad('generate-lokinet.sh', 'missing keyfile=/ONS guidance');
}

// ── cp311: Nostr pubkey validation ───────────────────────────────────
{
	const NPUB = 'npub1' + 'q'.repeat(58); // matches /^npub1[a-z0-9]{58,}$/i
	const HEX = 'a'.repeat(64);
	const rNpub = validateNostr(NPUB);
	if (rNpub.ok && rNpub.value === NPUB) ok('validateNostr accepts npub1…');
	else bad('validateNostr npub', JSON.stringify(rNpub));

	const rHex = validateNostr(HEX.toUpperCase());
	if (rHex.ok && rHex.value === HEX) ok('validateNostr accepts 64-hex (lowercased)');
	else bad('validateNostr hex', JSON.stringify(rHex));

	const rNsec = validateNostr('nsec1' + 'q'.repeat(58));
	if (!rNsec.ok && /PRIVATE/.test(rNsec.reason)) ok('validateNostr REJECTS nsec… (private key) with a warning');
	else bad('validateNostr nsec', JSON.stringify(rNsec));

	if (!validateNostr('npub1short').ok) ok('validateNostr rejects too-short npub');
	else bad('validateNostr too-short npub should fail');
	if (!validateNostr('hello world').ok) ok('validateNostr rejects garbage');
	else bad('validateNostr garbage should fail');
}

// ── cp311: alt-address CRUD shape (show / clear / nostr / i2p dual-key) ─
{
	const altSrc = readFileSync(join(OPS, 'src', 'commands', 'altAddress.ts'), 'utf8');
	if (/Current:/.test(altSrc)) ok('CRUD: shows the current value before acting');
	else bad('CRUD show-current', 'no "Current:" display');
	if (/Delete it|removed from/.test(altSrc)) ok('CRUD: has a delete/clear path');
	else bad('CRUD delete', 'no delete path');
	if (/Back \(pick a different address\)/.test(altSrc)) ok('CRUD: per-address Back to the parent list');
	else bad('CRUD back', 'no Back option');
	if (/Nostr \(npub/.test(altSrc) && /collectNostr/.test(altSrc)) ok('CRUD: Nostr is a managed address');
	else bad('CRUD nostr', 'nostr not wired into the menu');
	// i2p must read/clear BOTH the modern + legacy keys (indexer reads both).
	if (/MORPHIT_INSTANCE_I2P_ADDRESS/.test(altSrc) && /ENV_KEY\.i2p/.test(altSrc))
		ok('CRUD: i2p keeps modern + legacy env keys in sync');
	else bad('CRUD i2p dual-key', 'legacy i2p key not handled');
	// Vanity i2p_name is a parallel managed slot (like nostr) with its own key.
	if (/i2p_name: \['MORPHIT_INSTANCE_I2P_NAME_ADDRESS'\]/.test(altSrc) && /collectI2pName/.test(altSrc))
		ok('CRUD: i2p vanity name is a managed slot (→ _I2P_NAME_ADDRESS, collectI2pName)');
	else bad('CRUD i2p vanity', 'i2p_name slot not wired into altAddress.ts');
}

// ── edit menu alt-networks must be keep-current (data-loss regression) ──
// Guards the bug where editing one alt address via the main `edit` menu
// wiped the others: skipping Tor (because it was already set) returned null
// from the wizard and we overwrote the configured onion with null. The fix
// routes each field through editField (Enter keeps, "-" clears) and writes a
// key only when that field actually changed.
{
	const editSrc = readFileSync(join(OPS, 'src', 'commands', 'edit.ts'), 'utf8');
	const start = editSrc.indexOf("choice === 'alt-networks'");
	const end = editSrc.indexOf("choice === 'seo'");
	const altSection = start >= 0 && end > start ? editSrc.slice(start, end) : '';
	if (altSection.length === 0) {
		bad('edit menu alt-networks section', 'could not locate the alt-networks branch');
	} else {
		if (!/configUpdates\.set\('MORPHIT_INSTANCE_TOR_ADDRESS', alt\.tor\)/.test(altSection))
			ok('edit menu: no unconditional alt-network overwrite (keep-current)');
		else bad('edit menu alt-networks', 'still unconditionally overwrites — skipping a field wipes it');
		const keys = [
			'MORPHIT_INSTANCE_TOR_ADDRESS',
			'MORPHIT_INSTANCE_LOKINET_ADDRESS',
			'MORPHIT_INSTANCE_I2P_B32_ADDRESS',
			'MORPHIT_INSTANCE_I2P_NAME_ADDRESS',
			'MORPHIT_INSTANCE_NOSTR_PUBKEY'
		];
		const allGated = keys.every((k) =>
			new RegExp(`\\.changed\\)[\\s\\S]{0,80}configUpdates\\.set\\('${k}'`).test(altSection)
		);
		if (allGated) ok('edit menu: every alt-network key written only when changed');
		else bad('edit menu alt-networks', 'an alt key is set without a .changed guard');
		if (/await editField\(/.test(altSection))
			ok('edit menu: alt-networks uses keep-current editField prompts');
		else bad('edit menu alt-networks', 'not using editField keep-current prompts');
		// Two-slot i2p: the menu writes the modern split keys + offers a vanity prompt.
		if (
			/MORPHIT_INSTANCE_I2P_B32_ADDRESS/.test(altSection) &&
			/MORPHIT_INSTANCE_I2P_NAME_ADDRESS/.test(altSection)
		)
			ok('edit menu: i2p writes modern b32 + vanity keys');
		else bad('edit menu i2p', 'not writing the modern split i2p keys');
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 alt-address-wizard smoke FAILED');
	process.exit(1);
}
console.log('\u2713 alt-address validators reject cross-network + malformed input; wizard wired; generator scripts fixed');
console.log(`\u2713 all ${pass} alt-address-wizard scenarios passed`);
