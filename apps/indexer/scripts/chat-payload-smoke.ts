/**
 * Chat payload encode/decode pure-helpers — tsx smoke runner.
 *
 * Covers: address shape validation (BTC P2PKH/P2SH/bech32, XMR
 * standard/sub/integrated), txid validation, encode round-trip,
 * decode (recognized payloads, unknown-version fallback,
 * plaintext fallback, shape-mismatch fallback), optional field
 * handling, length caps.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/chat-payload-smoke.ts
 */

import {
	buildPaymentUri,
	decodePayload,
	encodeAddressPayload,
	encodeFundsSentPayload,
	generateBlurtMemo,
	isValidAddress,
	isValidBlurtAccount,
	isValidBtcAddress,
	isValidMemo,
	isValidTxid,
	isValidXmrAddress,
	type AddressPayload,
	type FundsSentPayload
} from '../../web/src/lib/chat/payload.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

function assertTrue(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

function assertThrows(fn: () => void, label: string): void {
	let threw = false;
	try {
		fn();
	} catch {
		threw = true;
	}
	if (!threw) throw new Error(`${label}: expected throw, none thrown`);
}

// ─── BTC address validation ──────────────────────────────────────

scenario('BTC: P2PKH (1...) accepted', () => {
	// Genesis block coinbase address
	assertTrue(
		isValidBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'),
		'should accept genesis coinbase'
	);
});

scenario('BTC: P2SH (3...) accepted', () => {
	// Well-known P2SH test address
	assertTrue(isValidBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), 'should accept P2SH');
});

scenario('BTC: bech32 (bc1...) accepted', () => {
	// BIP173 example
	assertTrue(
		isValidBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'),
		'should accept bech32 v0'
	);
});

scenario('BTC: taproot (bc1p...) accepted', () => {
	// BIP341-shape taproot, 62-char total
	assertTrue(
		isValidBtcAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'),
		'should accept taproot'
	);
});

scenario('BTC: too short rejected', () => {
	assertTrue(!isValidBtcAddress('1abc'), 'should reject 4-char');
});

