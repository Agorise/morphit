#!/usr/bin/env tsx
/**
 * apps/web/scripts/order-settled-elsewhere-payload-smoke.ts
 *
 * Structural Defense (cp496, t.txt #5) — the "order settled with someone
 * else" auto-reply is a SYSTEM chat payload: it carries only the order
 * permlink on the wire, and each recipient renders the Ken-approved warm
 * copy in the RECIPIENT's OWN locale (from chat.system.order_settled_elsewhere).
 *
 * This smoke pins the receiver half of the feature so a refactor can't
 * silently break it:
 *
 *   O-1: encode→decode roundtrip fidelity (kind + orderPermlink survive)
 *   O-2: the WIRE is snake_case (order_permlink), never camelCase
 *   O-3: encoder REJECTS an invalid order permlink
 *   O-4: decoder falls through to plaintext when order_permlink is MISSING
 *        (a text-free system message with no anchor is meaningless)
 *   O-5: decoder falls through to plaintext on a malformed permlink shape
 *   O-6: all 10 locales carry a non-empty chat.system.order_settled_elsewhere
 *        (the copy is what the recipient actually sees — parity is not enough,
 *        an empty string would render a blank bubble)
 *   O-7: ChatMessage.svelte renders the localized key for this kind (the copy
 *        must reach a reader; a decode with no render branch is a dead message)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	encodeOrderSettledElsewherePayload,
	decodePayload,
	type OrderSettledElsewherePayload
} from '../src/lib/chat/payload';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');

let passed = 0;
let failed = 0;
function pass(m: string): void {
	passed++;
	console.log(`  ✓ ${m}`);
}
function fail(m: string, detail?: string): void {
	failed++;
	console.error(`  ✗ ${m}${detail ? ` — ${detail}` : ''}`);
}

const GOOD_PERMLINK = 'sell-btc-usd-abc123';

// O-1: roundtrip fidelity
{
	const p: OrderSettledElsewherePayload = {
		v: 1,
		kind: 'morphit_order_settled_elsewhere',
		orderPermlink: GOOD_PERMLINK
	};
	const wire = encodeOrderSettledElsewherePayload(p);
	const decoded = decodePayload(wire);
	if (decoded.kind === 'order_settled_elsewhere' && decoded.payload.orderPermlink === GOOD_PERMLINK) {
		pass('O-1 encode→decode roundtrip preserves kind + orderPermlink');
	} else {
		fail('O-1 roundtrip fidelity', `kind=${decoded.kind}`);
	}
}

// O-2: wire is snake_case
{
	const wire = encodeOrderSettledElsewherePayload({
		v: 1,
		kind: 'morphit_order_settled_elsewhere',
		orderPermlink: GOOD_PERMLINK
	});
	if (wire.includes('"order_permlink"') && !wire.includes('orderPermlink')) {
		pass('O-2 wire uses snake_case order_permlink');
	} else {
		fail('O-2 wire snake_case', wire);
	}
}

// O-3: encoder rejects invalid permlink
{
	let threw = false;
	try {
		encodeOrderSettledElsewherePayload({
			v: 1,
			kind: 'morphit_order_settled_elsewhere',
			orderPermlink: 'not a valid permlink!'
		});
	} catch {
		threw = true;
	}
	if (threw) pass('O-3 encoder rejects invalid order permlink');
	else fail('O-3 encoder should reject invalid permlink');
}

// O-4: missing permlink → plaintext
{
	const decoded = decodePayload(
		JSON.stringify({ v: 1, kind: 'morphit_order_settled_elsewhere' })
	);
	if (decoded.kind === 'plaintext') pass('O-4 missing order_permlink decodes to plaintext');
	else fail('O-4 missing permlink → plaintext', `got: ${decoded.kind}`);
}

// O-5: malformed permlink shape → plaintext
{
	const decoded = decodePayload(
		JSON.stringify({
			v: 1,
			kind: 'morphit_order_settled_elsewhere',
			order_permlink: 'has spaces and !@#'
		})
	);
	if (decoded.kind === 'plaintext') pass('O-5 malformed permlink decodes to plaintext');
	else fail('O-5 malformed permlink → plaintext', `got: ${decoded.kind}`);
}

// O-6: all 10 locales carry a non-empty copy
{
	const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
	const missing: string[] = [];
	for (const lang of LOCALES) {
		const j = JSON.parse(
			readFileSync(resolve(webRoot, `src/lib/i18n/locales/${lang}.json`), 'utf-8')
		) as { chat?: { system?: { order_settled_elsewhere?: unknown } } };
		const v = j.chat?.system?.order_settled_elsewhere;
		if (typeof v !== 'string' || v.trim().length === 0) missing.push(lang);
	}
	if (missing.length === 0) {
		pass('O-6 all 10 locales carry a non-empty chat.system.order_settled_elsewhere');
	} else {
		fail('O-6 locale copy coverage', `missing/empty: ${missing.join(', ')}`);
	}
}

// O-7: ChatMessage renders the localized key for this kind
{
	const src = readFileSync(resolve(webRoot, 'src/lib/components/ChatMessage.svelte'), 'utf-8');
	const hasBranch = src.includes("decoded?.kind === 'order_settled_elsewhere'");
	const hasRender = src.includes("$_('chat.system.order_settled_elsewhere')");
	if (hasBranch && hasRender) {
		pass('O-7 ChatMessage has the render branch + emits the localized copy');
	} else {
		fail('O-7 render wiring', `branch=${hasBranch} render=${hasRender}`);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error(`\norder-settled-elsewhere-payload smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} order-settled-elsewhere-payload scenarios passed`);
