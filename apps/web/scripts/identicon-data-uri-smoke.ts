#!/usr/bin/env tsx
/**
 * Smoke for the identicon `<img src>` data URI format.
 *
 * Background — the "2 broken images on onboarding review" bug:
 *
 *
 *   The heart identicon (`apps/web/src/lib/crypto/identicon.ts`) is a
 *   pure-SVG avatar rendered into an `<img src="data:...">`. The SVG
 *   itself is valid and renders fine in isolation, BUT it was emitted
 *   as a *percent-encoded* data URI (`data:image/svg+xml,<encoded>`).
 *   WebKit/Safari renders percent-encoded `image/svg+xml,` URIs in
 *   <img> unreliably — the exact "valid SVG, valid URI, broken-image
 *   icon" failure mode the onboarding review page hit (it shows two
 *   prominent identicons: the 96px avatar and the IdentityLabel
 *   identicon). The fix: emit a **base64** data URI, which renders
 *   consistently across Chromium, Gecko, and WebKit.
 *
 * This smoke guards the fix two ways:
 *
 *   1. Behavioural — `identiconDataUri()` must return a
 *      `data:image/svg+xml;base64,` URI whose payload decodes back to
 *      exactly the `identiconSvg()` markup, for a spread of seeds
 *      (including short and empty inputs).
 *   2. Source-level — `identicon.ts` must not regress to the
 *      percent-encoded form (`image/svg+xml,${encodeURIComponent`).
 *
 * No browser, no resvg dependency — base64 decode + well-formedness
 * checks are enough to catch a regression in the encoding.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	identiconSvg,
	identiconDataUri,
	identiconDataUriFromString
} from '../src/lib/crypto/identicon.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const B64_PREFIX = 'data:image/svg+xml;base64,';

const failures: string[] = [];
let checks = 0;

function check(label: string, cond: boolean, detail = ''): void {
	checks++;
	if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. Behavioural: format + decode round-trip across seeds ──────────
// A spread of inputs: a 33-byte secp256k1-shaped key, a tiny input,
// a single byte, an all-zero key, and an empty array (the
// IdentityLabel "no identity given" fallback path uses zero bytes).
const seeds: Array<{ name: string; bytes: Uint8Array }> = [
	{
		name: '33-byte key',
		bytes: Uint8Array.from({ length: 33 }, (_, i) => (i * 37 + 11) & 0xff)
	},
	{ name: '3-byte', bytes: new Uint8Array([1, 2, 3]) },
	{ name: '1-byte', bytes: new Uint8Array([200]) },
	{ name: 'all-zero 8-byte', bytes: new Uint8Array(8) },
	{ name: 'empty', bytes: new Uint8Array(0) }
];

for (const { name, bytes } of seeds) {
	const uri = identiconDataUri(bytes, 96);

	check(`[${name}] base64 prefix`, uri.startsWith(B64_PREFIX), uri.slice(0, 40));
	check(
		`[${name}] not percent-encoded`,
		!uri.startsWith('data:image/svg+xml,'),
		'percent-encoded form is WebKit-unreliable'
	);
	// A `#` appearing raw in the URI would mean an unencoded fragment
	// (the bug the base64/percent dance exists to avoid). base64 has
	// no `#`; assert it stays that way.
	check(`[${name}] no raw '#'`, !uri.includes('#'));

	const payload = uri.slice(B64_PREFIX.length);
	let decoded = '';
	try {
		decoded = Buffer.from(payload, 'base64').toString('utf-8');
	} catch (e) {
		check(`[${name}] base64 decodes`, false, String(e));
		continue;
	}

	check(`[${name}] decodes to identiconSvg`, decoded === identiconSvg(bytes, 96));
	check(`[${name}] decoded starts <svg`, decoded.startsWith('<svg'));
	check(`[${name}] decoded ends </svg>`, decoded.trimEnd().endsWith('</svg>'));
	// No stringified NaN/undefined leaked into the markup (would mean a
	// bad fill/coord — renders as a corrupt or partly-blank avatar).
	check(`[${name}] no NaN in markup`, !decoded.includes('NaN'));
	check(`[${name}] no undefined in markup`, !decoded.includes('undefined'));
}

// ── 2. Source-level: identicon.ts must use base64, not percent ───────
const identiconSrc = readFileSync(join(REPO_ROOT, 'apps/web/src/lib/crypto/identicon.ts'), 'utf-8');
check(
	'source uses ;base64, data URI',
	identiconSrc.includes('data:image/svg+xml;base64,'),
	'identiconDataUri must emit a base64 data URI'
);
check(
	'source does NOT percent-encode the data URI',
	!/data:image\/svg\+xml,\$\{encodeURIComponent/.test(identiconSrc),
	'reverting to percent-encoding reintroduces the WebKit broken-image bug'
);

// ── v1.16.4 regression: shared-prefix STRING seeds must not collide ──
// Raw UTF-8 bytes made "morphit" / "morphitir" / "morphitlat" render three
// near-identical hearts on the operators page — they share their first 7 bytes
// and the identicon reads bytes[0..7]. The string seed is now avalanche-hashed
// (identicon.ts stringSeedBytes) so any change anywhere in the name diverges.
{
	const prefixSeeds = ['morphit', 'morphitir', 'morphitlat', 'morphittime', 'time', 'agorise'];
	const uris = prefixSeeds.map((s) => identiconDataUriFromString(s));
	const distinct = new Set(uris).size;
	check(
		`shared-prefix string seeds produce distinct identicons (${distinct}/${prefixSeeds.length})`,
		distinct === prefixSeeds.length,
		`collision among: ${prefixSeeds.join(', ')}`
	);
	check(
		'the operators-page trio (morphit / morphitir / morphitlat) all differ',
		new Set([
			identiconDataUriFromString('morphit'),
			identiconDataUriFromString('morphitir'),
			identiconDataUriFromString('morphitlat')
		]).size === 3
	);
	// v1.16.5 — pin the ACTUAL render path. IdentityLabel (operators page, order
	// rows, profiles, explorer…) seeds its identicon itself; a fix to
	// identiconDataUriFromString alone does NOT reach it (the v1.16.4 miss). Assert
	// it routes the account name through the shared hasher, never raw UTF-8.
	const idLabel = readFileSync(
		join(__dirname, '..', 'src', 'lib', 'components', 'IdentityLabel.svelte'),
		'utf8'
	);
	check(
		'IdentityLabel seeds the account via seedBytesFromString',
		/seedBytesFromString\(account\)/.test(idLabel)
	);
	check(
		'IdentityLabel does not raw-UTF8-encode the account seed',
		!/new TextEncoder\(\)\.encode\(account\)/.test(idLabel)
	);
}

// ── v1.21.21: ONE heart per account, on every surface ─────────────────
// The v1.16.5 switch to the hashed name seed reached IdentityLabel and the
// header menu but not the profile page's hero or the explorer, which kept the
// raw UTF-8 bytes — so @classx's profile page showed a different heart than
// the header. Every identicon in the app is checked here, not one component:
// a NAME reaches an identicon only through the hashed seed
// (identiconDataUriFromString / seedBytesFromString); raw bytes are allowed
// only for a posting key, before an account name exists (onboarding).
{
	const webSrc = join(__dirname, '..', 'src');
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(svelte|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
		}
	};
	walk(webSrc);

	/**
	 * The identicon calls in one source file that are not one-heart-per-account:
	 * a raw-bytes identicon (identiconDataUri / identiconSvg) whose seed is not
	 * the hashed name (seedBytes from seedBytesFromString, or
	 * seedBytesFromString(…) itself) or a posting key before a name exists
	 * (live.posting.publicKey); the raw function used in any way but a direct
	 * call (an alias import, a namespace import, passed as a value) — the
	 * call-site check could not see what it is fed; or any TextEncoder in a
	 * file that draws a raw-bytes identicon.
	 */
	function identiconOffenders(src: string): { sites: number; offenders: string[] } {
		// Comments say the names too; only code counts.
		const code = src
			.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1')
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
		const offenders: string[] = [];
		let sites = 0;
		const RAW = '(?:identiconDataUri|identiconSvg)(?!FromString)';
		for (const imp of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\$crypto\/identicon['"]/g)) {
			if (new RegExp(`\\b${RAW}\\s+as\\b`).test(imp[1]!)) offenders.push(`alias import: ${imp[0]}`);
		}
		if (/import\s*\*\s*as\s+\w+\s+from\s*['"]\$crypto\/identicon['"]/.test(code)) {
			offenders.push('namespace import of $crypto/identicon');
		}
		const SEED_OK =
			/^(?:seedBytes\b(?!FromString)|seedBytesFromString\s*\(|live\.posting\.publicKey\b)/;
		let raw = 0;
		for (const m of code.matchAll(new RegExp(`(?<![\\w.$])${RAW}\\b(\\s*\\()?`, 'g'))) {
			const at = m.index!;
			// The import line itself.
			if (/import\s*\{[^}]*$/.test(code.slice(Math.max(0, at - 200), at))) continue;
			if (!m[1]) {
				offenders.push(`used as a value: …${code.slice(at, at + 40)}`);
				continue;
			}
			sites++;
			raw++;
			const arg = code.slice(at + m[0].length).trimStart();
			if (!SEED_OK.test(arg))
				offenders.push(`seeded with: ${m[0]}${arg.slice(0, 40)}`.replace(/\s+/g, ' '));
		}
		for (const m of code.matchAll(/(?<![\w.$])identiconDataUriFromString\s*\(/g)) (void m, sites++);
		if (raw > 0 && /\bTextEncoder\b/.test(code))
			offenders.push('TextEncoder next to a raw-bytes identicon');
		if (
			/\bseedBytes\b(?!FromString)/.test(code) &&
			raw > 0 &&
			!/seedBytesFromString\s*\(/.test(code)
		) {
			offenders.push('a seedBytes that is not from seedBytesFromString');
		}
		return { sites, offenders };
	}

	// The check catches what it is for (seen failing on purpose) …
	const EVASIONS: Record<string, string> = {
		'raw name bytes': `const a = identiconDataUri(new TextEncoder().encode(account), 96);`,
		'alias import': `import { identiconDataUri as idu } from '$crypto/identicon';\nconst a = idu(new TextEncoder().encode(peer));`,
		'namespace import': `import * as ic from '$crypto/identicon';\nconst a = ic.identiconDataUri(x);`,
		'space before (': `const a = identiconDataUri (new TextEncoder().encode(name));`,
		'passed as a value': `const all = names.map(seedBytesFromString).map(identiconDataUri);`,
		'a variable called bytes': `const bytes = new TextEncoder().encode(op.account);\nconst a = identiconDataUri(bytes);`,
		'a seedBytes of raw bytes': `const seedBytes = new Uint8Array(Buffer.from(peer));\nconst a = identiconDataUri(seedBytes);`,
		identiconSvg: `const s = identiconSvg(enc.encode(peer), 40);`,
		// A '/*' inside a string is not a comment: it must not hide what follows.
		"a call after a '/*' in a string": `const accept = 'image/*';\nconst a = identiconDataUri(new TextEncoder().encode(account));\n/* a real comment */`
	};
	for (const [what, snippet] of Object.entries(EVASIONS)) {
		check(`the call-site check catches: ${what}`, identiconOffenders(snippet).offenders.length > 0);
	}
	// … and passes the right ways to draw one.
	const FINE: Record<string, string> = {
		'the hashed name': `import { identiconDataUriFromString } from '$crypto/identicon';\nconst a = identiconDataUriFromString(account, 96);`,
		'seedBytesFromString inline': `import { identiconDataUri, seedBytesFromString } from '$crypto/identicon';\nconst a = identiconDataUri(seedBytesFromString(account));`,
		'seedBytes from seedBytesFromString': `const seedBytes = $derived(seedBytesFromString(account));\nconst a = identiconDataUri(seedBytes, 40);`,
		'a posting key before a name': `const a = identiconDataUri(live.posting.publicKey, 96);`,
		'a comment that names it': `// identiconDataUri(new TextEncoder().encode(name)) was the bug\nconst a = identiconDataUriFromString(name);`
	};
	for (const [what, snippet] of Object.entries(FINE)) {
		const r = identiconOffenders(snippet);
		check(`the call-site check passes: ${what}`, r.offenders.length === 0, r.offenders.join(' | '));
	}

	const offenders: string[] = [];
	let sites = 0;
	for (const f of files) {
		if (f.endsWith(join('crypto', 'identicon.ts'))) continue;
		const r = identiconOffenders(readFileSync(f, 'utf8'));
		sites += r.sites;
		for (const o of r.offenders) offenders.push(`${f.slice(webSrc.length + 1)}: ${o}`);
	}
	// 4 raw-bytes calls (posting key / seedBytes) + 5 by name, today.
	check(`found the app's identicon call sites (${sites})`, sites >= 9);
	check(
		"no identicon is seeded from a name's raw bytes (one heart per account, everywhere)",
		offenders.length === 0,
		offenders.join(' | ')
	);
}

// ── Report ───────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(`identicon-data-uri-smoke: FAIL (${failures.length}/${checks})`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log(`✓ all ${checks} identicon-data-uri-smoke scenarios passed`);
