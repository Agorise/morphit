#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/fastchat-three-leg-smoke.ts
 *
 * THE WHOLE JOURNEY, END TO END: user A's browser to user B's eyes.
 *
 * `federation-chat-fast-smoke.ts` measures the middle leg — one instance
 * handing a message to another. That is the leg the fast path rewrote, and on
 * its own it is not the number anyone actually experiences. A message has three
 * legs to travel, and two of them were never measured:
 *
 *   leg 1   A's browser  →  instance A      hidden round trip
 *   leg 2   instance A   →  instance B      hidden round trip  (already measured)
 *   leg 3   instance B   →  B's browser     hidden, one way, down an OPEN stream
 *
 * A VPN does not remove leg 1 or leg 3. Both users described here have fast,
 * unrestricted internet — and their instances still have no clearnet address at
 * all, so their browsers still reach them over Tor or I2P. A good VPN makes
 * those circuits healthier; it cannot skip them.
 *
 * WHAT IS REAL HERE AND WHAT IS MODELLED
 *
 *   REAL: instance A runs the actual `broadcastRoute`. Instance B runs the
 *   actual `federationChatFastRoute`. The transaction is really signed with a
 *   real Blurt keypair, really verified against a recovered public key, and
 *   really emitted on `chatEventBus` — the same bus both SSE routes subscribe
 *   to. Every leg crosses a real TCP socket. Leg 3 is a real Server-Sent-Events
 *   stream, opened before the message is sent and still open when it arrives,
 *   which is what a browser sitting in a chatroom actually has.
 *
 *   MODELLED: the latency of each hop, injected by a delaying TCP tunnel, and
 *   the Blurt node's acknowledgement time. Real Tor and I2P timings belong to
 *   the maintainer's boxes and are measured there by `ops/fastchat-latency-probe.sh`; what
 *   is established here is that the ARCHITECTURE fits the budget with room to
 *   spare, and — measured in the same run, the same way — that the architecture
 *   it replaced does not.
 *
 * Leg 3 is modelled ONE WAY rather than as a round trip, and that is not a
 * convenience: an SSE stream is already established and flowing, so a message
 * pushed down it travels one way only. The stream in this smoke is genuinely
 * opened first and genuinely left open, so that claim is exercised rather than
 * asserted.
 */

import { createServer, type Server } from 'node:http';
import {
	createConnection,
	createServer as createNetServer,
	type Server as NetServer
} from 'node:net';
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';
import type pg from 'pg';

import { chatEventBus } from '../src/indexer/chatEventBus';
import { broadcastRoute } from '../src/api/broadcast';
import { federationChatFastRoute } from '../src/api/federationChatFast';
import { ChatFastDispatcher } from '../src/indexer/chatFastDispatcher';
import type { FastFederationDb } from '../src/indexer/chatFastFederation';
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

// ── modelled conditions ──────────────────────────────────────────────
//
// One hidden round trip on a WARM circuit. 900 ms is a slow-but-ordinary Tor
// hop; picking a pessimistic number means a pass here is not a number that only
// holds on a good day.
const HIDDEN_RTT_MS = 900;
/** How long the Blurt node takes to accept and acknowledge a transaction. This
 *  is NOT block inclusion — the async broadcast answers on acceptance. */
const CHAIN_ACK_MS = 400;
/** The chain's own unavoidable costs, for the comparison at the end. */
const BLOCK_INTERVAL_MS = 3_000;
const HEAD_TAILER_POLL_MS = 2_000;
/** The line the maintainer drew. */
const TARGET_MS = 6_000;

const sleep = (ms: number) =>
	new Promise<void>((r) => {
		setTimeout(r, ms);
	});