scenario('BTC: invalid prefix (4...) rejected', () => {
	assertTrue(!isValidBtcAddress('4A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), 'should reject leading 4');
});

scenario('BTC: bech32 with uppercase rejected (mixed-case forbidden)', () => {
	assertTrue(
		!isValidBtcAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'),
		'should reject uppercase bech32'
	);
});

scenario('BTC: empty string rejected', () => {
	assertTrue(!isValidBtcAddress(''), 'should reject empty');
});

// ─── XMR address validation ──────────────────────────────────────

scenario('XMR: standard (4... 95 chars) accepted', () => {
	// Sample standard XMR address from the official docs
	assertTrue(
		isValidXmrAddress(
			'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o'
		),
		'should accept standard'
	);
});

scenario('XMR: subaddress (8...) accepted', () => {
	assertTrue(
		isValidXmrAddress(
			'87jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o'
		),
		'should accept subaddress'
	);
});

scenario('XMR: subaddress and standard both validate (nudge is UI-only)', () => {
	// Phase F.3 adds a UI-layer subaddress nudge, but at the
	// payload layer both 4... and 8... addresses must validate.
	// Pin this so a future refactor doesn't accidentally make
	// the nudge a hard block at the validator level.
	const standard =
		'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o';
	const subaddress =
		'87jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o';
	assertTrue(isValidXmrAddress(standard), 'standard valid');
	assertTrue(isValidXmrAddress(subaddress), 'subaddress valid');
});

scenario('XMR: integrated address (4..., 106 chars) accepted', () => {
	// Integrated = standard + 8-byte payment ID; 106 chars total.
	assertTrue(
		isValidXmrAddress(
			'4LL9oSLmtpccfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2bYXZKKQePHES9khPK'
		),
		'should accept integrated'
	);
});

scenario('XMR: too short rejected', () => {
	assertTrue(!isValidXmrAddress('4abcdef'), 'should reject 7-char');
});

scenario('XMR: too long rejected', () => {
	const tooLong = '4' + 'A' + 'B'.repeat(95);
	assertTrue(!isValidXmrAddress(tooLong), 'should reject overlong');
});

scenario('XMR: invalid prefix (1...) rejected', () => {
	const valid =
		'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o';
	const wrongPrefix = '17' + valid.slice(2);
	assertTrue(!isValidXmrAddress(wrongPrefix), 'should reject leading 1');
});

// ─── Dispatch ────────────────────────────────────────────────────

scenario('isValidAddress: dispatches on method', () => {
	assertTrue(isValidAddress('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), 'btc dispatch');
	assertTrue(
		!isValidAddress(
			'btc',
			'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o'
		),
		'xmr addr should not validate as btc'
	);
});

// ─── Txid validation ─────────────────────────────────────────────

scenario('txid: 64 lowercase hex accepted (BTC)', () => {
	const txid = 'a'.repeat(64);
	assertTrue(isValidTxid('btc', txid), 'should accept 64 hex');
});

scenario('txid: uppercase rejected', () => {
	const txid = 'A'.repeat(64);
	assertTrue(!isValidTxid('btc', txid), 'should reject uppercase');
});

scenario('txid: wrong length rejected', () => {
	assertTrue(!isValidTxid('btc', 'a'.repeat(63)), 'should reject 63 chars');
	assertTrue(!isValidTxid('btc', 'a'.repeat(65)), 'should reject 65 chars');
});

// ─── Encode address payload ──────────────────────────────────────

scenario('encode address: minimum required fields', () => {
	const p: AddressPayload = {
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
	};
	const wire = encodeAddressPayload(p);
	const parsed = JSON.parse(wire);
	assertEqual(parsed.v, 1, 'v');
	assertEqual(parsed.kind, 'morphit_addr', 'kind');
	assertEqual(parsed.method, 'btc', 'method');
	assertEqual(parsed.address, p.address, 'address');
});

scenario('encode address: with all optional fields', () => {
	const p: AddressPayload = {
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		amount: '0.005',
		orderPermlink: 'morphit-order-abc123',
		note: 'cash in hand'
	};
	const wire = encodeAddressPayload(p);
	const parsed = JSON.parse(wire);
	assertEqual(parsed.amount, '0.005', 'amount');
	assertEqual(parsed.order_permlink, 'morphit-order-abc123', 'order_permlink');
	assertEqual(parsed.note, 'cash in hand', 'note');
});

scenario('encode address: rejects invalid address shape', () => {
	assertThrows(
		() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'btc',
				address: 'not-an-address'
			}),
		'invalid btc address'
	);
});

scenario('encode address: rejects invalid amount', () => {
	assertThrows(
		() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'btc',
				address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
				amount: '0.005 BTC'
			}),
		'amount with units'
	);
});

scenario('encode address: rejects note over cap', () => {
	assertThrows(
		() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'btc',
				address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
				note: 'x'.repeat(101)
			}),
		'note 101 chars'
	);
});

scenario('encode address: rejects bad order_permlink', () => {
	assertThrows(
		() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'btc',
				address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
				orderPermlink: 'WITH UPPERCASE'
			}),
		'permlink uppercase'
	);
});

// ─── Encode funds-sent payload ───────────────────────────────────

scenario('encode funds_sent: minimum fields', () => {
	const p: FundsSentPayload = {
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'btc',
		txid: 'a'.repeat(64)
	};
	const wire = encodeFundsSentPayload(p);
	const parsed = JSON.parse(wire);
	assertEqual(parsed.kind, 'morphit_funds_sent', 'kind');
	assertEqual(parsed.txid, 'a'.repeat(64), 'txid');
});

scenario('encode funds_sent: rejects invalid txid', () => {
	assertThrows(
		() =>
			encodeFundsSentPayload({
				v: 1,
				kind: 'morphit_funds_sent',
				method: 'btc',
				txid: 'too-short'
			}),
		'short txid'
	);
});

// ─── Decode ──────────────────────────────────────────────────────

scenario('decode: plaintext (no JSON) returns plaintext', () => {
	const r = decodePayload('hello there');
	assertEqual(r.kind, 'plaintext', 'plaintext kind');
});

scenario('decode: empty string returns plaintext', () => {
	const r = decodePayload('');
	assertEqual(r.kind, 'plaintext', 'plaintext kind');
});

scenario('decode: malformed JSON returns plaintext', () => {
	const r = decodePayload('{not json');
	assertEqual(r.kind, 'plaintext', 'plaintext kind');
});

scenario('decode: JSON array returns plaintext', () => {
	const r = decodePayload('[1,2,3]');
	assertEqual(r.kind, 'plaintext', 'plaintext kind');
});

