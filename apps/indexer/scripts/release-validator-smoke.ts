/**
 * Morphit smoke — release-payload validator (Batch J).
 *
 * Pure logic.  Mirrors the indexer's rejection reasons so any
 * release the indexer stores as valid passes here too.
 */

import { validateReleasePayload } from '@morphit/release-schema';
import { checkPinnedKeyInAuthority } from '@morphit/release-schema';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── release validator smoke ───────────────────────────────\n');

const VALID_HASH = 'sha256-' + 'a'.repeat(43) + '=';
const VALID_HASH_2 = 'sha256-' + 'b'.repeat(43) + '=';

function makePayload(over: Partial<Record<string, unknown>> = {}): unknown {
	return {
		version: '1.2.3',
		hash_manifest: { 'index.html': VALID_HASH },
		endpoints: { indexer: ['https://idx.example.com'] },
		...over
	};
}

// ─── happy path ─────────────────────────────────────────────────────

scenario('accepts a minimal valid payload', () => {
	const r = validateReleasePayload(makePayload());
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if (r.value.version !== '1.2.3') throw new Error('version');
});

scenario('accepts pre-release semver', () => {
	const r = validateReleasePayload(makePayload({ version: '1.0.0-rc.1' }));
	if (!r.ok) throw new Error(`got ${r.reason}`);
});

scenario('accepts build-metadata semver', () => {
	const r = validateReleasePayload(makePayload({ version: '1.0.0+build.42' }));
	if (!r.ok) throw new Error(`got ${r.reason}`);
});

scenario('accepts empty endpoints object', () => {
	const r = validateReleasePayload(makePayload({ endpoints: {} }));
	if (!r.ok) throw new Error(`got ${r.reason}`);
});

scenario('cp436 — accepts a payload with NO endpoints field (no longer pinned)', () => {
	const p = makePayload() as Record<string, unknown>;
	delete p.endpoints;
	const r = validateReleasePayload(p);
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if ('endpoints' in r.value) throw new Error('endpoints must be omitted from output when absent');
});

scenario('cp436 — still accepts a payload WITH endpoints (backward-compat)', () => {
	const r = validateReleasePayload(makePayload({ endpoints: { indexer: ['https://idx.example.com'] } }));
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if (!r.value.endpoints) throw new Error('endpoints should be preserved when present');
});

scenario('accepts optional signature', () => {
	const r = validateReleasePayload(makePayload({ signature: 'pgp-sig-blob' }));
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if (r.value.signature !== 'pgp-sig-blob') throw new Error('sig');
});

scenario('drops signature when undefined', () => {
	const r = validateReleasePayload(makePayload());
	if (!r.ok) throw new Error('expected ok');
	if (r.value.signature !== undefined) throw new Error('expected undefined');
});

// ─── payload shape ──────────────────────────────────────────────────

scenario('rejects null payload', () => {
	const r = validateReleasePayload(null);
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'payload_not_object') throw new Error(r.reason);
});

scenario('rejects array payload', () => {
	const r = validateReleasePayload([1, 2, 3]);
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'payload_not_object') throw new Error(r.reason);
});

scenario('rejects string payload', () => {
	const r = validateReleasePayload('hello');
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'payload_not_object') throw new Error(r.reason);
});

// ─── version ────────────────────────────────────────────────────────