// ── a delaying TCP tunnel: a warm hidden circuit ─────────────────────
//
// Forwards bytes to `targetPort`, holding each chunk for `oneWayMs` in each
// direction. That models an ESTABLISHED circuit — already built, just distant —
// which is the condition the dispatcher's background warm-up creates and the
// condition a browser sitting in a chatroom is already in.
function delayingTunnel(
	targetPort: number,
	oneWayMs: number
): Promise<{ port: number; close: () => void }> {
	const sockets = new Set<{ destroy: () => void }>();
	const srv: NetServer = createNetServer((client) => {
		sockets.add(client);
		const upstream = createConnection({ host: '127.0.0.1', port: targetPort });
		sockets.add(upstream);
		const pipeDelayed = (from: NodeJS.ReadableStream, to: NodeJS.WritableStream) => {
			from.on('data', (chunk: Buffer) => {
				setTimeout(() => {
					try {
						to.write(chunk);
					} catch {
						/* peer went away mid-flight; nothing to do */
					}
				}, oneWayMs);
			});
			from.on('end', () => {
				setTimeout(() => {
					try {
						to.end();
					} catch {
						/* already closed */
					}
				}, oneWayMs);
			});
		};
		client.on('error', () => undefined);
		upstream.on('error', () => client.destroy());
		upstream.on('connect', () => {
			pipeDelayed(client, upstream);
			pipeDelayed(upstream, client);
		});
	});
	return new Promise((resolve) => {
		srv.listen(0, '127.0.0.1', () => {
			resolve({
				port: (srv.address() as AddressInfo).port,
				close: () => {
					for (const s of sockets) {
						try {
							s.destroy();
						} catch {
							/* already gone */
						}
					}
					srv.close();
				}
			});
		});
	});
}

// ── a real signed chat transaction ───────────────────────────────────

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const SENDER = 'alice';
const RECIPIENT = 'bob';
const senderKey = PrivateKey.fromSeed('morphit-three-leg-smoke-sender');
const senderPub = senderKey.createPublic().toString();

function buildSignedChatTx(): unknown {
	// The payload apps/web/src/lib/chat/chatService.ts puts on the wire.
	const payload = {
		recipient: RECIPIENT,
		ciphertext: Buffer.from('an encrypted message body').toString('base64'),
		header: {
			client_tag: `tag-${Math.random().toString(36).slice(2, 12)}`,
			ephemeral_pub: Buffer.from('ephemeral-public-key-32-bytes!!!').toString('base64'),
			nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64')
		}
	};
	const tx = {
		ref_block_num: 1234,
		ref_block_prefix: 5678,
		expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
		operations: [
			[
				'custom_json',
				{
					id: 'morphit_chat_v1',
					required_auths: [],
					required_posting_auths: [SENDER],
					json: JSON.stringify(payload)
				}
			]
		],
		extensions: []
	};
	return cryptoUtils.signTransaction(
		tx as unknown as Parameters<typeof cryptoUtils.signTransaction>[0],
		[senderKey]
	);
}

// ── instance B's database, answering the real route's real queries ───
//
// Matched on the SQL the gates actually issue, so the route under test runs its
// own queries rather than a rewritten stand-in of them.
function instanceBDb(): FastFederationDb {
	return {
		async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
			const rows: unknown[] = [];
			if (text.includes('posting_pubkey')) {
				rows.push({ posting_pubkey: senderPub });
			} else if (text.includes('FROM blocks')) {
				rows.push({ exists: false }); // nobody has blocked anybody
			} else if (text.includes('FROM chat_messages')) {
				rows.push({ exists: true }); // an established conversation
			} else if (text.includes('push_subscriptions')) {
				// No push subscription — B is looking at the screen, which is the
				// case this smoke is about. Push delivery is covered elsewhere.
			}
			return {
				rows: rows as R[],
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	};
}

const DBG = process.env.THREE_LEG_DEBUG === '1';
const trace = (m: string) => {
	if (DBG) console.log(`      [trace] ${m} @${Date.now() % 100000}`);
};
console.log('fastchat-three-leg — A’s browser to B’s eyes, all three legs');
console.log('');
console.log(
	`  modelled: ${HIDDEN_RTT_MS}ms per hidden round trip, ${CHAIN_ACK_MS}ms for the Blurt node to ack`
);
console.log('');

// ── Build the two instances ──────────────────────────────────────────

// INSTANCE B — the recipient's. Real federation route + a real SSE stream.
const bDb = instanceBDb();
const bFederation = federationChatFastRoute(bDb).app;

/** B's browser, as a real SSE client: connected BEFORE the message is sent and
 *  still connected when it arrives. */
let sseClients = 0;
const instanceB: Server = createServer((req, res) => {
	if ((req.url ?? '').startsWith('/stream')) {
		sseClients++;
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		});
		// Flush the headers immediately. Without a first write, node holds them
		// in the socket buffer and the client cannot tell the stream is open —
		// which is indistinguishable, from the outside, from a hung server.
		res.write(': open\n\n');
		// Exactly what apps/indexer/src/api/chatStream.ts and
		// chatActivityStream.ts subscribe to. The routes themselves need a full
		// database for their opening snapshot and are covered by their own
		// smokes; what matters here is that the event reaches an OPEN stream.
		const off = chatEventBus.onFast((ev) => {
			res.write(`data: ${JSON.stringify({ sender: ev.sender, recipient: ev.recipient })}\n\n`);
		});
		req.on('close', () => off());
		return;
	}
	// The real federation endpoint.
	const chunks: Buffer[] = [];
	req.on('data', (c: Buffer) => chunks.push(c));
	req.on('end', () => {
		void (async () => {
			const r = await bFederation.request('/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: Buffer.concat(chunks).toString('utf8')
			});
			res.writeHead(r.status, { 'content-type': 'application/json' });
			res.end(await r.text());
		})();
	});
});
await new Promise<void>((r) => instanceB.listen(0, '127.0.0.1', r));
const instanceBPort = (instanceB.address() as AddressInfo).port;