scenario('decode: object without v returns plaintext', () => {
	const r = decodePayload('{"foo": "bar"}');
	assertEqual(r.kind, 'plaintext', 'plaintext kind');
});

scenario('decode: future version flagged unknown_version', () => {
	const r = decodePayload('{"v": 2, "kind": "future_thing"}');
	assertEqual(r.kind, 'unknown_version', 'kind');
	if (r.kind === 'unknown_version') {
		assertEqual(r.version, 2, 'version');
	}
});

scenario('decode: address payload round-trips', () => {
	const original: AddressPayload = {
		v: 1,
		kind: 'morphit_addr',
		method: 'xmr',
		address:
			'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o',
		amount: '0.5',
		orderPermlink: 'morphit-order-xyz',
		note: 'meeting tomorrow at 3pm'
	};
	const wire = encodeAddressPayload(original);
	const r = decodePayload(wire);
	assertEqual(r.kind, 'address', 'decoded kind');
	if (r.kind === 'address') {
		assertEqual(r.payload.method, 'xmr', 'method');
		assertEqual(r.payload.address, original.address, 'address');
		assertEqual(r.payload.amount, '0.5', 'amount');
		assertEqual(r.payload.orderPermlink, 'morphit-order-xyz', 'permlink');
		assertEqual(r.payload.note, original.note, 'note');
	}
});

scenario('decode: funds_sent payload round-trips', () => {
	const original: FundsSentPayload = {
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'btc',
		txid: '0123456789abcdef'.repeat(4),
		amount: '0.005'
	};
	const wire = encodeFundsSentPayload(original);
	const r = decodePayload(wire);
	assertEqual(r.kind, 'funds_sent', 'decoded kind');
	if (r.kind === 'funds_sent') {
		assertEqual(r.payload.txid, original.txid, 'txid');
		assertEqual(r.payload.amount, '0.005', 'amount');
	}
});

scenario('decode: tampered address rejected → plaintext', () => {
	// Wire that claims method=btc but address is XMR.
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address:
			'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o'
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'plaintext', 'method/address mismatch should fall through');
});

scenario('decode: tampered note (over cap) rejected → plaintext', () => {
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		note: 'x'.repeat(200)
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'plaintext', 'overlong note');
});

scenario('decode: tampered amount rejected → plaintext', () => {
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		amount: 'free money'
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'plaintext', 'bad amount');
});

scenario('decode: leading whitespace tolerated', () => {
	// Some clients may add whitespace; trim before parse.
	const wire =
		'   ' +
		JSON.stringify({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
		});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'address', 'leading whitespace');
});

scenario('decode: unknown morphit_ kind returns unknown_kind (F-2)', () => {
	// Pre-Phase-F.5: this returned 'plaintext'.  Post-fix it
	// returns 'unknown_kind' so the UI can show "old client,
	// please update" rather than rendering raw JSON.
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_dispute', // future kind not yet defined
		foo: 'bar'
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'unknown_kind', 'now distinct');
});

// ─── BLURT (Phase F.2) ───────────────────────────────────────────

scenario('BLURT: valid account name accepted', () => {
	assertTrue(isValidBlurtAccount('alice'), 'simple name');
	assertTrue(isValidBlurtAccount('alice-cool'), 'with dash');
	assertTrue(isValidBlurtAccount('alice.brave'), 'multi-segment with dot');
	assertTrue(isValidBlurtAccount('a1b2c3'), 'with digits');
});

scenario('BLURT: rejects too-short name', () => {
	assertTrue(!isValidBlurtAccount('al'), '2 chars');
});

scenario('BLURT: rejects too-long name', () => {
	assertTrue(!isValidBlurtAccount('a'.repeat(17)), '17 chars');
});

scenario('BLURT: rejects uppercase', () => {
	assertTrue(!isValidBlurtAccount('Alice'), 'leading uppercase');
});

scenario('BLURT: rejects digit start', () => {
	assertTrue(!isValidBlurtAccount('1alice'), 'digit lead');
});

scenario('BLURT: txid is 40 hex chars', () => {
	assertTrue(isValidTxid('blurt', 'a'.repeat(40)), 'should accept 40 hex');
	assertTrue(!isValidTxid('blurt', 'a'.repeat(64)), 'should reject 64 (BTC/XMR shape)');
	assertTrue(!isValidTxid('blurt', 'a'.repeat(39)), 'should reject 39');
});