scenario('rejects non-string version', () => {
	const r = validateReleasePayload(makePayload({ version: 123 }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'version_not_string') throw new Error(r.reason);
});

scenario('rejects non-semver version', () => {
	const r = validateReleasePayload(makePayload({ version: 'v1.0' }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'version_not_semver') throw new Error(r.reason);
});

scenario('rejects empty version', () => {
	const r = validateReleasePayload(makePayload({ version: '' }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'version_not_semver') throw new Error(r.reason);
});

// ─── hash_manifest ──────────────────────────────────────────────────

scenario('rejects non-object hash_manifest', () => {
	const r = validateReleasePayload(makePayload({ hash_manifest: 'foo' }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'hash_manifest_not_object') throw new Error(r.reason);
});

scenario('rejects array hash_manifest', () => {
	const r = validateReleasePayload(makePayload({ hash_manifest: [] }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'hash_manifest_not_object') throw new Error(r.reason);
});

scenario('rejects non-SRI-format hash value', () => {
	const r = validateReleasePayload(makePayload({ hash_manifest: { 'index.html': 'not-a-hash' } }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'hash_manifest_entry_invalid') throw new Error(r.reason);
});

scenario('rejects non-string hash value', () => {
	const r = validateReleasePayload(makePayload({ hash_manifest: { 'index.html': 42 } }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'hash_manifest_entry_invalid') throw new Error(r.reason);
});

scenario('rejects md5-prefixed hash', () => {
	const r = validateReleasePayload(
		makePayload({ hash_manifest: { a: 'md5-' + 'a'.repeat(43) + '=' } })
	);
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'hash_manifest_entry_invalid') throw new Error(r.reason);
});

scenario('rejects huge hash_manifest', () => {
	const big: Record<string, string> = {};
	for (let i = 0; i < 1000; i++) {
		big[`asset/${i}/${'x'.repeat(100)}`] = VALID_HASH;
	}
	const r = validateReleasePayload(makePayload({ hash_manifest: big }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'hash_manifest_too_large') throw new Error(r.reason);
});

scenario('accepts empty hash_manifest', () => {
	const r = validateReleasePayload(makePayload({ hash_manifest: {} }));
	if (!r.ok) throw new Error(`got ${r.reason}`);
});

scenario('accepts manifest with multiple valid entries', () => {
	const r = validateReleasePayload(
		makePayload({
			hash_manifest: {
				'index.html': VALID_HASH,
				'_app/start.js': VALID_HASH_2,
				'_app/style.css': VALID_HASH
			}
		})
	);
	if (!r.ok) throw new Error(`got ${r.reason}`);
});

// ─── endpoints ──────────────────────────────────────────────────────

scenario('rejects non-object endpoints', () => {
	const r = validateReleasePayload(makePayload({ endpoints: 'foo' }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'endpoints_not_object') throw new Error(r.reason);
});

scenario('rejects non-array endpoint list', () => {
	const r = validateReleasePayload(
		makePayload({ endpoints: { indexer: 'https://idx.example.com' } })
	);
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'endpoints_entry_invalid') throw new Error(r.reason);
});

scenario('rejects http (non-https) endpoint URL', () => {
	const r = validateReleasePayload(
		makePayload({ endpoints: { indexer: ['http://idx.example.com'] } })
	);
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'endpoints_entry_invalid') throw new Error(r.reason);
});

scenario('rejects endpoint URL with whitespace', () => {
	const r = validateReleasePayload(
		makePayload({ endpoints: { indexer: ['https://idx.example.com path'] } })
	);
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'endpoints_entry_invalid') throw new Error(r.reason);
});

scenario('rejects javascript: URL', () => {
	const r = validateReleasePayload(
		makePayload({ endpoints: { indexer: ['javascript:alert(1)'] } })
	);
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'endpoints_entry_invalid') throw new Error(r.reason);
});

scenario('rejects too-long endpoint URL', () => {
	const r = validateReleasePayload(
		makePayload({
			endpoints: {
				indexer: ['https://example.com/' + 'a'.repeat(300)]
			}
		})
	);
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'endpoints_entry_invalid') throw new Error(r.reason);
});

scenario('accepts multiple endpoint tiers', () => {
	const r = validateReleasePayload(
		makePayload({
			endpoints: {
				relay: ['https://relay-a.example.com', 'https://relay-b.example.com'],
				indexer: ['https://idx.example.com'],
				avatar: ['https://av.example.com'],
				blurt: ['https://rpc.blurt.blog']
			}
		})
	);
	if (!r.ok) throw new Error(`got ${r.reason}`);
});

// ─── signature ──────────────────────────────────────────────────────

scenario('rejects non-string signature', () => {
	const r = validateReleasePayload(makePayload({ signature: 42 }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'signature_not_string') throw new Error(r.reason);
});

scenario('rejects too-long signature', () => {
	const r = validateReleasePayload(makePayload({ signature: 'x'.repeat(513) }));
	if (r.ok) throw new Error('should have failed');
	if (r.reason !== 'signature_too_long') throw new Error(r.reason);
});

scenario('treats null signature as omitted', () => {
	const r = validateReleasePayload(makePayload({ signature: null }));
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if (r.value.signature !== undefined) throw new Error('expected undefined');
});

// ─── checkPinnedKeyInAuthority (audit J-1) ──────────────────────────

const PIN = 'BLT5RKpMmcjhZJfZbCuvm9eBmZxBcoG6m6gw2L1mwo7vT8wFBfXMR';
const OTHER = 'BLT8XVuDwDQzEqFP9oo7nLaG7tZpkGqSLPVpZGoa7vH2tuFtdg6jL';

scenario('checkPinnedKeyInAuthority: pinned at weight 1 → ok', () => {
	const r = checkPinnedKeyInAuthority([[PIN, 1]], PIN);
	if (!r.ok) throw new Error('expected ok');
	if (r.pinnedWeight !== 1) throw new Error(`weight=${r.pinnedWeight}`);
	if (r.chainKeys.length !== 1) throw new Error('chainKeys');
});

scenario('checkPinnedKeyInAuthority: pinned at weight 0 → REJECT (J-1)', () => {
	const r = checkPinnedKeyInAuthority([[PIN, 0]], PIN);
	if (r.ok) throw new Error('weight-0 entry should not pass');
	if (r.pinnedWeight !== 0) throw new Error(`weight=${r.pinnedWeight}`);
});

scenario('checkPinnedKeyInAuthority: pinned absent → reject', () => {
	const r = checkPinnedKeyInAuthority([[OTHER, 1]], PIN);
	if (r.ok) throw new Error('absent should not pass');
	if (!r.chainKeys.includes(OTHER)) throw new Error('chainKeys');
});

scenario('checkPinnedKeyInAuthority: pinned alongside others → ok', () => {
	const r = checkPinnedKeyInAuthority(
		[
			[OTHER, 1],
			[PIN, 2]
		],
		PIN
	);
	if (!r.ok) throw new Error('expected ok');
	if (r.pinnedWeight !== 2) throw new Error(`weight=${r.pinnedWeight}`);
});

scenario('checkPinnedKeyInAuthority: pinned weight-0 alongside hostile weight-1 → REJECT', () => {
	// The exact attack J-1 closes: attacker rotated the live key
	// to OTHER but left PIN listed at weight 0 to fool a naive
	// "is the pin present" check.
	const r = checkPinnedKeyInAuthority(
		[
			[OTHER, 1],
			[PIN, 0]
		],
		PIN
	);
	if (r.ok) throw new Error('attack scenario should be caught');
});

scenario('checkPinnedKeyInAuthority: malformed entry tolerated', () => {
	// Hostile RPC returns a key_auths entry that's not a [str,
	// num] tuple.  Helper should ignore it gracefully and look at
	// the rest of the array.
	const r = checkPinnedKeyInAuthority([null, 'foo', [PIN, 1], [42, 1]], PIN);
	if (!r.ok) throw new Error('expected ok despite garbage');
});

scenario('checkPinnedKeyInAuthority: non-array key_auths → reject', () => {
	const r = checkPinnedKeyInAuthority('not an array', PIN);
	if (r.ok) throw new Error('expected reject');
	if (r.chainKeys.length !== 0) throw new Error('chainKeys');
});

scenario('checkPinnedKeyInAuthority: undefined key_auths → reject', () => {
	const r = checkPinnedKeyInAuthority(undefined, PIN);
	if (r.ok) throw new Error('expected reject');
});

// ─── checkPinnedKeyInAuthority (audit J-1) ──────────────────────────

scenario('checkPinnedKeyInAuthority: pinned at weight 1 → ok', () => {
	const r = checkPinnedKeyInAuthority([[PIN, 1]], PIN);
	if (!r.ok) throw new Error('expected ok');
	if (r.pinnedWeight !== 1) throw new Error(`weight=${r.pinnedWeight}`);
	if (r.chainKeys.length !== 1) throw new Error('chainKeys');
});

scenario('checkPinnedKeyInAuthority: pinned at weight 0 → REJECT (J-1)', () => {
	const r = checkPinnedKeyInAuthority([[PIN, 0]], PIN);
	if (r.ok) throw new Error('weight-0 entry should not pass');
	if (r.pinnedWeight !== 0) throw new Error(`weight=${r.pinnedWeight}`);
});

scenario('checkPinnedKeyInAuthority: pinned absent → reject', () => {
	const r = checkPinnedKeyInAuthority([[OTHER, 1]], PIN);
	if (r.ok) throw new Error('absent should not pass');
	if (!r.chainKeys.includes(OTHER)) throw new Error('chainKeys');
});

scenario('checkPinnedKeyInAuthority: pinned alongside others → ok', () => {
	const r = checkPinnedKeyInAuthority(
		[
			[OTHER, 1],
			[PIN, 2]
		],
		PIN
	);
	if (!r.ok) throw new Error('expected ok');
	if (r.pinnedWeight !== 2) throw new Error(`weight=${r.pinnedWeight}`);
});

scenario('checkPinnedKeyInAuthority: pinned weight-0 alongside hostile weight-1 → REJECT', () => {
	// The exact attack J-1 closes: attacker rotated the live key
	// to OTHER but left PIN listed at weight 0 to fool a naive
	// "is the pin present" check.
	const r = checkPinnedKeyInAuthority(
		[
			[OTHER, 1],
			[PIN, 0]
		],
		PIN
	);
	if (r.ok) throw new Error('attack scenario should be caught');
});

scenario('checkPinnedKeyInAuthority: malformed entry tolerated', () => {
	// Hostile RPC returns a key_auths entry that's not a [str,
	// num] tuple.  Helper should ignore it gracefully and look at
	// the rest of the array.
	const r = checkPinnedKeyInAuthority([null, 'foo', [PIN, 1], [42, 1]], PIN);
	if (!r.ok) throw new Error('expected ok despite garbage');
});

scenario('checkPinnedKeyInAuthority: non-array key_auths → reject', () => {
	const r = checkPinnedKeyInAuthority('not an array', PIN);
	if (r.ok) throw new Error('expected reject');
	if (r.chainKeys.length !== 0) throw new Error('chainKeys');
});

scenario('checkPinnedKeyInAuthority: undefined key_auths → reject', () => {
	const r = checkPinnedKeyInAuthority(undefined, PIN);
	if (r.ok) throw new Error('expected reject');
});

// ─── Part 106 — treasury chain-pin validation ────────────────────────
//
// These scenarios mirror the indexer-side validateTreasury() rules
// in apps/indexer/src/indexer/handlers/release.ts.  Any treasury
// payload the indexer rejects must also be rejected here, with
// matching reason names.

const VALID_BTC_ADDR = 'bc1q' + 'a'.repeat(38); // bech32, 42 chars total
const VALID_XMR_ADDR = '4' + 'A'.repeat(94);
const VALID_XMR_VK = 'a'.repeat(64);

function withTreasury(t: unknown): unknown {
	return makePayload({ treasury: t });
}

scenario('Part 106: missing treasury → ok (back-compat)', () => {
	const r = validateReleasePayload(makePayload());
	if (!r.ok) throw new Error('expected ok without treasury');
	if (r.value.treasury !== undefined) throw new Error('treasury should be undefined when absent');
});

scenario('Part 106: treasury=null → ok (explicit absent)', () => {
	const r = validateReleasePayload(withTreasury(null));
	if (!r.ok) throw new Error('expected ok');
	if (r.value.treasury !== undefined) throw new Error('null should normalize to undefined');
});

scenario('Part 106: treasury={btc:null,xmr:null} → ok (no pin yet)', () => {
	const r = validateReleasePayload(withTreasury({ btc: null, xmr: null }));
	if (!r.ok) throw new Error('expected ok');
	if (r.value.treasury?.btc !== null || r.value.treasury?.xmr !== null) {
		throw new Error('expected both nulls preserved');
	}
});

scenario('Part 106: treasury not object → reject', () => {
	const r = validateReleasePayload(withTreasury('not an object'));
	if (r.ok || r.reason !== 'treasury_not_object') throw new Error(`expected treasury_not_object, got ${r.ok ? 'ok' : r.reason}`);
});

scenario('Part 106: BTC valid bech32 → ok', () => {
	const r = validateReleasePayload(withTreasury({
		btc: { address: VALID_BTC_ADDR, satoshis: 416 }, xmr: null
	}));
	if (!r.ok) throw new Error('expected ok');
	if (r.value.treasury?.btc?.address !== VALID_BTC_ADDR) throw new Error('btc address not preserved');
});

scenario('Part 106: BTC testnet (tb1) → reject', () => {
	const r = validateReleasePayload(withTreasury({
		btc: { address: 'tb1q' + 'a'.repeat(38), satoshis: 416 }, xmr: null
	}));
	if (r.ok || r.reason !== 'treasury_btc_address_not_mainnet') {
		throw new Error(`expected treasury_btc_address_not_mainnet, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 106: BTC empty address → reject', () => {
	const r = validateReleasePayload(withTreasury({
		btc: { address: '', satoshis: 416 }, xmr: null
	}));
	if (r.ok || r.reason !== 'treasury_btc_address_missing') {
		throw new Error(`expected treasury_btc_address_missing, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 106: BTC zero satoshis → reject', () => {
	const r = validateReleasePayload(withTreasury({
		btc: { address: VALID_BTC_ADDR, satoshis: 0 }, xmr: null
	}));
	if (r.ok || r.reason !== 'treasury_btc_satoshis_invalid') {
		throw new Error(`expected treasury_btc_satoshis_invalid, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 106: BTC negative satoshis → reject', () => {
	const r = validateReleasePayload(withTreasury({
		btc: { address: VALID_BTC_ADDR, satoshis: -1 }, xmr: null
	}));
	if (r.ok || r.reason !== 'treasury_btc_satoshis_invalid') {
		throw new Error(`expected treasury_btc_satoshis_invalid, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 106: BTC non-integer satoshis → reject', () => {
	const r = validateReleasePayload(withTreasury({
		btc: { address: VALID_BTC_ADDR, satoshis: 1.5 }, xmr: null
	}));
	if (r.ok || r.reason !== 'treasury_btc_satoshis_invalid') {
		throw new Error(`expected treasury_btc_satoshis_invalid, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 106: BTC absurdly large satoshis → reject', () => {
	// 1000 BTC per listing = 100_000_000_000 sats; ceiling is exclusive at that.
	const r = validateReleasePayload(withTreasury({
		btc: { address: VALID_BTC_ADDR, satoshis: 100_000_000_001 }, xmr: null
	}));
	if (r.ok || r.reason !== 'treasury_btc_satoshis_too_large') {
		throw new Error(`expected treasury_btc_satoshis_too_large, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 106 + 107: XMR primary address (4...), no viewkey field → ok', () => {
	const r = validateReleasePayload(withTreasury({
		btc: null, xmr: { address: VALID_XMR_ADDR, piconero: '781250000' }
	}));
	if (!r.ok) throw new Error('expected ok');
	// Part 107 invariant: validator output MUST NOT contain a viewkey field.
	if (r.value.treasury?.xmr !== null && 'viewkey' in (r.value.treasury?.xmr ?? {})) {
		throw new Error('Part 107 invariant violated: validator output contains viewkey');
	}
});

scenario('Part 106 + 107: XMR subaddress (8...), no viewkey field → ok', () => {
	const subaddr = '8' + 'A'.repeat(94);
	const r = validateReleasePayload(withTreasury({
		btc: null, xmr: { address: subaddr, piconero: '781250000' }
	}));
	if (!r.ok) throw new Error('expected ok');
});

scenario('Part 106 + 107: XMR testnet (9...) → reject', () => {
	const r = validateReleasePayload(withTreasury({
		btc: null, xmr: { address: '9' + 'A'.repeat(94), piconero: '781250000' }
	}));
	if (r.ok || r.reason !== 'treasury_xmr_address_not_mainnet') {
		throw new Error(`expected treasury_xmr_address_not_mainnet, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 107: XMR with viewkey field PRESENT → silently ignored, output STRIPS it', () => {
	// A release op broadcast before Part 107 (or by a hostile
	// operator who hand-crafted a payload) might include a
	// viewkey field.  Part 107 says: never reject for that
	// (we don't want to break parsing of pre-Part-107 ops),
	// but DO strip the field — the validated output must not
	// carry a viewkey under any circumstance.
	const r = validateReleasePayload(withTreasury({
		btc: null,
		xmr: {
			address: VALID_XMR_ADDR,
			viewkey: VALID_XMR_VK,  // present in input
			piconero: '781250000'
		}
	}));
	if (!r.ok) throw new Error('expected ok (viewkey is silently ignored, not rejected)');
	const xmr = r.value.treasury?.xmr;
	if (xmr === null || xmr === undefined) throw new Error('expected xmr to be populated');
	if ('viewkey' in xmr) {
		throw new Error('Part 107 invariant violated: viewkey field present in validator output');
	}
});

scenario('Part 107: XMR with garbage viewkey field → still silently ignored, no rejection', () => {
	// Even if the input viewkey is malformed, the validator must
	// not reject — the field is no longer part of validation.
	// Defense-in-depth: ensures we don't leak the existence of
	// the viewkey field to attackers via differential rejection
	// reasons.
	const r = validateReleasePayload(withTreasury({
		btc: null,
		xmr: {
			address: VALID_XMR_ADDR,
			viewkey: 'absolutely-not-a-viewkey',
			piconero: '781250000'
		}
	}));
	if (!r.ok) throw new Error(`expected ok regardless of viewkey field, got ${r.reason}`);
});

scenario('Part 106 + 107: XMR piconero "0" → reject', () => {
	const r = validateReleasePayload(withTreasury({
		btc: null, xmr: { address: VALID_XMR_ADDR, piconero: '0' }
	}));
	if (r.ok || r.reason !== 'treasury_xmr_piconero_invalid') {
		throw new Error(`expected treasury_xmr_piconero_invalid, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 106 + 107: XMR piconero non-numeric → reject', () => {
	const r = validateReleasePayload(withTreasury({
		btc: null, xmr: { address: VALID_XMR_ADDR, piconero: '1e9' }
	}));
	if (r.ok || r.reason !== 'treasury_xmr_piconero_invalid') {
		throw new Error(`expected treasury_xmr_piconero_invalid, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 106 + 107: XMR piconero 17-digit → reject (size cap)', () => {
	const r = validateReleasePayload(withTreasury({
		btc: null, xmr: { address: VALID_XMR_ADDR, piconero: '1'.repeat(17) }
	}));
	if (r.ok || r.reason !== 'treasury_xmr_piconero_too_large') {
		throw new Error(`expected treasury_xmr_piconero_too_large, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('Part 106 + 107: both BTC and XMR pinned → ok, output has no viewkey', () => {
	const r = validateReleasePayload(withTreasury({
		btc: { address: VALID_BTC_ADDR, satoshis: 416 },
		xmr: { address: VALID_XMR_ADDR, piconero: '781250000' }
	}));
	if (!r.ok) throw new Error('expected ok');
	if (r.value.treasury?.btc?.address !== VALID_BTC_ADDR) throw new Error('btc');
	if (r.value.treasury?.xmr?.address !== VALID_XMR_ADDR) throw new Error('xmr');
	// Part 107 invariant.
	const xmrOut = r.value.treasury?.xmr;
	if (xmrOut !== null && xmrOut !== undefined && 'viewkey' in xmrOut) {
		throw new Error('Part 107 invariant violated');
	}
});

scenario('Part 106: BTC legacy address (1...) → ok', () => {
	const legacy = '1' + 'A'.repeat(33); // 34 chars total, mainnet legacy
	const r = validateReleasePayload(withTreasury({
		btc: { address: legacy, satoshis: 416 }, xmr: null
	}));
	if (!r.ok) throw new Error('expected ok');
});

scenario('Part 106: BTC P2SH address (3...) → ok', () => {
	const p2sh = '3' + 'A'.repeat(33);
	const r = validateReleasePayload(withTreasury({
		btc: { address: p2sh, satoshis: 416 }, xmr: null
	}));
	if (!r.ok) throw new Error('expected ok');
});

scenario('Part 106: BTC legacy testnet (m...) → reject', () => {
	const r = validateReleasePayload(withTreasury({
		btc: { address: 'm' + 'A'.repeat(33), satoshis: 416 }, xmr: null
	}));
	if (r.ok || r.reason !== 'treasury_btc_address_not_mainnet') {
		throw new Error(`expected reject, got ${r.ok ? 'ok' : r.reason}`);
	}
});

// ─── cp372 — chain-pinned BLURT fee base ─────────────────────────────

scenario('cp372: treasury.blurt absent → ok (back-compat, no BLURT pin)', () => {
	const r = validateReleasePayload(withTreasury({ btc: null, xmr: null }));
	if (!r.ok) throw new Error('expected ok without blurt');
	if (r.value.treasury?.blurt !== undefined) {
		throw new Error('blurt should be absent when not provided (byte-identical to pre-cp372)');
	}
});

scenario('cp372: treasury.blurt={base:62.5} → ok, preserved', () => {
	const r = validateReleasePayload(withTreasury({ btc: null, xmr: null, blurt: { base: 62.5 } }));
	if (!r.ok) throw new Error('expected ok');
	if (r.value.treasury?.blurt?.base !== 62.5) throw new Error('blurt base not preserved');
});

scenario('cp372: treasury.blurt=null → ok (explicit no-pin)', () => {
	const r = validateReleasePayload(withTreasury({ btc: null, xmr: null, blurt: null }));
	if (!r.ok) throw new Error('expected ok');
	if (r.value.treasury?.blurt !== undefined) throw new Error('null blurt normalizes to absent');
});

scenario('cp372: blurt not object → reject', () => {
	const r = validateReleasePayload(withTreasury({ btc: null, xmr: null, blurt: 62.5 as unknown as { base: number } }));
	if (r.ok || r.reason !== 'treasury_blurt_not_object') {
		throw new Error(`expected treasury_blurt_not_object, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('cp372: blurt base zero → reject', () => {
	const r = validateReleasePayload(withTreasury({ btc: null, xmr: null, blurt: { base: 0 } }));
	if (r.ok || r.reason !== 'treasury_blurt_base_invalid') {
		throw new Error(`expected treasury_blurt_base_invalid, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('cp372: blurt base negative → reject', () => {
	const r = validateReleasePayload(withTreasury({ btc: null, xmr: null, blurt: { base: -5 } }));
	if (r.ok || r.reason !== 'treasury_blurt_base_invalid') {
		throw new Error(`expected treasury_blurt_base_invalid, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('cp372: blurt base non-finite → reject', () => {
	const r = validateReleasePayload(withTreasury({ btc: null, xmr: null, blurt: { base: Infinity } }));
	if (r.ok || r.reason !== 'treasury_blurt_base_invalid') {
		throw new Error(`expected treasury_blurt_base_invalid, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('cp372: blurt base over sanity ceiling → reject', () => {
	const r = validateReleasePayload(withTreasury({ btc: null, xmr: null, blurt: { base: 10_000_001 } }));
	if (r.ok || r.reason !== 'treasury_blurt_base_too_large') {
		throw new Error(`expected treasury_blurt_base_too_large, got ${r.ok ? 'ok' : r.reason}`);
	}
});

scenario('cp372: all three assets pinned together → ok', () => {
	const r = validateReleasePayload(withTreasury({
		btc: { address: VALID_BTC_ADDR, satoshis: 416 },
		xmr: { address: VALID_XMR_ADDR, piconero: '781250000' },
		blurt: { base: 62.5 }
	}));
	if (!r.ok) throw new Error('expected ok with all three');
	if (r.value.treasury?.blurt?.base !== 62.5) throw new Error('blurt base lost');
	if (r.value.treasury?.btc?.satoshis !== 416) throw new Error('btc lost');
});

// ─── cp556 — decentralized-distribution anchor ──────────────────────
const D_SHA = 'a'.repeat(64);
const D_FPR = 'DEADBEEF'.repeat(5); // 40-hex v4 fingerprint
const D_CID0 = 'Qm' + 'a'.repeat(44); // CIDv0 base58btc
const D_CID1 = 'b' + 'a'.repeat(58); // CIDv1 base32
function withDistribution(distribution: unknown): unknown {
	return makePayload({ distribution });
}

scenario('distribution undefined → ok (back-compat)', () => {
	const r = validateReleasePayload(makePayload());
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if ('distribution' in r.value) throw new Error('phantom distribution key');
});

scenario('distribution=null → ok, omitted from value', () => {
	const r = validateReleasePayload(withDistribution(null));
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if ('distribution' in r.value) throw new Error('null distribution should be omitted');
});

scenario('distribution minimal (sha + fpr) → ok', () => {
	const r = validateReleasePayload(withDistribution({ source_sha256: D_SHA, gpg_fingerprint: D_FPR }));
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if (r.value.distribution?.source_sha256 !== D_SHA) throw new Error('sha lost');
	if (r.value.distribution?.gpg_fingerprint !== D_FPR) throw new Error('fpr lost');
	if ('ipfs_cid' in (r.value.distribution ?? {})) throw new Error('phantom ipfs_cid');
});

scenario('distribution full (cid v0 + mirrors) → ok', () => {
	const r = validateReleasePayload(
		withDistribution({
			source_sha256: D_SHA,
			gpg_fingerprint: D_FPR,
			ipfs_cid: D_CID0,
			mirrors: ['https://codeberg.org/agorise/morphit', 'https://ipfs.io/ipfs/' + D_CID0]
		})
	);
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if (r.value.distribution?.ipfs_cid !== D_CID0) throw new Error('cid lost');
	if (r.value.distribution?.mirrors?.length !== 2) throw new Error('mirrors lost');
});

scenario('distribution CIDv1 base32 → ok', () => {
	const r = validateReleasePayload(
		withDistribution({ source_sha256: D_SHA, gpg_fingerprint: D_FPR, ipfs_cid: D_CID1 })
	);
	if (!r.ok) throw new Error(`got ${r.reason}`);
});

scenario('distribution 64-hex (v5) fingerprint → ok', () => {
	const r = validateReleasePayload(
		withDistribution({ source_sha256: D_SHA, gpg_fingerprint: 'abcdef01'.repeat(8) })
	);
	if (!r.ok) throw new Error(`got ${r.reason}`);
});

scenario('distribution as array → distribution_not_object', () => {
	const r = validateReleasePayload(withDistribution([]));
	if (r.ok || r.reason !== 'distribution_not_object') throw new Error(`got ${r.ok ? 'ok' : r.reason}`);
});

scenario('distribution missing sha → distribution_source_sha256_invalid', () => {
	const r = validateReleasePayload(withDistribution({ gpg_fingerprint: D_FPR }));
	if (r.ok || r.reason !== 'distribution_source_sha256_invalid')
		throw new Error(`got ${r.ok ? 'ok' : r.reason}`);
});

scenario('distribution UPPERCASE sha → distribution_source_sha256_invalid', () => {
	const r = validateReleasePayload(withDistribution({ source_sha256: 'A'.repeat(64), gpg_fingerprint: D_FPR }));
	if (r.ok || r.reason !== 'distribution_source_sha256_invalid')
		throw new Error(`got ${r.ok ? 'ok' : r.reason}`);
});

scenario('distribution short fingerprint → distribution_gpg_fingerprint_invalid', () => {
	const r = validateReleasePayload(withDistribution({ source_sha256: D_SHA, gpg_fingerprint: 'a'.repeat(39) }));
	if (r.ok || r.reason !== 'distribution_gpg_fingerprint_invalid')
		throw new Error(`got ${r.ok ? 'ok' : r.reason}`);
});

scenario('distribution bad cid → distribution_ipfs_cid_invalid', () => {
	const r = validateReleasePayload(
		withDistribution({ source_sha256: D_SHA, gpg_fingerprint: D_FPR, ipfs_cid: 'nope' })
	);
	if (r.ok || r.reason !== 'distribution_ipfs_cid_invalid')
		throw new Error(`got ${r.ok ? 'ok' : r.reason}`);
});

scenario('distribution mirrors not array → distribution_mirrors_not_array', () => {
	const r = validateReleasePayload(
		withDistribution({ source_sha256: D_SHA, gpg_fingerprint: D_FPR, mirrors: 'https://x.example.org' })
	);
	if (r.ok || r.reason !== 'distribution_mirrors_not_array')
		throw new Error(`got ${r.ok ? 'ok' : r.reason}`);
});

scenario('distribution non-https mirror → distribution_mirror_invalid', () => {
	const r = validateReleasePayload(
		withDistribution({ source_sha256: D_SHA, gpg_fingerprint: D_FPR, mirrors: ['http://x.example.org'] })
	);
	if (r.ok || r.reason !== 'distribution_mirror_invalid')
		throw new Error(`got ${r.ok ? 'ok' : r.reason}`);
});

// v1.9.6 (Ken) — the mirror cap was bumped 8 → 10 (to fit the gitea.com +
// framagit.org additions). Pin the NEW boundary: 10 is accepted (at the cap),
// 11 is rejected (over it). A forward-compat note lives on MIRRORS_MAX.
scenario('distribution 10 mirrors (at the cap) → ok', () => {
	const r = validateReleasePayload(
		withDistribution({
			source_sha256: D_SHA,
			gpg_fingerprint: D_FPR,
			mirrors: Array.from({ length: 10 }, (_, i) => `https://m${i}.example.org/x`)
		})
	);
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if (r.value.distribution?.mirrors?.length !== 10) throw new Error('mirrors lost');
});

scenario('distribution 11 mirrors (over the cap) → distribution_mirror_invalid', () => {
	const r = validateReleasePayload(
		withDistribution({
			source_sha256: D_SHA,
			gpg_fingerprint: D_FPR,
			mirrors: Array.from({ length: 11 }, (_, i) => `https://m${i}.example.org/x`)
		})
	);
	if (r.ok || r.reason !== 'distribution_mirror_invalid')
		throw new Error(`got ${r.ok ? 'ok' : r.reason}`);
});

// v1.8.16 (Ken) — Launchpad personal-repo git URLs carry a `+` (`/+git/`); the
// mirror charset was relaxed to allow it. Pin BOTH directions: the `+` URL is
// accepted, and a genuinely-bad char (space) is STILL rejected, so the relaxation
// didn't open the charset wide.
scenario('distribution mirror with + in path (Launchpad) → ok', () => {
	const r = validateReleasePayload(
		withDistribution({
			source_sha256: D_SHA,
			gpg_fingerprint: D_FPR,
			mirrors: ['https://git.launchpad.net/~agorise/+git/morphit']
		})
	);
	if (!r.ok) throw new Error(`got ${r.reason}`);
	if (r.value.distribution?.mirrors?.[0] !== 'https://git.launchpad.net/~agorise/+git/morphit')
		throw new Error('launchpad mirror lost');
});

scenario('distribution mirror with a space → distribution_mirror_invalid', () => {
	const r = validateReleasePayload(
		withDistribution({
			source_sha256: D_SHA,
			gpg_fingerprint: D_FPR,
			mirrors: ['https://x.example.org/a b']
		})
	);
	if (r.ok || r.reason !== 'distribution_mirror_invalid')
		throw new Error(`got ${r.ok ? 'ok' : r.reason}`);
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
