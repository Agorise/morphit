#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/fast-emit-ledger-smoke.ts
 *
 * THE TWO SMALL MODULES v1.18.0 ADDED, AND THE ONE THAT CAN LOSE A MESSAGE.
 *
 * `fastEmitLedger` stops the head tailer re-emitting a message the fast path
 * already delivered. That is a saving, and it is also the most dangerous thing
 * in this release: mark a transaction that was NOT actually delivered and the
 * head tailer will skip it, so the message never reaches the fast path at all.
 * It would still arrive durably a minute later, which is exactly the kind of
 * fault nobody notices until someone complains that chat is "sometimes slow".
 *
 * So the discipline under test is narrow and precise: the ledger records only
 * messages that were genuinely EMITTED — never one the block check dropped, and
 * never one whose gate could not be evaluated because the database faltered.
 *
 * The head tailer is RUN here, not described. It is driven with a stubbed chain
 * — a real `run()` loop, real `tick()`, real `scanBlock`, real parsing — so the
 * skip is observed rather than asserted from the shape of the source.
 *
 * `recentOutboundChat` is the other half: the instance's own memory of who it
 * just relayed a message for, which is what lets a reply notify the person who
 * started the conversation before the durable table catches up. Its bounds and
 * its expiry are tested here because it is fed by a public endpoint.
 */

import { Buffer } from 'node:buffer';