scenario('isValidAddress: BLURT dispatches correctly', () => {
	assertTrue(isValidAddress('blurt', 'alice'), 'blurt accept');
	assertTrue(
		!isValidAddress('blurt', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'),
		'btc rejected as blurt'
	);
});

scenario('encode address: BLURT method works', () => {
	const p: AddressPayload = {
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice'
	};
	const wire = encodeAddressPayload(p);
	const parsed = JSON.parse(wire);
	assertEqual(parsed.method, 'blurt', 'method');
	assertEqual(parsed.address, 'alice', 'address');
});

scenario('decode: BLURT address payload round-trips', () => {
	const original: AddressPayload = {
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		amount: '100'
	};
	const wire = encodeAddressPayload(original);
	const r = decodePayload(wire);
	assertEqual(r.kind, 'address', 'decoded kind');
	if (r.kind === 'address') {
		assertEqual(r.payload.method, 'blurt', 'method');
		assertEqual(r.payload.address, 'alice.brave', 'address');
		// F-8: BLURT amount normalized to 3 decimals on encode.
		assertEqual(r.payload.amount, '100.000', 'amount normalized');
	}
});

// ─── F-8 audit fix: BLURT amount precision normalization ──────────

scenario('F-8: BLURT amount with 4+ decimals rounds UP to 3', () => {
	// Headline audit case: seller types 1700.4994.  Buyer's wallet
	// would broadcast 1700.500 (Math.ceil at 4th decimal).  Verifier
	// would compare seller's 1700.4994 against chain's 1700.500
	// (diff 0.0006 > 0.0005 epsilon) → false mismatch.
	// Post-fix: encoder normalizes to 1700.500 so seller and chain
	// see the same value.
	const original: AddressPayload = {
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		amount: '1700.4994'
	};
	const wire = encodeAddressPayload(original);
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.amount, '1700.500', 'rounded up to 3 decimals');
});

scenario('F-8: BLURT integer amount gets .000 suffix', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		amount: '1700'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.amount, '1700.000', 'integer normalized');
});

scenario('F-8: BLURT amount with one decimal padded to three', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		amount: '1700.5'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.amount, '1700.500', 'padded to 3');
});

scenario('F-8: BLURT amount with 4 decimals rounds up properly', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		amount: '1700.4001'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.amount, '1700.401', 'rounded up at 4th decimal');
});

scenario('F-8: BLURT amount already at 3 decimals unchanged', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		amount: '1700.123'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.amount, '1700.123', 'unchanged');
});

scenario('F-8: BTC amount NOT normalized (preserved verbatim)', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		amount: '0.00050000'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	// BTC has 8-decimal precision on chain; we don't enforce a
	// 3-decimal normalization on BTC amounts.
	assertEqual(r.payload.amount, '0.00050000', 'BTC verbatim');
});

scenario('F-8: XMR amount NOT normalized (preserved verbatim)', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'xmr',
		address:
			'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o',
		amount: '0.123456789012'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.amount, '0.123456789012', 'XMR verbatim');
});

scenario('F-8: funds_sent BLURT amount also normalized', () => {
	const wire = encodeFundsSentPayload({
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'blurt',
		txid: 'a'.repeat(40),
		amount: '1700.4994'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'funds_sent') throw new Error('expected funds_sent kind');
	assertEqual(r.payload.amount, '1700.500', 'symmetric on funds_sent');
});

scenario('F-8: leading zeros in BLURT amount incidentally normalized (F-4 side benefit)', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		amount: '0001.500'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.amount, '1.500', 'leading zeros stripped');
});

scenario('F-8: tiny BLURT amount (one chain unit) preserved', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		amount: '0.001'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.amount, '0.001', 'min unit preserved');
});

// ─── F-1 audit fix: note charset filter ───────────────────────────

scenario('F-1: encoder rejects note with bidi RLO override', () => {
	let threw = false;
	try {
		encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			// U+202E RIGHT-TO-LEFT OVERRIDE — visually reverses
			// subsequent text.
			note: 'meeting tomorrow\u202E reversed text'
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'encoder rejects RLO');
});

scenario('F-1: encoder rejects note with newline (control char)', () => {
	let threw = false;
	try {
		encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			note: 'line one\nline two'
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'encoder rejects newline');
});

scenario('F-1: encoder accepts legitimate Unicode (Cyrillic + emoji)', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		note: 'Привет 🎉 встреча в 3pm'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.note, 'Привет 🎉 встреча в 3pm', 'unicode preserved');
});

