#!/usr/bin/env tsx
/**
 * apps/web/scripts/settled-elsewhere-announce-smoke.ts
 *
 * Structural Defense (cp497, t.txt #5) — the auto-reply SENDER. When an order
 * owner completes a trade with a chosen trader, `announceSettledElsewhere`
 * must E2E-send the text-free "order settled elsewhere" system message to every
 * OTHER inquirer on that order — and to nobody else.
 *
 * This pins the announcer's pure logic with fully mocked deps (no chain, no
 * crypto, no browser):
 *
 *   A-1: enumerates ONLY the other inquirers on the target order — excludes the
 *        counterparty we traded with and ourselves (the per-order source is
 *        already scoped to this order, so there is no cross-order noise)
 *   A-2: the wire sent is the order_settled_elsewhere payload for THIS order
 *        (text-free; the recipient renders the copy in their own locale)
 *   A-3: each broadcast carries recipient = the inquirer + order_permlink (the
 *        thread tag) + the encrypted ciphertext
 *   A-4: inquirers with no published chat pubkey are SKIPPED, not failed, and
 *        don't block the rest
 *   A-5: best-effort — one recipient's broadcast throwing does NOT stop the
 *        others (tallied as failed)
 *   A-6: no matching inquirers ⇒ {sent:0,skipped:0,failed:0}, zero broadcasts
 *   A-7: a fetchOrderInquirers failure is swallowed ⇒ {0,0,0}, never throws
 *   A-8: the sender self-copy (if the envelope carries one) rides along in the
 *        header so the owner can reread the auto-reply
 */
import {
	announceSettledElsewhere,
	type SettledElsewhereDeps
} from '../src/lib/chat/settledElsewhere';
import { decodePayload } from '../src/lib/chat/payload';
import type { LiveIdentity } from '../src/lib/crypto/keygen';

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

const ORDER = 'sell-btc-usd-abc123';
const ME = 'kentest3';
const COUNTERPARTY = 'kentest2';
const FAKE_LIVE = {} as unknown as LiveIdentity;

interface BroadcastRecord {
	readonly payload: Record<string, unknown>;
	readonly account: string;
}

/** Build fresh mock deps that record every encrypt + broadcast call. */
function mockDeps(opts: {
	inquirers: readonly string[];
	noPub?: ReadonlySet<string>;
	throwBroadcastFor?: ReadonlySet<string>;
	throwInquirers?: boolean;
	selfCopy?: boolean;
}): {
	deps: SettledElsewhereDeps;
	encryptCalls: { plaintext: string; recipient: string }[];
	broadcasts: BroadcastRecord[];
} {
	const encryptCalls: { plaintext: string; recipient: string }[] = [];
	const broadcasts: BroadcastRecord[] = [];
	let tag = 0;
	const deps: SettledElsewhereDeps = {
		fetchOrderInquirers: async () => {
			if (opts.throwInquirers) throw new Error('boom');
			return opts.inquirers;
		},
		fetchPeerChatPub: async (peer: string) =>
			opts.noPub?.has(peer) ? null : new Uint8Array([1, 2, 3]),
		deriveMyChatIdentity: async () => ({
			priv: new Uint8Array([9]),
			pub: new Uint8Array([8])
		}),
		encrypt: async (plaintext, _pub, _me, recipientAccount) => {
			encryptCalls.push({ plaintext, recipient: recipientAccount });
			return {
				ciphertext: `ct(${recipientAccount})`,
				ephemeralPub: 'eph',
				nonce: 'non',
				...(opts.selfCopy ? { selfCiphertext: 'selfct', selfNonce: 'selfnon' } : {})
			};
		},
		broadcast: async (_live, payload, account) => {
			const recipient = payload.recipient as string;
			if (opts.throwBroadcastFor?.has(recipient)) throw new Error('rc exceeded');
			broadcasts.push({ payload, account });
			return { block_num: 1, trx_id: 'trx' };
		},
		generateClientTag: () => `tag${++tag}`
	};
	return { deps, encryptCalls, broadcasts };
}

// The per-order inquirer set the counterparties endpoint returns for THIS order:
// everyone who messaged us about it. The endpoint is already per-order and excludes
// self server-side, so there is no other-order / order-less noise to filter — we
// still include the counterparty we chose (excluded because we traded with them)
// and a stray self entry (excluded defensively) to prove both guards fire.
const INQUIRERS: readonly string[] = [COUNTERPARTY, 'alice', 'bob', ME];

