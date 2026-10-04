#!/usr/bin/env tsx
/**
 * chat-expiry-lead-parity-smoke — the sender's clock, recovered correctly.
 *
 * A chat message delivered by the fast path carries no timestamp of its own.
 * The receiving instance recovers one from the transaction's signed
 * `expiration`, by subtracting the interval the client put between the chain
 * head it read and the expiry it signed. The transcript is sorted strictly by
 * that value.
 *
 * WHY THE VALUE IS SOUND. It is not a clock reading. The client builds the
 * expiry from the CHAIN's head block time (`getRefBlockInfo` in
 * apps/web/src/lib/blurt/sign.ts), and every instance in the federation reads
 * the same chain — so two operators whose servers disagree about the time
 * cannot put each other's messages in the wrong order. That is a real property
 * of the design and it is why no clock synchronisation is required anywhere.
 *
 * WHY IT NEEDS A TEST. The interval is written down TWICE, in two packages,
 * with nothing linking them: `head + 60_000` in the browser signer, and
 * `CLIENT_EXPIRY_LEAD_MS` in the indexer. Change one and every fast-path
 * message's recovered time shifts by the difference. Nothing errors. Messages
 * still arrive, still verify, still render — they render in the wrong ORDER,
 * and only against messages that came by the other route, which is the hardest
 * kind of ordering bug to notice and the easiest to introduce while tidying a
 * constant.
 *
 * WHAT IS ASSERTED. The round trip, not the token: an expiry built exactly the
 * way the client builds it, handed to the exact function the receiving instance
 * uses, must give back the head time the client started from. A grep for
 * `60_000` would pass against two files that had drifted to the same wrong
 * number in different places; this cannot.
 */

import { readFileSync } from 'node:fs';
import { CLIENT_EXPIRY_LEAD_MS, sentAtFromExpiry } from '../src/indexer/chatFastFederation.ts';

let pass = 0;
const fails: string[] = [];
const check = (d: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log('  ✓ ' + d);
	} else {
		fails.push(d);
		console.log('  ✗ ' + d);
		if (detail) console.log('      ' + detail);
	}
};

console.log('\n── chat expiry-lead parity (client ↔ indexer) ─────────\n');

// ── the client's half, read from the signer that chat actually uses ──
//
// `broadcastChatMessage` → `signCustomJsonTx` → `getRefBlockInfo`, so this is
// the one that governs a chat message. The value is EXTRACTED and then used in
// an assertion, rather than merely asserted to exist — the difference between
// checking a behaviour and checking a spelling.
const signSrc = readFileSync(new URL('../../web/src/lib/blurt/sign.ts', import.meta.url), 'utf8');
const leadMatch = /const expiration = new Date\(head \+ ([\d_]+)\)/.exec(signSrc);
const clientLeadMs = leadMatch === null ? NaN : Number(leadMatch[1]?.replace(/_/g, ''));

check(
	'the client signer still derives its expiry from the chain head',
	leadMatch !== null,
	'getRefBlockInfo no longer matches `new Date(head + N)`. If the expiry is now ' +
		'built from a wall clock instead of the chain head, message ordering across ' +
		'instances stops being skew-proof and this smoke must be rewritten, not relaxed.'
);

check(
	`the client lead parses (${Number.isFinite(clientLeadMs) ? clientLeadMs : '??'} ms)`,
	Number.isFinite(clientLeadMs) && clientLeadMs > 0
);

// ── THE ROUND TRIP ──────────────────────────────────────────────────
if (Number.isFinite(clientLeadMs)) {
	// A head block time with no sub-second part, as the chain reports it.
	const head = Date.parse('2026-09-20T12:34:56Z');
	// Exactly how the client builds it: chain head + lead, ISO, no ms, no Z.
	const expiration = new Date(head + clientLeadMs).toISOString().slice(0, -5);
	// Far enough ahead that the "never in the future" clamp is not what is
	// being measured — the clamp has its own case below.
	const arrived = new Date(head + 2_000);

	const recovered = sentAtFromExpiry(expiration, arrived).getTime();
	check(
		'the indexer recovers the exact chain-head time the client signed against',
		recovered === head,
		`recovered ${new Date(recovered).toISOString()} from an expiry the client would ` +
			`have built for head ${new Date(head).toISOString()} — a drift of ` +
			`${recovered - head} ms. The client lead is ${clientLeadMs} ms and the indexer ` +
			`subtracts ${CLIENT_EXPIRY_LEAD_MS} ms; they must be the same number, in ` +
			'apps/web/src/lib/blurt/sign.ts and apps/indexer/src/indexer/chatFastFederation.ts.'
	);

	check(
		'and the two constants agree outright',
		clientLeadMs === CLIENT_EXPIRY_LEAD_MS,
		`client ${clientLeadMs} ms vs indexer ${CLIENT_EXPIRY_LEAD_MS} ms`
	);
}