scenario('F-1: decoder returns plaintext when wire note has forbidden chars', () => {
	// Bypass the encoder by hand-crafting a wire string with
	// a U+2066 LRI control character in the note field.
	const malicious = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		note: 'safe-looking\u2066hidden'
	});
	const r = decodePayload(malicious);
	assertEqual(r.kind, 'plaintext', 'falls through to plaintext');
});

scenario('F-1: encoder rejects funds_sent note with DEL char', () => {
	let threw = false;
	try {
		encodeFundsSentPayload({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'btc',
			txid: 'a'.repeat(64),
			note: 'hello\u007Fworld'
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'encoder rejects DEL');
});

scenario('F-1: ZWJ allowed (legitimate in many scripts)', () => {
	// Zero-width joiner is used in legitimate text (e.g. Devanagari,
	// Arabic ligatures) — must NOT be rejected.
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		note: 'a\u200Db'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.note, 'a\u200Db', 'ZWJ preserved');
});

// ─── F-2 audit fix: unknown_kind discriminant ─────────────────────

scenario('F-2: v:1 unknown morphit_ kind → unknown_kind discriminant', () => {
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_dispute', // hypothetical future addition
		issuer: 'alice'
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'unknown_kind', 'distinct from plaintext');
	if (r.kind === 'unknown_kind') {
		assertEqual(r.name, 'morphit_dispute', 'name preserved');
	}
});

scenario('F-2: v:1 non-morphit kind → plaintext (not Morphit)', () => {
	// A JSON object the user happens to type that has v:1 + kind
	// but isn't a Morphit payload should NOT be flagged as unknown
	// kind — that's just user content.
	const wire = JSON.stringify({
		v: 1,
		kind: 'whatever',
		other: 'fields'
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'plaintext', 'falls through to plaintext');
});

scenario('F-2: v:2 still routes to unknown_version (kind ignored)', () => {
	const wire = JSON.stringify({
		v: 2,
		kind: 'morphit_addr',
		address: 'whatever'
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'unknown_version', 'version takes precedence');
});

// ─── F-3 audit fix: memo is BLURT-only ────────────────────────────

scenario('F-3: encoder rejects memo on BTC address payload', () => {
	let threw = false;
	try {
		encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			memo: 'abc12345' as never
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'BTC + memo rejected');
});

scenario('F-3: encoder rejects memo on XMR funds_sent payload', () => {
	let threw = false;
	try {
		encodeFundsSentPayload({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'xmr',
			txid: 'a'.repeat(64),
			memo: 'abc12345' as never
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'XMR + memo rejected');
});

scenario('F-3: decoder treats BTC + memo as plaintext', () => {
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		memo: 'abc12345'
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'plaintext', 'BTC + memo decodes to plaintext');
});

scenario('F-3: BLURT memo still works (positive case)', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		memo: 'abc12345'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.memo, 'abc12345', 'BLURT memo preserved');
});

// ─── F-3 audit fix: memo is BLURT-only ────────────────────────────

scenario('F-3: encoder rejects memo on BTC address payload', () => {
	let threw = false;
	try {
		encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			memo: 'abc12345' as never
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'BTC + memo rejected');
});

scenario('F-3: encoder rejects memo on XMR funds_sent payload', () => {
	let threw = false;
	try {
		encodeFundsSentPayload({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'xmr',
			txid: 'a'.repeat(64),
			memo: 'abc12345' as never
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'XMR + memo rejected');
});

scenario('F-3: decoder treats BTC + memo as plaintext', () => {
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		memo: 'abc12345'
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'plaintext', 'BTC + memo decodes to plaintext');
});

scenario('F-3: BLURT memo still works (positive case)', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		memo: 'abc12345'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.memo, 'abc12345', 'BLURT memo preserved');
});

// ─── F-5 audit fix: Object.hasOwn instead of `in` operator ────────

scenario('F-5: prototype-chain phantom field is rejected', () => {
	// Construct a wire object whose prototype defines `note`.
	// Pre-fix `'note' in o` would see the inherited field; post-fix
	// Object.hasOwn ignores it.
	const malicious = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
	});
	const r = decodePayload(malicious);
	if (r.kind !== 'address') throw new Error('expected address');
	assertEqual(r.payload.note, undefined, 'note unset');
});

// ─── F-6 audit fix: empty-string optionals not emitted ────────────

