/**
 * fastchat-abuse-guards-smoke — the federated fast-chat path under abuse
 * (rv1-1 … rv1-6, rv2-3, rv2-7).
 *
 * Every scenario here is a reviewer's reproduction turned into an assertion,
 * and each one was run against the code before its fix and seen to fail. They
 * drive the REAL route, dispatcher, verifier and gates — the database and the
 * peers are doubles, the cryptography and the queueing are not.
 *
 *   rv1-1  /v1/broadcast fanned out unverified, oversized, chain-rejected and
 *          non-chat-only transactions (and the client's raw object) to every
 *          peer before the chain had seen them.
 *   rv1-2  the "recent outbound" notify shortcut ran before the order tag was
 *          validated, in BOTH the tailer and the intake.
 *   rv1-3  junk signatures could spend the one global key-refresh budget and
 *          starve senders whose rows were merely unconfirmed.
 *   rv1-4  one account filled the replay memory and locked everyone out; a
 *          junk flood in one claimed name filled the intake queue.
 *   rv1-5  messages arriving while a key refresh was in flight were refused.
 *   rv1-6  the notify gate judged order liveness by the sender-chosen sentAt.
 *   rv2-3  the fast path's key refresh trusted ONE RPC endpoint.
 *   rv2-7  an unknown chain head counted as "durable record is current".
 */

import { Buffer } from 'node:buffer';
import * as http from 'node:http';
import type pg from 'pg';

import * as fed from '../src/indexer/chatFastFederation';
import { federationChatFastRoute, gatesFromDb } from '../src/api/federationChatFast';
import { broadcastRoute } from '../src/api/broadcast';
import { ChatFastDispatcher } from '../src/indexer/chatFastDispatcher';
import { HeadTailer, type LocatedChatOp } from '../src/indexer/headTailer';
import { chatEventBus } from '../src/indexer/chatEventBus';
import { noteOutboundChat, _resetOutboundChatForTest } from '../src/indexer/recentOutboundChat';
import { _resetFastEmitLedgerForTest } from '../src/indexer/fastEmitLedger';
import { BlurtClient } from '../src/blurt/client';

process.env.MORPHIT_RPC_HEALTH_STATE = `/tmp/fastchat-abuse-guards-${process.pid}.json`;

let passed = 0;
let failed = 0;
function ok(msg: string): void {
	passed++;
	console.log(`  ✓ ${msg}`);
}
function bad(msg: string, detail?: string): void {
	failed++;
	console.log(`  ✗ ${msg}`);
	if (detail !== undefined) console.log(`      ${detail}`);
}
function check(cond: boolean, msg: string, detail?: string): void {
	if (cond) ok(msg);
	else bad(msg, detail);
}
const sleep = (ms: number): Promise<void> =>
	new Promise<void>((r) => {
		setTimeout(r, ms);
	});
async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond() && Date.now() < end) await sleep(20);
}

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');
type Key = ReturnType<typeof PrivateKey.fromSeed>;
const key = (seed: string): Key => PrivateKey.fromSeed(`fastchat-abuse-guards:${seed}`);
const pub = (k: Key): string => k.createPublic().toString();