// leg 2's tunnel: instance A reaches instance B over a warm hidden circuit.
const legTwo = await delayingTunnel(instanceBPort, HIDDEN_RTT_MS / 2);
// leg 3's tunnel: B's browser reaches instance B's stream the same way.
const legThree = await delayingTunnel(instanceBPort, HIDDEN_RTT_MS / 2);

// INSTANCE A — the sender's. The real broadcast route, wired to a real
// dispatcher pointed at instance B, and a Blurt node that acknowledges without
// waiting for a block (which is what the async broadcast asks of it).
let broadcastMethod = '';
/** Extra latency the Blurt node adds, so a scenario can make it pathological. */
let chainStallMs = 0;
const blurtStub = {
	callCondenser: async (method: string) => {
		broadcastMethod = method;
		if (chainStallMs > 0) await sleep(chainStallMs);
		// The node acknowledges acceptance after CHAIN_ACK_MS either way. The
		// SYNCHRONOUS method then holds the connection open until a witness seals
		// the transaction into a block — one further block interval — which is
		// precisely the wait the chat path stopped paying. Modelling that here is
		// what makes the comparison below a measurement rather than an opinion.
		await sleep(CHAIN_ACK_MS);
		if (method === 'broadcast_transaction_synchronous') await sleep(BLOCK_INTERVAL_MS);
		return { id: 'f'.repeat(40), block_num: 42, trx_num: 0 };
	}
} as unknown as BlurtClient;

const dispatcher = new ChatFastDispatcher({
	db: {
		// The peer directory: instance B, reached through leg 2's tunnel.
		async query<R extends pg.QueryResultRow>(): Promise<pg.QueryResult<R>> {
			return {
				rows: [
					// A probe-verified peer (only those receive pushes); the
					// name stands for leg 2's tunnel, which `postIsolated` dials.
					{
						origin: 'https://instance-b.example',
						reg_alt_networks: null,
						last_probe_status: 'good',
						last_probed_at: null,
						registered_at_time: null
					}
				] as unknown as R[],
				rowCount: 1,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	},
	selfOrigin: 'http://instance-a.invalid',
	// Tor configured (fan-out runs only over Tor); `postIsolated` stands in.
	proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' },
	// Instance A knows its own user's posting key, as a real instance does from
	// chain sync. Since an earlier release the sender side verifies a
	// message against it before fanning out, and holds back what it cannot
	// verify until the node accepts it — which, with the node stalled below,
	// would be never.
	lookupPostingKey: async (account) => (account === SENDER ? senderPub : null),
	postIsolated: async (url, body, _proxies, timeoutMs) => {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url.replace('https://instance-b.example', `http://127.0.0.1:${legTwo.port}`), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: ctrl.signal
			});
			return { status: res.status, body: await res.text() };
		} finally {
			clearTimeout(t);
		}
	}
});