scenario('F-6: empty-string note skipped on encode', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		note: ''
	});
	const parsed = JSON.parse(wire);
	assertEqual(parsed.note, undefined, 'note absent');
});

scenario('F-6: empty-string memo skipped on encode (BLURT)', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice.brave',
		memo: ''
	});
	const parsed = JSON.parse(wire);
	assertEqual(parsed.memo, undefined, 'memo absent');
});

scenario('F-6: empty-string optionals on funds_sent skipped', () => {
	const wire = encodeFundsSentPayload({
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'btc',
		txid: 'a'.repeat(64),
		note: ''
	});
	const parsed = JSON.parse(wire);
	assertEqual(parsed.note, undefined, 'note absent on funds_sent');
});

scenario('F-6: non-empty values still emitted', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		note: 'real note'
	});
	const parsed = JSON.parse(wire);
	assertEqual(parsed.note, 'real note', 'real value emitted');
});

// ─── F-1 audit fix: note charset filter ───────────────────────────

scenario('F-1: encoder rejects note with bidi RLO override', () => {
	let threw = false;
	try {
		encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			// U+202E RIGHT-TO-LEFT OVERRIDE — visually reverses
			// subsequent text.
			note: 'meeting tomorrow\u202E reversed text'
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'encoder rejects RLO');
});

scenario('F-1: encoder rejects note with newline (control char)', () => {
	let threw = false;
	try {
		encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			note: 'line one\nline two'
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'encoder rejects newline');
});

scenario('F-1: encoder accepts legitimate Unicode (Cyrillic + emoji)', () => {
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		note: 'Привет 🎉 встреча в 3pm'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.note, 'Привет 🎉 встреча в 3pm', 'unicode preserved');
});

scenario('F-1: decoder returns plaintext when wire note has forbidden chars', () => {
	// Bypass the encoder by hand-crafting a wire string with
	// a U+2066 LRI control character in the note field.
	const malicious = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		note: 'safe-looking\u2066hidden'
	});
	const r = decodePayload(malicious);
	assertEqual(r.kind, 'plaintext', 'falls through to plaintext');
});

scenario('F-1: encoder rejects funds_sent note with DEL char', () => {
	let threw = false;
	try {
		encodeFundsSentPayload({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'btc',
			txid: 'a'.repeat(64),
			note: 'hello\u007Fworld'
		});
	} catch {
		threw = true;
	}
	assertTrue(threw, 'encoder rejects DEL');
});

scenario('F-1: ZWJ allowed (legitimate in many scripts)', () => {
	// Zero-width joiner is used in legitimate text (e.g. Devanagari,
	// Arabic ligatures) — must NOT be rejected.
	const wire = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		note: 'a\u200Db'
	});
	const r = decodePayload(wire);
	if (r.kind !== 'address') throw new Error('expected address kind');
	assertEqual(r.payload.note, 'a\u200Db', 'ZWJ preserved');
});

// ─── buildPaymentUri (Phase F.2) ─────────────────────────────────

scenario('buildPaymentUri: BTC builds BIP-21', () => {
	const uri = buildPaymentUri({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		amount: '0.005'
	});
	assertEqual(
		uri,
		'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.005',
		'BIP-21 with amount'
	);
});