let seq = 0;
interface TxOpts {
	sender: string;
	recipient?: string;
	signWith: Key;
	perm?: string;
	clientTag?: string;
	/** Expiry offset from now, ms. */
	expMs?: number;
	extraOp?: [string, Record<string, unknown>];
	/** Fields added to the chat op body that the serializer ignores. */
	bodyExtra?: Record<string, unknown>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tx(o: TxOpts): any {
	seq++;
	const payload: Record<string, unknown> = {
		recipient: o.recipient ?? 'bob',
		ciphertext: Buffer.from(`hello-${seq}`).toString('base64'),
		header: { client_tag: o.clientTag ?? `t-${seq}-${Math.random().toString(36).slice(2)}` }
	};
	if (o.perm !== undefined) payload.order_permlink = o.perm;
	const ops: unknown[] = [
		[
			'custom_json',
			{
				required_auths: [],
				required_posting_auths: [o.sender],
				id: 'morphit_chat_v1',
				json: JSON.stringify(payload),
				...(o.bodyExtra ?? {})
			}
		]
	];
	if (o.extraOp !== undefined) ops.push(o.extraOp);
	return cryptoUtils.signTransaction(
		{
			ref_block_num: seq & 0xffff,
			ref_block_prefix: 1000 + seq,
			expiration: new Date(Date.now() + (o.expMs ?? 45_000)).toISOString().slice(0, 19),
			operations: ops,
			extensions: []
		} as never,
		[o.signWith]
	);
}
const res = <R extends pg.QueryResultRow>(rows: unknown[]): pg.QueryResult<R> =>
	({ rows: rows as R[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }) as never;
const post = (
	app: { request: (p: string, i: RequestInit) => Response | Promise<Response> },
	body: unknown
): Promise<Response> =>
	Promise.resolve(
		app.request('/', {
			method: 'POST',
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' }
		})
	);
const resetAll = (): void => {
	fed._resetSeenForTest();
	fed._resetKeyRefreshForTest();
	_resetFastEmitLedgerForTest();
	_resetOutboundChatForTest();
};

console.log('fastchat-abuse-guards — the federated fast path under abuse\n');

// ── rv1-1. /v1/broadcast fans out only what a peer would accept ────────
{
	console.log('rv1-1 /v1/broadcast fan-out');
	resetAll();
	const PEERS = 40;
	const alice = key('alice');
	const rows = Array.from({ length: PEERS }, (_, i) => ({
		origin: `https://peer${i}.example`,
		reg_alt_networks: null,
		last_probe_status: 'good',
		last_probed_at: new Date(),
		registered_at_time: new Date(),
		last_probe_error: null
	}));
	const db: fed.FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string, params?: readonly unknown[]) {
			if (text.includes('posting_pubkey')) {
				return res<R>(
					params?.[0] === 'alice'
						? [{ posting_pubkey: pub(alice), posting_key_reconciled: true }]
						: []
				);
			}
			return res<R>(rows);
		}
	};
	const posts: { at: number; body: string }[] = [];
	const dispatcher = new ChatFastDispatcher({
		db,
		selfOrigin: 'https://self.example',
		// Tor configured: chat fan-out runs only over Tor. Never dialled
		// here — `postIsolated` is the stand-in.
		proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' } as never,
		postIsolated: async (_url, body) => {
			posts.push({ at: Date.now(), body: JSON.stringify(body) });
			await sleep(2);
			return { status: 202, body: '' };
		}
	});
	let chainAnswersAt = 0;
	let chainMode: 'reject' | 'accept' = 'reject';
	const blurt = {
		callCondenser: async () => {
			await sleep(150);
			chainAnswersAt = Date.now();
			if (chainMode === 'reject') throw new Error('missing required posting authority');
			return { id: 'f'.repeat(40) };
		}
	};
	const app = broadcastRoute(blurt as never, dispatcher, () => undefined);
	const send = async (trx: unknown, mode: 'reject' | 'accept'): Promise<number> => {
		posts.length = 0;
		chainMode = mode;
		const r = await post(app, { trx, chat_async: true });
		await sleep(100);
		await dispatcher.drain(5_000);
		return r.status;
	};

	const junkBig = {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: new Date(Date.now() + 30_000).toISOString().slice(0, 19),
		operations: [
			[
				'custom_json',
				{
					id: 'morphit_chat_v1',
					required_auths: [],
					required_posting_auths: ['alice'],
					json: JSON.stringify({
						recipient: 'bob',
						ciphertext: 'aGk=',
						header: { client_tag: 'x' },
						pad: 'x'.repeat(120_000)
					})
				}
			]
		],
		extensions: [],
		signatures: ['1f' + '00'.repeat(64)]
	};
	let status = await send(junkBig, 'reject');
	check(
		status === 400 && posts.length === 0,
		'a 120 KB junk chat transaction the chain refuses reaches no peer',
		`HTTP ${status}, ${posts.length} peer POSTs`
	);

	const forged = tx({ sender: 'alice', signWith: key('not-alice') });
	status = await send(forged, 'reject');
	check(
		posts.length === 0,
		'a chat op with a signature that does not verify, refused by the chain, reaches no peer',
		`HTTP ${status}, ${posts.length} peer POSTs`
	);