import {
	markFastEmitted,
	wasFastEmitted,
	fastEmitLedgerSize,
	TTL_MS as LEDGER_TTL_MS,
	_resetFastEmitLedgerForTest
} from '../src/indexer/fastEmitLedger';
import {
	noteOutboundChat,
	hasRecentOutboundChat,
	recentOutboundChatSize,
	TTL_MS as OUTBOUND_TTL_MS,
	_resetOutboundChatForTest
} from '../src/indexer/recentOutboundChat';
import {
	deliverVerifiedPush,
	_resetSeenForTest,
	type FastDeliveryGates
} from '../src/indexer/chatFastFederation';
import { chatEventBus } from '../src/indexer/chatEventBus';
import { HeadTailer, MAX_CATCHUP_BLOCKS } from '../src/indexer/headTailer';
import type { LocatedChatOp } from '../src/indexer/headTailer';
import type { Config } from '../src/config';
import type { Database } from '../src/db/pool';
import { broadcastRoute } from '../src/api/broadcast';
import type { BlurtClient } from '../src/blurt/client';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  ✗ ${m}`);
	if (d) console.log(`      ${d}`);
};

const sleep = (ms: number) =>
	new Promise<void>((r) => {
		setTimeout(r, ms);
	});

const located = (signer: string, recipient: string, tag: string): LocatedChatOp => ({
	signer,
	recipient,
	ciphertext: Buffer.from('x').toString('base64'),
	header: { client_tag: tag },
	clientTag: tag,
	orderPermlink: null
});

function gates(opts: {
	blocked?: boolean;
	blockThrows?: boolean;
	allowed?: boolean;
}): FastDeliveryGates {
	return {
		async recipientBlockedSender(): Promise<boolean> {
			if (opts.blockThrows === true) throw new Error('database down');
			return opts.blocked === true;
		},
		async fastNotifyAllowed(): Promise<boolean> {
			return opts.allowed !== false;
		},
		async enqueuePush(): Promise<void> {
			/* nothing to do */
		}
	};
}

console.log('fast-emit-ledger — only a real delivery may suppress the chain copy');
console.log('');

// ── 1. The ledger records ONLY an actual emit ────────────────────────
{
	_resetSeenForTest();
	_resetFastEmitLedgerForTest();
	const out = await deliverVerifiedPush(located('alice', 'bob', 't1'), 'trx-emitted', gates({}));
	if (out === 'emitted' && wasFastEmitted('trx-emitted'))
		ok('a delivered message is recorded, so the chain copy can be skipped');
	else bad(`outcome=${out}, recorded=${wasFastEmitted('trx-emitted')}`);
}

{
	_resetSeenForTest();
	_resetFastEmitLedgerForTest();
	const out = await deliverVerifiedPush(
		located('alice', 'bob', 't2'),
		'trx-blocked',
		gates({ blocked: true })
	);
	if (out === 'blocked' && !wasFastEmitted('trx-blocked'))
		ok('a message the BLOCK LIST dropped is not recorded');
	else
		bad(
			`a blocked message was recorded (outcome=${out})`,
			'the head tailer would then skip it too — which happens to reach the same answer, ' +
				'but for the wrong reason, and only while both checks agree'
		);
}

{
	_resetSeenForTest();
	_resetFastEmitLedgerForTest();
	const out = await deliverVerifiedPush(
		located('alice', 'bob', 't3'),
		'trx-dbdown',
		gates({ blockThrows: true })
	);
	if (out === 'block_check_failed' && !wasFastEmitted('trx-dbdown'))
		ok('a message whose block check COULD NOT BE EVALUATED is not recorded');
	else
		bad(
			`a message that was never delivered was recorded (outcome=${out})`,
			'this is the dangerous one: a momentary database failure on the fast path would ' +
				'also suppress the head tailer, and the message would drop off the fast path ' +
				'entirely instead of merely being delayed'
		);
}

// ── 2. The head tailer, RUN, honours the ledger ──────────────────────
//
// Driven with a stubbed chain but a real run loop: real tick, real scanBlock,
// real op parsing, real gates.
interface FakeBlock {
	timestamp: string;
	transactions: { operations: unknown[] }[];
	transaction_ids: string[];
}

function chatOp(signer: string, recipient: string, tag: string): unknown {
	return [
		'custom_json',
		{
			id: 'morphit_chat_v1',
			required_auths: [],
			required_posting_auths: [signer],
			json: JSON.stringify({
				recipient,
				ciphertext: Buffer.from('an encrypted body').toString('base64'),
				header: {
					client_tag: tag,
					ephemeral_pub: Buffer.from('ephemeral-public-key-32-bytes!!!').toString('base64'),
					nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64')
				}
			})
		}
	];
}

/** Run the real tailer over one block and report what reached the bus. */
async function runTailerOverBlock(trxId: string, tag: string): Promise<string[]> {
	const block: FakeBlock = {
		timestamp: new Date().toISOString().slice(0, 19),
		transactions: [{ operations: [chatOp('alice', 'bob', tag)] }],
		transaction_ids: [trxId]
	};

	let served = false;
	const blurt = {
		getDynamicGlobalProperties: async () => ({ head_block_number: served ? 11 : 10 }),
		getBlock: async (n: number) => (n === 11 ? block : null)
	} as unknown as BlurtClient;

	const db = {
		query: async () => ({ rows: [{ exists: false }], rowCount: 1 })
	} as unknown as Database;

	const config = { fastPathIntervalMs: 25 } as unknown as Config;

	const seenTags: string[] = [];
	const off = chatEventBus.onFast((ev) => {
		if (ev.clientTag !== null) seenTags.push(ev.clientTag);
	});

	const tailer = new HeadTailer(config, db, blurt);
	const running = tailer.run();
	// First tick establishes the watermark at 10; then the head advances to 11.
	await sleep(80);
	served = true;
	await sleep(200);
	tailer.stop();
	await running.catch(() => undefined);
	off();
	return seenTags;
}

{
	_resetFastEmitLedgerForTest();
	const tags = await runTailerOverBlock('trx-chain-1', 'tag-chain-1');
	if (tags.includes('tag-chain-1'))
		ok('the head tailer emits a message the fast path never delivered');
	else
		bad(
			'the head tailer did not emit an undelivered message',
			'the skip is over-reaching: the chain copy is the only thing standing behind a ' +
				'message the fast path missed'
		);
}

{
	_resetFastEmitLedgerForTest();
	// Exactly what a local delivery or a peer push would have left behind.
	markFastEmitted('trx-chain-2');
	const tags = await runTailerOverBlock('trx-chain-2', 'tag-chain-2');
	if (!tags.includes('tag-chain-2'))
		ok('and it SKIPS one the fast path already delivered — no second copy');
	else
		bad(
			'the head tailer re-emitted a message that was already delivered',
			'the client collapses the pair so nobody sees double, but it is wasted work and ' +
				'double the traffic on the connections where that costs most'
		);
}

{
	// The safety case, end to end: a fast attempt that FAILED must leave the
	// chain copy free to do its job.
	_resetSeenForTest();
	_resetFastEmitLedgerForTest();
	await deliverVerifiedPush(
		located('alice', 'bob', 'tag-chain-3'),
		'trx-chain-3',
		gates({ blockThrows: true })
	);
	const tags = await runTailerOverBlock('trx-chain-3', 'tag-chain-3');
	if (tags.includes('tag-chain-3'))
		ok('a FAILED fast attempt does not suppress the chain copy — the message still arrives');
	else
		bad(
			'a failed fast attempt suppressed the head tailer, and the message was lost from ' +
				'the fast path entirely',
			'this is the fault the ledger is written to avoid: it records deliveries, not attempts'
		);
}

// ── 3. The ledger is bounded and expires ─────────────────────────────
{
	_resetFastEmitLedgerForTest();
	for (let i = 0; i < 25_000; i++) markFastEmitted(`bulk-${i}`);
	const size = fastEmitLedgerSize();
	if (size <= 20_000) ok(`the ledger holds at its bound under a flood (${size} entries)`);
	else bad(`the ledger grew to ${size}; a busy instance would grow it without limit`);

	if (wasFastEmitted('bulk-24999') && !wasFastEmitted('bulk-0'))
		ok('and it evicts the oldest first, keeping what is still relevant');
	else
		bad(
			'eviction kept the wrong end',
			`newest=${wasFastEmitted('bulk-24999')} oldest=${wasFastEmitted('bulk-0')}`
		);
}

// ── 4. The outbound memory: bounds, expiry, and what it refuses ──────
{
	_resetOutboundChatForTest();
	noteOutboundChat('buyer', 'seller');
	if (hasRecentOutboundChat('buyer', 'seller'))
		ok('a relayed message is remembered, so the reply can notify the sender');
	else bad('a relayed message was not remembered');

	if (!hasRecentOutboundChat('seller', 'buyer'))
		ok('and it is DIRECTIONAL — remembering buyer→seller says nothing about seller→buyer');
	else
		bad(
			'the memory is not directional',
			'a stranger messaging you would then look like someone you had written to'
		);

	if (hasRecentOutboundChat('BUYER', 'Seller'))
		ok('account names match case-insensitively, as Blurt names are lower-case anyway');
	else bad('a differently-cased account name missed its entry');

	_resetOutboundChatForTest();
	noteOutboundChat('alice', 'alice');
	if (recentOutboundChatSize() === 0) ok('a message to yourself is not recorded');
	else bad('a self-pair was recorded');

	_resetOutboundChatForTest();
	for (let i = 0; i < 25_000; i++) noteOutboundChat(`user${i}`, 'target');
	const size = recentOutboundChatSize();
	if (size <= 20_000) ok(`the outbound memory holds at its bound (${size} entries)`);
	else
		bad(
			`the outbound memory grew to ${size}`,
			'it is fed by a public endpoint, so an unbounded map is a way to exhaust memory'
		);
}

// ── THE RELAY LOG IS WRITTEN ONLY AFTER THE CHAIN ACCEPTS ────────────
//
// An entry here means "a Blurt node took this transaction from us", and that is
// the entire reason it may be trusted to relax the notification gate: the node
// validated the signature and posting authority, so the sender is real rather
// than merely claimed. Written before the broadcast instead, anyone could
// assert a pair — and therefore earn the right to notify that person — by
// posting a transaction that was never going to be accepted. Nothing tested
// the ordering, and moving the call above the broadcast passed every test.
{
	_resetOutboundChatForTest();

	const rejecting = {
		callCondenser: async () => {
			// What a node returns for a transaction it will not take: not a
			// transport failure, a rejection. The route surfaces it as a 400.
			throw new Error('missing required posting authority');
		}
	} as unknown as BlurtClient;

	const route = broadcastRoute(rejecting);
	const res = await route.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			trx: {
				ref_block_num: 1,
				ref_block_prefix: 1,
				expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
				operations: [chatOp('mallory', 'victim', 'rejected-tag')],
				extensions: [],
				signatures: ['aa'.repeat(32)]
			},
			chat_async: true
		})
	});

	if (res.status === 400) ok('a chat send the chain REJECTED is reported as a failure');
	else bad(`a rejected chat send was answered ${res.status}`);

	if (!hasRecentOutboundChat('mallory', 'victim'))
		ok('and it left nothing in the relay log — a rejected send cannot mint permission');
	else
		bad(
			'a REJECTED chat send was recorded in the relay log',
			'anyone could then notify that person by posting a transaction that was never ' +
				'going to be accepted — the log would be asserting a pair the chain refused'
		);
}

// ── THE BOUNDS EXPIRE, AND THE LEDGER'S OUTLASTS THE TAILER ──────────
//
// Both of these tables are correct only while they forget on schedule, and
// neither expiry was exercised: the TTLs are minutes long, so nothing could
// reach them without waiting out a real one. Deleting the expiry check from
// either module used to pass every test in this file. Both now take an
// injectable clock (production never passes it) so the boundary can be landed
// on exactly.
{
	_resetFastEmitLedgerForTest();
	const t0 = 1_000_000_000_000;
	markFastEmitted('expiring-trx', t0);

	if (wasFastEmitted('expiring-trx', t0 + LEDGER_TTL_MS))
		ok('a ledger entry is still live at exactly its TTL');
	else bad('a ledger entry expired early, so the head tailer will re-emit a delivered message');

	if (!wasFastEmitted('expiring-trx', t0 + LEDGER_TTL_MS + 1))
		ok('and is gone one millisecond later');
	else
		bad(
			'a ledger entry outlived its TTL',
			'the table is bounded by count as well, so this is a leak of staleness rather ' +
				'than of memory — but a stale entry suppresses a real message'
		);

	// The prune must actually remove it, not merely answer no. An entry that
	// lingers occupies the bound and pushes a live one out.
	markFastEmitted('fresh-trx', t0 + LEDGER_TTL_MS + 1);
	if (fastEmitLedgerSize() === 1) ok('and the expired entry is swept, not just hidden');
	else bad(`${fastEmitLedgerSize()} entries remain; the expired one was never removed`);

	// THE LEDGER MUST OUTLAST THE TAILER'S REACH. The tailer skips ahead only
	// when it is more than MAX_CATCHUP_BLOCKS behind, so it will scan a block
	// almost that old — and if the ledger has forgotten by then, a tailer
	// catching up after any stall re-emits everything the fast path delivered.
	// The two numbers live in different modules (importing one into the other
	// would be a cycle), so this is what stops them drifting apart.
	const worstCatchupMs = MAX_CATCHUP_BLOCKS * 3_000;
	if (LEDGER_TTL_MS > worstCatchupMs)
		ok(
			`the ledger TTL (${Math.round(LEDGER_TTL_MS / 1000)}s) outlasts the tailer's worst ` +
				`catch-up (${Math.round(worstCatchupMs / 1000)}s)`
		);
	else
		bad(
			`the ledger forgets after ${Math.round(LEDGER_TTL_MS / 1000)}s but the tailer can ` +
				`scan a block ${Math.round(worstCatchupMs / 1000)}s old`,
			'a tailer catching up after a stall will re-emit every message the fast path ' +
				'already delivered — the exact failure this module exists to prevent, arriving ' +
				'in exactly the circumstance that produces it'
		);
}