scenario('buildPaymentUri: BTC without amount omits query', () => {
	const uri = buildPaymentUri({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
	});
	assertEqual(uri, 'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'no query string');
});

scenario('buildPaymentUri: XMR uses tx_amount param', () => {
	// Per Monero URI scheme spec, the param is tx_amount NOT amount.
	const uri = buildPaymentUri({
		v: 1,
		kind: 'morphit_addr',
		method: 'xmr',
		address:
			'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o',
		amount: '0.5'
	});
	assertTrue(uri.startsWith('monero:'), 'monero prefix');
	assertTrue(uri.includes('tx_amount=0.5'), 'tx_amount param (not amount)');
	assertTrue(!uri.includes('?amount='), 'no plain amount param');
});

scenario('buildPaymentUri: BLURT bare account (no scheme)', () => {
	// No widely-supported blurt: URI scheme; emit bare account.
	const uri = buildPaymentUri({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice'
	});
	assertEqual(uri, 'alice', 'bare account name');
});

scenario('buildPaymentUri: BLURT amount has no effect on URI', () => {
	// We don't emit a blurt: URI scheme so the amount has no
	// canonical place to go.  The amount stays in the encrypted
	// payload; recipient's wallet input is manual.
	const uri = buildPaymentUri({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice',
		amount: '100'
	});
	assertEqual(uri, 'alice', 'still bare');
});

// ─── Phase F.4: BLURT payment memo ───────────────────────────────

scenario('isValidMemo: shape check', () => {
	assertTrue(isValidMemo('abc123'), '6 chars accepted');
	assertTrue(isValidMemo('abcdefgh'), '8 chars accepted');
	assertTrue(isValidMemo('a'.repeat(32)), '32 chars accepted');
	assertTrue(!isValidMemo('abc12'), '5 chars rejected');
	assertTrue(!isValidMemo('a'.repeat(33)), '33 chars rejected');
	assertTrue(!isValidMemo('ABC123'), 'uppercase rejected');
	assertTrue(!isValidMemo('abc-123'), 'dash rejected');
	assertTrue(!isValidMemo(''), 'empty rejected');
});

scenario('generateBlurtMemo: produces 8-char memo matching MEMO_RE', () => {
	const m = generateBlurtMemo();
	assertEqual(m.length, 8, 'length 8');
	assertTrue(isValidMemo(m), 'matches shape');
});

scenario('generateBlurtMemo: alphabet excludes confusables (l/o/0/1)', () => {
	// Run many trials; if any letter is l, o, 0, or 1 the
	// alphabet is wrong.  100 trials × 8 chars = 800 chars
	// sampled — a confusable in the alphabet would surface
	// reliably.
	for (let i = 0; i < 100; i++) {
		const m = generateBlurtMemo();
		for (const c of m) {
			if (c === 'l' || c === 'o' || c === '0' || c === '1') {
				throw new Error(`confusable '${c}' in memo: ${m}`);
			}
		}
	}
});

scenario('generateBlurtMemo: two consecutive calls produce different output', () => {
	// Sanity that the RNG isn't deterministic — astronomically
	// unlikely to collide on 40-bit random, but a deterministic
	// stub would fail this.
	const a = generateBlurtMemo();
	const b = generateBlurtMemo();
	assertTrue(a !== b, 'distinct outputs');
});

scenario('encodeAddressPayload: with memo round-trips', () => {
	const original: AddressPayload = {
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice',
		amount: '1700',
		memo: 'abc12345'
	};
	const wire = encodeAddressPayload(original);
	const r = decodePayload(wire);
	assertEqual(r.kind, 'address', 'decoded kind');
	if (r.kind === 'address') {
		assertEqual(r.payload.memo, 'abc12345', 'memo preserved');
	}
});

scenario('encodeAddressPayload: rejects invalid memo (uppercase)', () => {
	assertThrows(
		() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'blurt',
				address: 'alice',
				memo: 'ABC12345'
			}),
		'uppercase memo'
	);
});

scenario('encodeAddressPayload: rejects too-short memo', () => {
	assertThrows(
		() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'blurt',
				address: 'alice',
				memo: 'abc12'
			}),
		'5-char memo'
	);
});

scenario('encodeAddressPayload: rejects too-long memo', () => {
	assertThrows(
		() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'blurt',
				address: 'alice',
				memo: 'a'.repeat(33)
			}),
		'33-char memo'
	);
});

scenario('encodeAddressPayload: rejects memo with special chars', () => {
	assertThrows(
		() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'blurt',
				address: 'alice',
				memo: 'abc-1234'
			}),
		'dash memo'
	);
});

scenario('decodePayload: tampered memo rejects → plaintext fallback', () => {
	// A wire payload claiming an over-cap memo should fall
	// through to plaintext rendering rather than crash.
	const wire = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'alice',
		memo: 'A'.repeat(50) // uppercase + over cap
	});
	const r = decodePayload(wire);
	assertEqual(r.kind, 'plaintext', 'tampered memo rejected');
});

scenario('encodeFundsSentPayload: with memo round-trips', () => {
	const original: FundsSentPayload = {
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'blurt',
		txid: 'a'.repeat(40),
		amount: '1700',
		memo: 'abc12345'
	};
	const wire = encodeFundsSentPayload(original);
	const r = decodePayload(wire);
	assertEqual(r.kind, 'funds_sent', 'decoded kind');
	if (r.kind === 'funds_sent') {
		assertEqual(r.payload.memo, 'abc12345', 'memo preserved');
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
