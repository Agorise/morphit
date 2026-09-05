#!/usr/bin/env tsx
/**
 * Smoke for the identicon `<img src>` data URI format.
 *
 * Background — the "2 broken images on onboarding review" bug
 * (cp249):
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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identiconSvg, identiconDataUri, identiconDataUriFromString } from '../src/lib/crypto/identicon.ts';

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
const identiconSrc = readFileSync(
	join(REPO_ROOT, 'apps/web/src/lib/crypto/identicon.ts'),
	'utf-8'
);
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
	check('IdentityLabel seeds the account via seedBytesFromString', /seedBytesFromString\(account\)/.test(idLabel));
	check(
		'IdentityLabel does not raw-UTF8-encode the account seed',
		!/new TextEncoder\(\)\.encode\(account\)/.test(idLabel)
	);
}

// ── Report ───────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(`identicon-data-uri-smoke: FAIL (${failures.length}/${checks})`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log(`✓ all ${checks} identicon-data-uri-smoke scenarios passed`);