	const mixed = tx({
		sender: 'alice',
		signWith: alice,
		extraOp: ['transfer', { from: 'alice', to: 'mallory', amount: '1.000 BLURT', memo: '' }]
	});
	status = await send(mixed, 'accept');
	check(
		posts.length === 0,
		'a chat op riding with a non-chat op is never fanned out, even when the chain accepts it',
		`HTTP ${status}, ${posts.length} peer POSTs`
	);

	const padded = tx({ sender: 'alice', signWith: alice, bodyExtra: { pad: 'P'.repeat(5_000) } });
	status = await send(padded, 'accept');
	check(
		posts.length === PEERS && posts.every((p) => !p.body.includes('PPPPPPPP')),
		'a valid chat message goes to every peer as the REBUILT copy, without fields the client attached',
		`${posts.length} POSTs; carries the padding: ${posts.some((p) => p.body.includes('PPPPPPPP'))}`
	);
	check(
		posts.length > 0 && (posts[0]?.at ?? Infinity) < chainAnswersAt,
		'and it still goes out BEFORE the chain answers (the fan-out is not queued behind the node)',
		`first POST at ${posts[0]?.at}, chain answered at ${chainAnswersAt}`
	);

	const stranger = tx({ sender: 'dave', signWith: key('dave') });
	status = await send(stranger, 'reject');
	check(
		posts.length === 0,
		'a message this instance cannot verify locally is held back — and dropped when the chain refuses it',
		`${posts.length} peer POSTs`
	);
	status = await send(tx({ sender: 'dave', signWith: key('dave') }), 'accept');
	check(
		posts.length === PEERS,
		'...and goes out once the chain accepts it (the node proves the signature)',
		`HTTP ${status}, ${posts.length} peer POSTs`
	);
	dispatcher.stop();
}

// ── rv1-2. The order tag is validated before any notify shortcut ───────
{
	console.log('\nrv1-2 notify gate: order tag before the recent-outbound shortcut');
	resetAll();
	const db: fed.FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string) {
			if (text.includes('FROM orders')) return res<R>([]); // no such order
			return res<R>([{ exists: false }]);
		}
	};
	// bob (the recipient) just wrote to mallory through this instance.
	noteOutboundChat('bob', 'mallory');
	const located = (perm: string | null): LocatedChatOp => ({
		signer: 'mallory',
		recipient: 'bob',
		ciphertext: 'aGk=',
		header: {},
		clientTag: `c-${Math.random()}`,
		orderPermlink: perm
	});
	const intakeGate = gatesFromDb(db, { meterFirstContact: true });
	const tailer = new HeadTailer({} as never, db as never, {} as never);
	const tailerGate = (l: LocatedChatOp): Promise<boolean> =>
		(
			tailer as unknown as { fastNotifyAllowed(l: LocatedChatOp, d: Date): Promise<boolean> }
		).fastNotifyAllowed(l, new Date());
	const badTag = 'NOT-AN-ORDER?x=1&next=/en/settings#';
	check(
		!(await intakeGate.fastNotifyAllowed(located(badTag), new Date())),
		'intake: a malformed order tag never notifies, even from a counterparty just replied to'
	);
	check(
		!(await tailerGate(located(badTag))),
		'tailer: the same message is refused by the head tailer too'
	);
	check(
		!(await intakeGate.fastNotifyAllowed(located('someone-elses-order'), new Date())) &&
			!(await tailerGate(located('someone-elses-order'))),
		'a well-formed tag naming no order of either party never notifies on either path'
	);
	check(
		(await intakeGate.fastNotifyAllowed(located(null), new Date())) &&
			(await tailerGate(located(null))),
		'and the shortcut still works for an untagged reply (the feature is intact)'
	);
}