const aRoute = broadcastRoute(blurtStub, dispatcher);
const instanceA: Server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on('data', (c: Buffer) => chunks.push(c));
	req.on('end', () => {
		void (async () => {
			const r = await aRoute.request('/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: Buffer.concat(chunks).toString('utf8')
			});
			res.writeHead(r.status, { 'content-type': 'application/json' });
			res.end(await r.text());
		})();
	});
});
await new Promise<void>((r) => instanceA.listen(0, '127.0.0.1', r));
const instanceAPort = (instanceA.address() as AddressInfo).port;
// leg 1's tunnel: A's browser reaches instance A over a warm hidden circuit.
const legOne = await delayingTunnel(instanceAPort, HIDDEN_RTT_MS / 2);

// ── B's browser opens its stream and leaves it open ──────────────────

interface StreamWatch {
	firstByteAt: Promise<number>;
	close: () => void;
}
function openStream(port: number): Promise<StreamWatch> {
	return new Promise((resolve) => {
		const sock = createConnection({ host: '127.0.0.1', port }, () => {
			sock.write('GET /stream HTTP/1.1\r\nHost: b\r\nAccept: text/event-stream\r\n\r\n');
		});
		let sawHeaders = false;
		let resolveFirst: (t: number) => void = () => undefined;
		const firstByteAt = new Promise<number>((r) => {
			resolveFirst = r;
		});
		sock.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			if (!sawHeaders) {
				sawHeaders = true;
				// The stream is live. Anything after this is a pushed event.
				resolve({ firstByteAt, close: () => sock.destroy() });
				if (!text.includes('data:')) return;
			}
			if (text.includes('data:')) resolveFirst(Date.now());
		});
		sock.on('error', () => undefined);
	});
}

trace('opening stream');
const watch = await openStream(legThree.port);
trace('stream open');
// Give the subscription a moment to settle so the stream is unambiguously open
// BEFORE the clock starts. Otherwise a fast delivery could race the subscribe
// and the measurement would be of the wrong thing.
await sleep(200);

if (sseClients === 1) ok('B’s browser is connected and its stream is open before anything is sent');
else bad(`expected 1 open stream, saw ${sseClients}`);

// ── THE MEASUREMENT ──────────────────────────────────────────────────

const started = Date.now();

// leg 1 — A's browser POSTs the signed message to its own instance, through the
// tunnel. This is a real request to the real broadcast route.
trace('sending');
const sendRes = await fetch(`http://127.0.0.1:${legOne.port}/`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	// `chat_async: true` is what the real client sends (see
	// apps/web/src/lib/blurt/broadcastTransport.ts). The fast answer is OPT-IN
	// because a cached browser tab can be older than the indexer serving it, and
	// an old bundle reads `block_num: null` as a malformed reply — it would show
	// a permanent failure for a message that was in fact delivered. The
	// backwards-compatible case is asserted on its own further down.
	body: JSON.stringify({ trx: buildSignedChatTx(), chat_async: true })
});
trace('send returned');
const sendBody = (await sendRes.json()) as { block_num?: unknown; trx_id?: unknown };
const sentAt = Date.now();

// leg 3 — the event arrives down the already-open stream.
trace('waiting for arrival');
const arrivedAt = await Promise.race([watch.firstByteAt, sleep(TARGET_MS + 6_000).then(() => -1)]);

const senderMs = sentAt - started;
const deliveredMs = arrivedAt > 0 ? arrivedAt - started : -1;

if (sendRes.status === 200) ok(`instance A accepted the send (${sendRes.status})`);
else bad(`the send failed with status ${sendRes.status}`, JSON.stringify(sendBody).slice(0, 200));

if (broadcastMethod === 'broadcast_transaction')
	ok('the chat message went to the chain ASYNCHRONOUSLY — the sender never waited for a block');
else
	bad(
		`the chat message was broadcast with '${broadcastMethod}'`,
		'a chat send that waits for block inclusion pays up to a full 3,000ms block interval'
	);

