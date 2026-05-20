#!/usr/bin/env tsx
/**
 * payjoin-uri-wire-shape-smoke.
 *
 * Part 122 cp26 sentinel for the PayJoin (BIP-78) endpoint
 * field, plus the cp26 inline-fix for the cp3-era latent bug
 * where USDT `network` was dropped on the wire.
 *
 * Asserts:
 *  - buildPaymentUri emits `pj=<endpoint>` for BTC payloads
 *  - buildPaymentUri does NOT emit `pj=` for non-BTC payloads
 *  - encodeAddressPayload roundtrips payjoinEndpoint via wire
 *  - encodeAddressPayload rejects payjoinEndpoint on non-BTC
 *  - encodeAddressPayload rejects malformed URLs
 *  - USDT `network` field now correctly roundtrips through
 *    encode/decode (the cp3 latent bug fix)
 *  - FundsSentPayload network field also roundtrips (symmetric
 *    fix)
 */

import {
	encodeAddressPayload,
	encodeFundsSentPayload,
	decodePayload,
	buildPaymentUri
} from '../src/lib/chat/payload';

let failed = 0;
let passed = 0;

function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── payjoin-uri-wire-shape smoke ──────────────────────\n');

// ── Scenario 1 — BTC URI gets pj= when endpoint provided ────
{
	const uri = buildPaymentUri({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		payjoinEndpoint: 'https://payjoin.example.org/bip78'
	});
	if (uri.includes('pj=')) pass('BTC URI carries pj= param');
	else fail('BTC URI carries pj= param', `got "${uri}"`);
}

// ── Scenario 2 — BTC URI omits pj= when not provided ─────────
{
	const uri = buildPaymentUri({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
	});
	if (!uri.includes('pj=')) pass('BTC URI omits pj= when no endpoint');
	else fail('BTC URI omits pj= when no endpoint', `got "${uri}"`);
}

// ── Scenario 3 — LTC URI cannot carry pj= via encoder ────────
{
	try {
		encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'ltc',
			address: 'LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL',
			payjoinEndpoint: 'https://example.org'
		});
		fail('LTC + payjoinEndpoint rejected', 'encoder did not throw');
	} catch {
		pass('LTC + payjoinEndpoint rejected by encoder');
	}
}

// ── Scenario 4 — malformed PayJoin URL rejected ──────────────
{
	try {
		encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			payjoinEndpoint: 'not a url'
		});
		fail('malformed PayJoin URL rejected', 'encoder did not throw');
	} catch {
		pass('malformed PayJoin URL rejected by encoder');
	}
}

// ── Scenario 5 — payjoinEndpoint roundtrips through wire ─────
{
	const payload = {
		v: 1 as const,
		kind: 'morphit_addr' as const,
		method: 'btc' as const,
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		payjoinEndpoint: 'https://payjoin.example.org/bip78'
	};
	const wire = encodeAddressPayload(payload);
	const decoded = decodePayload(wire);
	if (
		decoded.kind === 'address' &&
		decoded.payload.payjoinEndpoint === payload.payjoinEndpoint
	) {
		pass('payjoinEndpoint roundtrips encode → decode');
	} else {
		fail(
			'payjoinEndpoint roundtrips encode → decode',
			`got ${JSON.stringify(decoded)}`
		);
	}
}

// ── Scenario 6 — cp3 latent bug fix: USDT network roundtrips ──
{
	const payload = {
		v: 1 as const,
		kind: 'morphit_addr' as const,
		method: 'usdt' as const,
		address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
		network: 'erc20'
	};
	const wire = encodeAddressPayload(payload);
	const decoded = decodePayload(wire);
	if (decoded.kind === 'address' && decoded.payload.network === 'erc20') {
		pass('cp3 latent fix: USDT network roundtrips through wire');
	} else {
		fail(
			'cp3 latent fix: USDT network roundtrips through wire',
			`got ${JSON.stringify(decoded)}`
		);
	}
}

// ── Scenario 7 — non-USDT carrying network field is rejected ─
{
	// Hand-craft a wire payload with network field on a BTC payload —
	// decoder should reject.  (Can't go through encoder; the encoder
	// would just include it, but decoder is the gate.)
	const malformed = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'btc',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		network: 'erc20'
	});
	const decoded = decodePayload(malformed);
	if (decoded.kind === 'plaintext') {
		pass('non-USDT + network field rejected by decoder');
	} else {
		fail('non-USDT + network field rejected by decoder', `got ${JSON.stringify(decoded)}`);
	}
}

// ── Scenario 8 — invalid USDT network value rejected ─────────
{
	const malformed = JSON.stringify({
		v: 1,
		kind: 'morphit_addr',
		method: 'usdt',
		address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
		network: 'omni' // deprecated Omni Layer, not in our enum
	});
	const decoded = decodePayload(malformed);
	if (decoded.kind === 'plaintext') {
		pass('invalid USDT network value rejected by decoder');
	} else {
		fail('invalid USDT network value rejected', `got ${JSON.stringify(decoded)}`);
	}
}

// ── Scenario 9 — FundsSent USDT network also roundtrips ──────
{
	const payload = {
		v: 1 as const,
		kind: 'morphit_funds_sent' as const,
		method: 'usdt' as const,
		// TRC-20 txids are 64 hex chars WITHOUT a 0x prefix (Tron
		// convention); the EVM '0x'+64-hex shape is only for erc20
		// / bep20.  Using EVM shape here would fail validateUsdtTxid
		// and crash the smoke before reaching the roundtrip check.
		txid: 'a'.repeat(64),
		network: 'trc20'
	};
	const wire = encodeFundsSentPayload(payload);
	const decoded = decodePayload(wire);
	if (
		decoded.kind === 'funds_sent' &&
		decoded.payload.network === 'trc20'
	) {
		pass('cp3 symmetric fix: USDT FundsSent network roundtrips');
	} else {
		fail(
			'cp3 symmetric fix: USDT FundsSent network roundtrips',
			`got ${JSON.stringify(decoded)}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\npayjoin-uri-wire-shape smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} payjoin-uri-wire-shape scenarios passed`);