// ── rv1-3. Junk signatures cannot starve unconfirmed senders ───────────
{
	console.log('\nrv1-3 key-refresh budgets');
	const attacker = key('attacker');
	const victim = key('victim');
	const real = new Map<string, string>();
	for (let i = 0; i < 40; i++) real.set(`acct${i}`, pub(key(`acct${i}`)));
	for (let i = 0; i < 40; i++) real.set(`unc${i}`, pub(key(`unc${i}`)));
	real.set('victim', pub(victim));
	const db: fed.FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string, params?: readonly unknown[]) {
			if (text.includes('posting_pubkey')) {
				const a = String(params?.[0]);
				const k = real.get(a);
				// `victim` and every `unc*` row are UNCONFIRMED (the state every row
				// is in right after the upgrade); `acct*` rows are confirmed.
				return res<R>(
					k === undefined
						? []
						: [{ posting_pubkey: k, posting_key_reconciled: a.startsWith('acct') }]
				);
			}
			return res<R>([{ exists: false }]);
		}
	};
	const run = async (junkPrefix: string): Promise<{ delivered: boolean; reads: number }> => {
		resetAll();
		let reads = 0;
		const intake = federationChatFastRoute(db, async (a) => {
			reads++;
			return real.get(a) ?? null;
		});
		for (let i = 0; i < 30; i++) {
			await post(intake.app, { trx: tx({ sender: `${junkPrefix}${i}`, signWith: attacker }) });
		}
		await sleep(400);
		let delivered = false;
		const off = chatEventBus.onFast((ev) => {
			if (ev.sender === 'victim') delivered = true;
		});
		await post(intake.app, { trx: tx({ sender: 'victim', signWith: victim }) });
		await until(() => delivered, 2_000);
		off();
		return { delivered, reads };
	};
	const a = await run('acct');
	check(
		a.delivered,
		'30 junk signatures naming confirmed accounts do not stop an unconfirmed sender getting fast delivery',
		`chain reads spent: ${a.reads}; delivered: ${a.delivered}`
	);
	const b = await run('unc');
	check(
		b.delivered,
		'nor do 30 junk signatures naming UNCONFIRMED accounts (a mismatch there is still a mismatch)',
		`chain reads spent: ${b.reads}; delivered: ${b.delivered}`
	);
}

// ── rv1-4 (b). One account cannot fill the replay memory for everyone ──
{
	console.log('\nrv1-4 replay memory: per-signer share');
	resetAll();
	fed._setSeenMaxForTest(8);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(fed as any)._setSeenPerSignerMaxForTest?.(2);
	const mallory = key('mallory');
	const alice = key('alice');
	const keys: Record<string, string> = { mallory: pub(mallory), alice: pub(alice) };
	const lookup: fed.PostingKeyLookup = async (a) => keys[a] ?? null;
	const t0 = Date.now();
	let floodAccepted = 0;
	for (let i = 0; i < 8; i++) {
		const v = await fed.verifyPushedChatOp(
			{ trx: tx({ sender: 'mallory', recipient: 'mallory2', signWith: mallory }) },
			lookup,
			new Date(t0)
		);
		if (v.ok) floodAccepted++;
	}
	const legit = await fed.verifyPushedChatOp(
		{ trx: tx({ sender: 'alice', signWith: alice }) },
		lookup,
		new Date(t0 + 1_000)
	);
	check(
		floodAccepted < 8,
		"one account's own valid pushes stop at its share of the replay memory",
		`${floodAccepted} of 8 accepted`
	);
	check(
		legit.ok,
		'and everyone else is still served while that account floods',
		legit.ok ? undefined : `alice got ${legit.code}`
	);
	fed._resetSeenForTest();
}