if (sendBody.block_num === null)
	ok('and the reply carries block_num null, as an un-blocked send must');
else bad(`expected block_num null, got ${JSON.stringify(sendBody.block_num)}`);

// ── The two numbers that matter ──────────────────────────────────────

if (senderMs < TARGET_MS)
	ok(`SENDING: A was told the message went in ${senderMs}ms, under the ${TARGET_MS}ms target`);
else
	bad(
		`SENDING: A waited ${senderMs}ms to be told the message went, over the ${TARGET_MS}ms target`,
		`leg 1 round trip ${HIDDEN_RTT_MS}ms + chain ack ${CHAIN_ACK_MS}ms`
	);

if (deliveredMs < 0) bad(`RECEIVING: the message never reached B's browser at all`);
else if (deliveredMs < TARGET_MS)
	ok(
		`RECEIVING: it was on B’s screen in ${deliveredMs}ms, under the ${TARGET_MS}ms target ` +
			`(3 hidden legs at ${HIDDEN_RTT_MS}ms each)`
	);
else
	bad(
		`RECEIVING: B saw it after ${deliveredMs}ms, over the ${TARGET_MS}ms target`,
		`leg1 + leg2 + leg3 at ${HIDDEN_RTT_MS}ms per round trip`
	);

// ── Delivery must not be standing behind the chain ───────────────────
//
// The fan-out to peers is fired BEFORE the chain call and deliberately not
// awaited. That ordering is easy to lose in a later edit — moving one line below
// another looks harmless — and with a healthy node the mistake is nearly
// invisible, because the chain answers in a few hundred milliseconds.
//
// It stops being invisible the moment a node is sick. An unreachable or
// wedged Blurt node can hold a broadcast for tens of seconds, and if delivery
// were queued behind it, every conversation on the instance would stop dead
// while the chain sulked. So: stall the node far past the target and require
// the message to arrive anyway.
{
	const STALL_MS = 20_000;
	chainStallMs = STALL_MS;

	const arrival = new Promise<number>((resolve) => {
		const off = chatEventBus.onFast(() => {
			off();
			resolve(Date.now());
		});
	});

	const t0 = Date.now();
	// Not awaited: with the node stalled, this request will not come back for
	// twenty seconds, which is the whole point.
	void fetch(`http://127.0.0.1:${legOne.port}/`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ trx: buildSignedChatTx(), chat_async: true })
	}).catch(() => undefined);

	const landed = await Promise.race([arrival, sleep(TARGET_MS + 2_000).then(() => -1)]);
	const stalledMs = landed > 0 ? landed - t0 : -1;
	chainStallMs = 0;

	if (stalledMs > 0 && stalledMs < TARGET_MS)
		ok(
			`with the Blurt node stalled for ${STALL_MS}ms, the message STILL reached the ` +
				`recipient in ${stalledMs}ms — delivery does not queue behind the chain`
		);
	else
		bad(
			stalledMs < 0
				? `with the Blurt node stalled, the message never reached the recipient at all`
				: `delivery took ${stalledMs}ms while the node was stalled — it is waiting on the chain`,
			'the fan-out must be fired BEFORE the chain call and must not be awaited'
		);
}