{
	_resetOutboundChatForTest();
	const t0 = 1_000_000_000_000;
	noteOutboundChat('alice', 'bob', t0);

	if (hasRecentOutboundChat('alice', 'bob', t0 + OUTBOUND_TTL_MS))
		ok('a relay-log entry is still live at exactly its TTL');
	else bad('a relay-log entry expired early, so a legitimate reply stops notifying');

	if (!hasRecentOutboundChat('alice', 'bob', t0 + OUTBOUND_TTL_MS + 1))
		ok('and is gone one millisecond later');
	else
		bad(
			'a relay-log entry outlived its TTL',
			'this entry is what lets a sender notify someone who has not replied yet — ' +
				'left standing, that permission never lapses'
		);

	noteOutboundChat('carol', 'dave', t0 + OUTBOUND_TTL_MS + 1);
	if (recentOutboundChatSize() === 1) ok('and the expired entry is swept, not just hidden');
	else bad(`${recentOutboundChatSize()} entries remain; the expired one was never removed`);

	// It must also outlast the thing it exists to cover: the durable table is
	// 45-63 seconds behind, and this is what answers the question in the
	// meantime. A TTL shorter than that lag would leave a gap where neither
	// source knows.
	if (OUTBOUND_TTL_MS > 63_000)
		ok(`and it outlasts the durable lag it covers (${Math.round(OUTBOUND_TTL_MS / 1000)}s)`);
	else
		bad(
			`the relay log forgets after ${Math.round(OUTBOUND_TTL_MS / 1000)}s, inside the ` +
				'45-63s the durable table takes to catch up — leaving a window where neither ' +
				'source can answer'
		);
}

// ── The ledger holds when two routes deliver at ONCE (v1.18.0 review, R8) ──
// The check and the mark straddled the notify-gate query, so two deliveries of
// one transaction in flight together — a local delivery and a peer's push —
// both passed the check and both emitted. Sequential calls never see it.
{
	_resetSeenForTest();
	_resetFastEmitLedgerForTest();
	const slow: FastDeliveryGates = {
		...gates({}),
		async fastNotifyAllowed(): Promise<boolean> {
			for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
			return true;
		}
	};
	const emits: string[] = [];
	const off = chatEventBus.onFast((ev) => emits.push(ev.clientTag ?? ''));
	await Promise.all([
		deliverVerifiedPush(located('alice', 'bob', 't-twin'), 'trx-twin', slow),
		deliverVerifiedPush(located('alice', 'bob', 't-twin'), 'trx-twin', slow)
	]);
	off();
	if (emits.length === 1) ok('two routes delivering one transaction at once emit it once');
	else
		bad(
			`two concurrent deliveries emitted ${emits.length} times`,
			'the ledger check and its mark straddled an await'
		);
}

console.log('');
console.log('────────────────────────────────────────────────────────');
if (fail === 0) {
	console.log(`✓ all ${pass} fast-emit-ledger scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