// ── rv1-4 (a). A junk flood in one claimed name does not shed others ───
{
	console.log('\nrv1-4 intake queue: fairness under a junk flood');
	resetAll();
	const alice = key('alice');
	const bob = key('bob-sender');
	const junkKey = key('nobody');
	const keys: Record<string, string> = { alice: pub(alice), carol: pub(bob) };
	const db: fed.FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string, params?: readonly unknown[]) {
			if (text.includes('posting_pubkey')) {
				const k = keys[String(params?.[0])];
				return res<R>(k === undefined ? [] : [{ posting_pubkey: k, posting_key_reconciled: true }]);
			}
			return res<R>([{ exists: false }]);
		}
	};
	const intake = federationChatFastRoute(db);
	let legitSeen = 0;
	const off = chatEventBus.onFast((e) => {
		if ((e.clientTag ?? '').startsWith('LEGIT-')) legitSeen++;
	});
	// Pre-signed junk: signed by a key nobody owns, CLAIMING to be alice. No key
	// and no account needed.
	const junk = Array.from({ length: 64 }, () => tx({ sender: 'alice', signWith: junkKey }));
	const t0 = Date.now();
	let legitSent = 0;
	while (Date.now() - t0 < 3_000) {
		for (let r = 0; r < 4; r++) await post(intake.app, { trxs: junk });
		await post(intake.app, {
			trx: tx({ sender: 'carol', signWith: bob, clientTag: `LEGIT-${legitSent}` })
		});
		legitSent++;
		await sleep(200);
	}
	await until(() => legitSeen >= legitSent, 5_000);
	off();
	check(
		legitSeen === legitSent,
		'every real message from another sender is delivered while junk floods in one claimed name',
		`${legitSeen} of ${legitSent} delivered; stats ${JSON.stringify(intake.stats())}`
	);
}

// ── rv1-4 (a, valid). One account's VALID flood does not shed others ───
//
// The same queue, flooded with pushes that DO verify — one account's own,
// minted offline — so no bad signature ever marks the name. Only the fair
// shedding rule stands between this flood and everyone else.
{
	console.log("\nrv1-4 intake queue: fairness under one account's valid flood");
	resetAll();
	const mallory = key('mallory-valid');
	const carol = key('carol-valid');
	const keys: Record<string, string> = { mallory: pub(mallory), carol: pub(carol) };
	const db: fed.FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string, params?: readonly unknown[]) {
			if (text.includes('posting_pubkey')) {
				const k = keys[String(params?.[0])];
				return res<R>(k === undefined ? [] : [{ posting_pubkey: k, posting_key_reconciled: true }]);
			}
			return res<R>([{ exists: false }]);
		}
	};
	const intake = federationChatFastRoute(db);
	let legitSeen = 0;
	const off = chatEventBus.onFast((e) => {
		if ((e.clientTag ?? '').startsWith('LEGIT2-')) legitSeen++;
	});
	const flood = Array.from({ length: 256 }, () =>
		tx({ sender: 'mallory', recipient: 'mallory2', signWith: mallory })
	);
	const t0 = Date.now();
	let legitSent = 0;
	let batch = 0;
	while (Date.now() - t0 < 3_000) {
		for (let r = 0; r < 4; r++) {
			const start = (batch++ % 4) * 64;
			await post(intake.app, { trxs: flood.slice(start, start + 64) });
		}
		await post(intake.app, {
			trx: tx({ sender: 'carol', signWith: carol, clientTag: `LEGIT2-${legitSent}` })
		});
		legitSent++;
		await sleep(200);
	}
	await until(() => legitSeen >= legitSent, 8_000);
	off();
	check(
		legitSeen === legitSent,
		'every real message from another sender is delivered while one account floods valid pushes',
		`${legitSeen} of ${legitSent} delivered; stats ${JSON.stringify(intake.stats())}`
	);
}

// ── rv1-5. A refresh in flight does not refuse the messages behind it ──
{
	console.log('\nrv1-5 messages during an in-flight key refresh');
	resetAll();
	const v = key('slow-victim');
	const db: fed.FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string) {
			if (text.includes('posting_pubkey'))
				return res<R>([{ posting_pubkey: pub(v), posting_key_reconciled: false }]);
			return res<R>([{ exists: false }]);
		}
	};
	let reads = 0;
	const intake = federationChatFastRoute(db, async () => {
		reads++;
		await sleep(800); // a hidden-only node's chain read
		return pub(v);
	});
	const got: string[] = [];
	const off = chatEventBus.onFast((e) => got.push(String(e.clientTag)));
	for (let i = 1; i <= 3; i++) {
		await post(intake.app, { trx: tx({ sender: 'slowvictim', signWith: v, clientTag: `m${i}` }) });
		await sleep(200);
	}
	await until(() => got.length >= 3, 3_000);
	off();
	check(
		['m1', 'm2', 'm3'].every((t) => got.includes(t)),
		'a burst from an unconfirmed sender is delivered whole, not just its first message',
		`delivered ${JSON.stringify(got)}, chain reads ${reads}`
	);
	check(reads === 1, 'and the burst shares ONE chain read', `chain reads ${reads}`);
}