// ── The sender's leg on a punishing hop ──────────────────────────────
//
// At the 900 ms hop above, a send that waits for a block would ALSO have come
// in under six seconds, and saying otherwise would be dishonest. What the async
// broadcast buys is margin, and margin only shows up where the budget is tight
// — so this runs the sender's leg again over a hop bad enough to matter, which
// a congested Tor circuit or a long I2P tunnel reaches without difficulty.
//
// Both numbers are measured, through the same real route, with the method
// chosen by the route's own logic: a chat message takes the asynchronous path,
// and a transfer — which genuinely needs its block number — takes the
// synchronous one. The transfer is standing in for what a chat send used to do,
// not for a transfer's own requirements.
{
	// Where is the boundary? A block-waiting send costs hop + ack + block, so it
	// exceeds the target once
	//
	//     hop > TARGET_MS - CHAIN_ACK_MS - BLOCK_INTERVAL_MS
	//
	// which with these constants is about 2.6 seconds. Below that, a send that
	// waits for a block ALSO fits in six seconds and the asynchronous broadcast
	// is buying only margin — worth saying plainly rather than implying the old
	// behaviour was broken everywhere.
	//
	// The hop measured here is 3 seconds, chosen because it is a latency the maintainer has
	// observed on real nodes, not because it is the number that makes this pass.
	// The crossover above is printed so the boundary is visible either way.
	const crossoverMs = TARGET_MS - CHAIN_ACK_MS - BLOCK_INTERVAL_MS;
	const STRESS_HOP_MS = 3_000;
	console.log(
		`      (a block-waiting send exceeds ${TARGET_MS}ms once a hop passes ~${crossoverMs}ms;` +
			` measuring at ${STRESS_HOP_MS}ms)`
	);
	const stress = await delayingTunnel(instanceAPort, STRESS_HOP_MS / 2);

	const timeSend = async (body: unknown): Promise<number> => {
		const t0 = Date.now();
		await fetch(`http://127.0.0.1:${stress.port}/`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		return Date.now() - t0;
	};

	const asyncMs = await timeSend({ trx: buildSignedChatTx(), chat_async: true });
	const syncMs = await timeSend({
		trx: {
			ref_block_num: 1,
			ref_block_prefix: 1,
			expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
			operations: [['transfer', { from: SENDER, to: RECIPIENT, amount: '1.000 BLURT', memo: '' }]],
			extensions: [],
			signatures: ['deadbeef']
		}
	});

	if (asyncMs < TARGET_MS)
		ok(
			`on a ${STRESS_HOP_MS}ms hop the chat send still answered in ${asyncMs}ms, ` +
				`inside the ${TARGET_MS}ms target`
		);
	else
		bad(
			`on a ${STRESS_HOP_MS}ms hop the chat send took ${asyncMs}ms, over the target`,
			'the asynchronous broadcast is not buying what it was supposed to buy'
		);

	if (syncMs > TARGET_MS)
		ok(
			`and a send that WAITS FOR A BLOCK took ${syncMs}ms on the same hop — over the ` +
				`${TARGET_MS}ms target. That is the wait the chat path stopped paying`
		);
	else
		bad(
			`a block-waiting send took only ${syncMs}ms on a ${STRESS_HOP_MS}ms hop, inside the ` +
				`${TARGET_MS}ms target. The crossover arithmetic says it should have exceeded it ` +
				`above ~${crossoverMs}ms, so either the block wait is not being paid or these ` +
				'constants no longer match the chain',
			`chat send on the same hop: ${asyncMs}ms`
		);

	stress.close();
}

// ── The two things that must NOT take the fast answer ────────────────
//
// The asynchronous broadcast is the one place in this service where a signed
// write is acknowledged before it is in a block, and both guards on it were
// untested. Each is one word or one flag away from being wrong, and neither
// failure is visible: the send succeeds, the caller is simply told something
// that is not true yet.
{
	const askA = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
		const r = await fetch(`http://127.0.0.1:${legOne.port}/`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		let json: Record<string, unknown> = {};
		try {
			json = (await r.json()) as Record<string, unknown>;
		} catch {
			/* asserted below */
		}
		return { status: r.status, json };
	};

	// 1. A MIXED transaction — a chat op riding alongside a transfer.
	//
	// `isChatMessageOnly` uses `.every`, not `.some`, and that single word is
	// load-bearing: the transfer half of this transaction is money, its caller
	// reads `block_num`, and answering it before the transaction is in a block
	// hands out a receipt for something that has not happened. `.some` passes
	// every other scenario in this file, because every other one sends chat
	// alone or a transfer alone.
	broadcastMethod = '';
	const mixed = await askA({
		trx: {
			ref_block_num: 1,
			ref_block_prefix: 1,
			expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
			operations: [
				(buildSignedChatTx() as { operations: unknown[] }).operations[0],
				['transfer', { from: SENDER, to: RECIPIENT, amount: '1.000 BLURT', memo: '' }]
			],
			extensions: [],
			signatures: ['deadbeef']
		},
		// Asking for the fast answer must not get it for a transaction that is
		// not chat-only. The client asking is necessary, never sufficient.
		chat_async: true
	});
	if (broadcastMethod === 'broadcast_transaction_synchronous')
		ok('a chat op riding alongside a TRANSFER still waits for its block');
	else
		bad(
			`a mixed chat+transfer transaction was broadcast with '${broadcastMethod}'`,
			'the transfer half is money and its caller reads block_num — answering before ' +
				'inclusion hands out a receipt for something that has not happened yet'
		);
	if (typeof mixed.json.block_num === 'number')
		ok('and it is answered with a real block number, not null');
	else
		bad(
			`a mixed transaction was answered with block_num ${JSON.stringify(mixed.json.block_num)}`,
			'the money half of this transaction needs its block'
		);

	// 2. A CHAT-ONLY transaction from a client that did NOT ask.
	//
	// This is the cached-browser-tab case. A bundle from before this release
	// calls the generic submit path, which treats a missing block_num as a
	// malformed reply and throws — so the user would be shown a permanent red
	// failure for a message the recipient already has, with a retry button that
	// sends it to them a second time. The indexer must therefore not take the
	// fast path on its own initiative, however chat-like the transaction looks.
	broadcastMethod = '';
	const oldBundle = await askA({ trx: buildSignedChatTx() });
	if (broadcastMethod === 'broadcast_transaction_synchronous')
		ok('a chat send from a client that did not ask still waits for its block');
	else
		bad(
			`an un-flagged chat send was broadcast with '${broadcastMethod}'`,
			'a cached older browser tab would read the resulting null block_num as a failure'
		);
	if (typeof oldBundle.json.block_num === 'number')
		ok('and that older client gets the numeric block_num it is expecting');
	else
		bad(
			`an un-flagged chat send was answered with block_num ${JSON.stringify(oldBundle.json.block_num)}`,
			'this is exactly the reply an older bundle rejects as malformed'
		);
}

// ── The same journey on the architecture this replaced ───────────────
//
// AN ILLUSTRATION, NOT A MEASUREMENT — and labelled as one, because the earlier
// wording ("run, not reasoned about") claimed more than this block does. No
// product code executes here: it is the same modelled hops as above plus the two
// costs the chain imposes that the fast path removed — waiting for a witness to
// seal the message into a block, and waiting for the recipient's instance to
// next poll. The timers make it take real time, which is not the same as
// measuring anything. Its value is that it holds the SAME constants as the
// measured path above, so the comparison is apples to apples; if someone
// retunes a hop, both move together.
{
	const t0 = Date.now();
	await sleep(HIDDEN_RTT_MS); // leg 1
	await sleep(BLOCK_INTERVAL_MS); // wait for a block to seal it
	await new Promise<void>((resolve) => {
		// the recipient's head tailer, polling on its own schedule
		const tick = setInterval(() => {
			clearInterval(tick);
			resolve();
		}, HEAD_TAILER_POLL_MS);
	});
	await sleep(HIDDEN_RTT_MS); // its hidden RPC read of that block
	await sleep(HIDDEN_RTT_MS / 2); // push down B's open stream
	const oldMs = Date.now() - t0;

	if (oldMs > TARGET_MS)
		ok(
			`the old chain-mediated journey, on the same modelled hops, comes to ${oldMs}ms ` +
				`— and that is its BEST case. This is what the measured ${deliveredMs}ms replaced`
		);
	else
		bad(
			`the old chain journey finished in ${oldMs}ms, inside the target — if that is real, ` +
				'this whole mechanism is unnecessary and should be reverted rather than shipped'
		);
}

// ── Teardown ─────────────────────────────────────────────────────────
watch.close();
legOne.close();
legTwo.close();
legThree.close();
dispatcher.stop();
instanceA.closeAllConnections?.();
instanceB.closeAllConnections?.();
await new Promise<void>((r) => instanceA.close(() => r()));
await new Promise<void>((r) => instanceB.close(() => r()));

console.log('');
console.log('────────────────────────────────────────────────────────');
if (fail === 0) {
	console.log(`✓ all ${pass} fastchat-three-leg scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