// A-1 / A-2 / A-3: enumeration + wire + payload shape
{
	const { deps, encryptCalls, broadcasts } = mockDeps({ inquirers: INQUIRERS });
	const res = await announceSettledElsewhere(deps, {
		orderPermlink: ORDER,
		counterparty: COUNTERPARTY,
		me: ME,
		live: FAKE_LIVE
	});
	const recipients = broadcasts.map((b) => b.payload.recipient).sort();
	const expected = ['alice', 'bob'];
	if (
		res.sent === 2 &&
		JSON.stringify(recipients) === JSON.stringify(expected) &&
		encryptCalls.length === 2
	) {
		pass('A-1 enumerates only other inquirers (excludes the counterparty and self)');
	} else {
		fail('A-1 enumeration', `sent=${res.sent} recipients=${JSON.stringify(recipients)}`);
	}

	// A-2: the wire is the order_settled_elsewhere payload for THIS order
	const allWireOk = encryptCalls.every((c) => {
		const d = decodePayload(c.plaintext);
		return d.kind === 'order_settled_elsewhere' && d.payload.orderPermlink === ORDER;
	});
	if (allWireOk) pass('A-2 wire is the order_settled_elsewhere payload for this order');
	else fail('A-2 wire payload', JSON.stringify(encryptCalls.map((c) => c.plaintext)));

	// A-3: each broadcast has recipient + order_permlink tag + ciphertext
	const shapeOk = broadcasts.every((b) => {
		const p = b.payload;
		const header = p.header as Record<string, unknown> | undefined;
		return (
			typeof p.recipient === 'string' &&
			p.order_permlink === ORDER &&
			typeof p.ciphertext === 'string' &&
			header !== undefined &&
			typeof header.client_tag === 'string' &&
			typeof header.ephemeral_pub === 'string' &&
			typeof header.nonce === 'string' &&
			b.account === ME
		);
	});
	if (shapeOk) pass('A-3 each broadcast carries recipient + order_permlink tag + ciphertext');
	else fail('A-3 payload shape', JSON.stringify(broadcasts.map((b) => b.payload)));
}

// A-4: skip inquirers with no chat pub
{
	const { deps, broadcasts } = mockDeps({
		inquirers: INQUIRERS,
		noPub: new Set(['alice'])
	});
	const res = await announceSettledElsewhere(deps, {
		orderPermlink: ORDER,
		counterparty: COUNTERPARTY,
		me: ME,
		live: FAKE_LIVE
	});
	if (res.sent === 1 && res.skipped === 1 && res.failed === 0 && broadcasts.length === 1) {
		pass('A-4 inquirers with no chat pubkey are skipped (not failed), rest still sent');
	} else {
		fail('A-4 skip no-pub', `sent=${res.sent} skipped=${res.skipped} failed=${res.failed}`);
	}
}

// A-5: best-effort — one broadcast throws, the other still lands
{
	const { deps, broadcasts } = mockDeps({
		inquirers: INQUIRERS,
		throwBroadcastFor: new Set(['alice'])
	});
	const res = await announceSettledElsewhere(deps, {
		orderPermlink: ORDER,
		counterparty: COUNTERPARTY,
		me: ME,
		live: FAKE_LIVE
	});
	const landed = broadcasts.map((b) => b.payload.recipient);
	if (res.sent === 1 && res.failed === 1 && landed.length === 1 && landed[0] === 'bob') {
		pass('A-5 best-effort — one failed broadcast does not block the others');
	} else {
		fail('A-5 best-effort', `sent=${res.sent} failed=${res.failed} landed=${JSON.stringify(landed)}`);
	}
}

// A-6: no matching inquirers ⇒ nothing sent
{
	const { deps, broadcasts } = mockDeps({
		inquirers: [COUNTERPARTY]
	});
	const res = await announceSettledElsewhere(deps, {
		orderPermlink: ORDER,
		counterparty: COUNTERPARTY,
		me: ME,
		live: FAKE_LIVE
	});
	if (res.sent === 0 && res.skipped === 0 && res.failed === 0 && broadcasts.length === 0) {
		pass('A-6 no matching inquirers ⇒ zero broadcasts');
	} else {
		fail('A-6 empty', `sent=${res.sent} broadcasts=${broadcasts.length}`);
	}
}

// A-7: fetchOrderInquirers failure is swallowed
{
	let threw = false;
	let res = { sent: -1, skipped: -1, failed: -1 };
	try {
		const { deps } = mockDeps({ inquirers: INQUIRERS, throwInquirers: true });
		res = await announceSettledElsewhere(deps, {
			orderPermlink: ORDER,
			counterparty: COUNTERPARTY,
			me: ME,
			live: FAKE_LIVE
		});
	} catch {
		threw = true;
	}
	if (!threw && res.sent === 0 && res.skipped === 0 && res.failed === 0) {
		pass('A-7 a fetchOrderInquirers failure is swallowed (returns 0/0/0, never throws)');
	} else {
		fail('A-7 graceful', `threw=${threw} res=${JSON.stringify(res)}`);
	}
}

// A-8: sender self-copy rides along in the header
{
	const { deps, broadcasts } = mockDeps({ inquirers: INQUIRERS, selfCopy: true });
	await announceSettledElsewhere(deps, {
		orderPermlink: ORDER,
		counterparty: COUNTERPARTY,
		me: ME,
		live: FAKE_LIVE
	});
	const allHaveSelf = broadcasts.every((b) => {
		const header = b.payload.header as Record<string, unknown>;
		return header.self_ciphertext === 'selfct' && header.self_nonce === 'selfnon';
	});
	if (broadcasts.length === 2 && allHaveSelf) {
		pass('A-8 sender self-copy rides in the header so the owner can reread it');
	} else {
		fail('A-8 self-copy', JSON.stringify(broadcasts.map((b) => b.payload.header)));
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error(`\nsettled-elsewhere-announce smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} settled-elsewhere-announce scenarios passed`);