// ── rv1-6. Order liveness is judged at arrival, not at sentAt ──────────
{
	console.log('\nrv1-6 notify gate clock');
	resetAll();
	const carol = key('carol');
	const now = Date.now();
	const orderExpiresAt = now - 2 * 60_000; // expired two minutes ago
	const db: fed.FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string, params?: readonly unknown[]) {
			if (text.includes('posting_pubkey'))
				return res<R>([{ posting_pubkey: pub(carol), posting_key_reconciled: true }]);
			if (text.includes('FROM orders')) {
				// The real query's liveness clause, evaluated against the time the
				// gate hands it ($3).
				const at = params?.[2] as Date;
				return res<R>([{ account: 'dave', live: orderExpiresAt > at.getTime() }]);
			}
			return res<R>([{ exists: false }]);
		}
	};
	const intake = federationChatFastRoute(db);
	let replayable: boolean | null = null;
	const off = chatEventBus.onFast((e) => {
		if (e.clientTag === 'BACKDATED') replayable = e.replayable ?? null;
	});
	// Expiry four minutes in the past — inside MAX_AGE_MS, so accepted — which
	// makes sentAt five minutes in the past, before the order expired.
	await post(intake.app, {
		trx: tx({
			sender: 'carol',
			recipient: 'dave',
			signWith: carol,
			perm: 'dave-sell-btc',
			clientTag: 'BACKDATED',
			expMs: -4 * 60_000
		})
	});
	await until(() => replayable !== null, 2_000);
	off();
	check(
		replayable === false,
		'a backdated expiry cannot make an expired order count as live for a first-contact notification',
		`replayable=${String(replayable)}`
	);
}

// ── rv2-7. An unknown chain head is not "current" ──────────────────────
{
	console.log('\nrv2-7 durable record currency');
	const f = fed.durableIsCurrentFor;
	if (typeof f !== 'function') {
		bad('durableIsCurrentFor is not exported — nothing decides currency from the status');
	} else {
		const now = Date.now();
		check(
			!f({ running: true, chainHeadBlock: 0, indexedBlock: 5_000 }, now),
			'RPC down at boot (head never read) does not count as current'
		);
		check(
			!f(
				{
					running: true,
					chainHeadBlock: 9_000,
					indexedBlock: 8_990,
					chainHeadSeenAt: new Date(now - 30 * 60_000),
					indexedBlockTime: new Date(now - 30 * 60_000)
				},
				now
			),
			'a head last read half an hour ago does not count as current'
		);
		check(
			f(
				{
					running: true,
					chainHeadBlock: 9_000,
					indexedBlock: 8_985,
					chainHeadSeenAt: new Date(now - 2_000),
					indexedBlockTime: new Date(now - 50_000)
				},
				now
			),
			'a poller trailing a freshly read head by the irreversibility lag is current'
		);
		check(
			!f(
				{
					running: true,
					chainHeadBlock: 9_000,
					indexedBlock: 8_000,
					chainHeadSeenAt: new Date(now - 2_000),
					indexedBlockTime: null
				},
				now
			),
			'a poller 1,000 blocks behind a fresh head is not current'
		);
		check(
			f(
				{
					running: true,
					chainHeadBlock: 0,
					indexedBlock: 8_000,
					chainHeadSeenAt: null,
					indexedBlockTime: new Date(now - 30_000)
				},
				now
			),
			'head unknown but the last committed block is recent: still current'
		);

		// Behaviour: a CONFIRMED row holding a key the owner has since rotated
		// away from, with the RPC unreachable at boot.
		resetAll();
		const leaked = key('leaked');
		const rotated = key('rotated');
		const db: fed.FastFederationDb = {
			async query<R extends pg.QueryResultRow>(text: string) {
				if (text.includes('posting_pubkey'))
					return res<R>([{ posting_pubkey: pub(leaked), posting_key_reconciled: true }]);
				return res<R>([{ exists: false }]);
			}
		};
		let reads = 0;
		const lookup = fed.postingKeyLookupFromDb(
			db,
			async () => {
				reads++;
				return pub(rotated);
			},
			{ durableIsCurrent: () => f({ running: true, chainHeadBlock: 0, indexedBlock: 5_000 }) }
		);
		const v = await fed.verifyPushedChatOp(
			{ trx: tx({ sender: 'owner', signWith: leaked }) },
			lookup
		);
		check(
			!v.ok && reads === 1,
			'with the head unknown, a leaked key on a confirmed row is checked against the chain and refused',
			`verdict ${v.ok ? 'ACCEPTED' : v.code}, chain reads ${reads}`
		);
	}
}