// ── the clamp, which is a separate promise ──────────────────────────
//
// A message cannot have been sent later than it arrived. Without the clamp a
// peer could hand us an expiry far in the future and park its message at the
// bottom of every transcript it landed in — or, with a modest one, jump the
// queue ahead of messages that really were sent first.
{
	const arrived = new Date('2026-09-20T12:00:00Z');
	const futureExpiry = new Date(arrived.getTime() + 30 * 60_000).toISOString().slice(0, -5);
	check(
		'a sender claiming the future is clamped to arrival',
		sentAtFromExpiry(futureExpiry, arrived).getTime() === arrived.getTime()
	);
}

// ── unusable input falls back to arrival, never to NaN ───────────────
{
	const arrived = new Date('2026-09-20T12:00:00Z');
	check(
		'a missing expiry falls back to arrival',
		sentAtFromExpiry(undefined, arrived).getTime() === arrived.getTime()
	);
	check(
		'a non-string expiry falls back to arrival',
		sentAtFromExpiry(12345, arrived).getTime() === arrived.getTime()
	);
	check(
		'an unparseable expiry falls back to arrival',
		sentAtFromExpiry('not-a-date', arrived).getTime() === arrived.getTime()
	);
}

// ── the zone-less expiry, checked under a FORCED offset ─────────────
//
// Graphene writes the expiry without a timezone, and JavaScript reads a
// zone-less date-time as LOCAL. Get that wrong and every fast-path message is
// misdated by the host's offset — hours, on any host outside UTC, enough to
// reorder a whole day of a transcript.
//
// THE TRAP THIS BLOCK EXISTS TO AVOID. Asserted on the host's own timezone,
// this check has teeth only when the host is not UTC. A Morphit instance is
// usually a server, and a server is usually UTC — so the assertion would have
// been silently vacuous on exactly the machines it protects, and green
// everywhere. It is therefore run under a timezone this smoke picks, and the
// forcing is itself asserted rather than assumed.
{
	const originalTz = process.env.TZ;
	try {
		process.env.TZ = 'Pacific/Honolulu'; // UTC-10, no DST
		const offsetMinutes = new Date().getTimezoneOffset();
		check(
			`the forced timezone took (offset ${offsetMinutes} min)`,
			offsetMinutes !== 0,
			'reassigning process.env.TZ did not move the clock on this runtime, so the ' +
				'zone-less check below would pass whatever the code does. Run this smoke ' +
				'with TZ set to a non-UTC zone in the environment instead.'
		);

		const head = Date.parse('2026-09-20T12:34:56Z');
		const naive = new Date(head + CLIENT_EXPIRY_LEAD_MS).toISOString().slice(0, -5);
		const recovered = sentAtFromExpiry(naive, new Date(head + 2_000)).getTime();
		check(
			'a zone-less expiry is read as UTC, not as host-local time',
			recovered === head,
			`recovered ${new Date(recovered).toISOString()} instead of ` +
				`${new Date(head).toISOString()} — off by ${(recovered - head) / 60_000} minutes, ` +
				"which is this host's UTC offset."
		);

		// ...and the two spellings must agree, which is the property in its own
		// right: the chain may send either.
		const zoned = `${naive}Z`;
		check(
			'both spellings of the same instant recover the same time',
			sentAtFromExpiry(naive, new Date(head + 2_000)).getTime() ===
				sentAtFromExpiry(zoned, new Date(head + 2_000)).getTime()
		);
	} finally {
		if (originalTz === undefined) delete process.env.TZ;
		else process.env.TZ = originalTz;
	}
}

console.log('');
console.log('─'.repeat(54));
if (fails.length === 0) {
	console.log(`✓ all ${pass} chat-expiry-lead-parity checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fails.length} FAILED, ${pass} passed`);
	process.exit(1);
}