// ── rv2-3. The fast path's key refresh needs a quorum ──────────────────
{
	console.log('\nrv2-3 key refresh through a quorum');
	resetAll();
	const honestKey = key('rv2-honest');
	const attackerKey = key('rv2-attacker');
	const acct = (name: string, k: string): unknown => {
		const auth = { weight_threshold: 1, account_auths: [], key_auths: [[k, 1]] };
		return { name, posting: auth, owner: auth, active: auth, memo_key: k };
	};
	const servers: http.Server[] = [];
	const rpc = async (host: string, keyFor: string, latencyMs: number): Promise<string> => {
		const server = http.createServer((req, resp) => {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				const j = JSON.parse(body) as { id?: unknown; params?: unknown };
				const names = (JSON.stringify(j.params).match(/"[a-z][a-z0-9.-]+"/g) ?? [])
					.map((x) => x.slice(1, -1))
					.filter((n) => n !== 'condenser_api' && n !== 'get_accounts');
				const result = body.includes('get_accounts') ? names.map((n) => acct(n, keyFor)) : null;
				setTimeout(() => {
					resp.writeHead(200, { 'content-type': 'application/json' });
					resp.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 0, result }));
				}, latencyMs);
			});
		});
		await new Promise<void>((r) => server.listen(0, host, () => r()));
		servers.push(server);
		return `http://${host}:${(server.address() as { port: number }).port}`;
	};
	// One hostile endpoint, FIRST and fastest; two honest ones behind it.
	const hostile = await rpc('127.0.0.1', pub(attackerKey), 1);
	const honestA = await rpc('127.0.0.2', pub(honestKey), 40);
	const honestB = await rpc('127.0.0.3', pub(honestKey), 40);
	// A FRESH client per check, so each starts from the pool state the attack
	// relies on (no learned latencies): the hostile endpoint first and fastest.
	const freshRefresher = (): fed.PostingKeyRefresher =>
		fed.chainPostingKeyRefresher(
			new BlurtClient({
				localRpcEndpoints: [hostile, honestA, honestB],
				blurtRpcEndpoints: []
			} as never)
		);
	const answer = await freshRefresher()('alice');
	check(
		answer !== pub(attackerKey),
		'one hostile endpoint cannot make the refresh answer its own key',
		`answered ${answer === pub(honestKey) ? 'the honest key' : answer === null ? 'null (no quorum)' : 'THE ATTACKER KEY'}`
	);
	fed._resetKeyRefreshForTest();
	const db: fed.FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string) {
			if (text.includes('posting_pubkey'))
				return res<R>([{ posting_pubkey: pub(honestKey), posting_key_reconciled: false }]);
			return res<R>([{ exists: false }]);
		}
	};
	const lookup = fed.postingKeyLookupFromDb(db, freshRefresher());
	const v = await fed.verifyPushedChatOp(
		{ trx: tx({ sender: 'alice', signWith: attackerKey }) },
		lookup
	);
	check(
		!v.ok,
		"so a message signed with the hostile endpoint's key is not accepted as alice's",
		v.ok ? 'ACCEPTED' : v.code
	);
	for (const s of servers) {
		s.closeAllConnections?.();
		s.close();
	}
}

console.log(`\n${'─'.repeat(56)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} fastchat-abuse-guards scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} fastchat-abuse-guards scenarios FAILED`);
	process.exit(1);
}
