#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/federation-chat-fast-smoke.ts
 *
 * Two people on two different zero-clearnet instances must see each other's
 * messages in under six seconds — the FIRST message included.
 *
 * WHY THE OLD PATH COULD NOT
 * Delivery went through the chain, and the chain's own constants forbid it:
 * `broadcast_transaction_synchronous` blocks until the transaction is in a
 * block (Blurt block interval 3,000 ms), and the receiving instance then waits
 * up to another 2,000 ms for its head tailer to poll before it even fetches
 * that block. Five seconds of waiting before one tunnel round trip is counted,
 * and there are three of those to pay for. Faster RPC nodes cannot help: none
 * of that time is RPC latency.
 *
 * WHAT THIS SMOKE DOES
 * It does not reason about the budget — it RUNS it. A real receiving instance
 * is mounted (the actual `federationChatFastRoute`, not a mock of it), a real
 * Blurt keypair signs a real chat transaction, the sender's real dispatcher
 * pushes it over a transport with injected hidden-network latency, and the
 * clock runs from send to the moment the event lands on the receiving side's
 * event bus — the same bus the SSE stream reads.
 *
 * Every scenario states the modelled latency it assumes, so the result is a
 * measurement under stated conditions rather than a number with no meaning.
 * Real Tor/I2P timings are the maintainer's to measure on the boxes; what this proves is
 * that the ARCHITECTURE fits inside the budget, and that the old one does not.
 */

import { createServer, type Server } from 'node:http';
import {
	createConnection,
	createServer as createNetServer,
	type Server as NetServer
} from 'node:net';
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';
import { chatEventBus, type ChatFastEvent } from '../src/indexer/chatEventBus';
import {
	verifyPushedChatOp,
	deliverVerifiedPush,
	structuralCheckChatOp,
	postingKeyLookupFromDb,
	_resetKeyRefreshForTest,
	PeerSender,
	BATCH_MAX,
	BATCH_MAX_BYTES,
	containsChatOp,
	_resetSeenForTest,
	_setSeenMaxForTest,
	replayTableFullCount,
	fanOutPeerFromRow,
	MAX_AGE_MS,
	MAX_FUTURE_MS,
	SEEN_TTL_MS,
	type FastDeliveryGates,
	type PostingKeyLookup,
	type FastPeer
} from '../src/indexer/chatFastFederation';
import { _resetFastEmitLedgerForTest } from '../src/indexer/fastEmitLedger';
import {
	spendFastNotifyBudget,
	fastNotifyBudgetSize,
	_resetFastNotifyBudgetForTest
} from '../src/indexer/fastNotifyBudget';
import {
	closePool,
	postJsonViaHiddenService,
	postJsonViaTorIsolated
} from '../src/indexer/hiddenServicePool';
import {
	ProxyUnavailableError,
	isProxyUnavailable,
	localFaultConfidence
} from '@morphit/hidden-transport';
import {
	federationChatFastRoute,
	gatesFromDb,
	admissionDepthFor,
	VERIFY_QUEUE_MAX,
	QUEUE_WAIT_ALLOWANCE_MS
} from '../src/api/federationChatFast';
import type { FastFederationDb } from '../src/indexer/chatFastFederation';
import type pg from 'pg';
import type { LocatedChatOp } from '../src/indexer/headTailer';

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

// ── modelled network conditions ──────────────────────────────────────
//
// A WARM hidden circuit — one already established by the dispatcher's
// background warm-up, which is the condition the design creates on purpose.
// Deliberately pessimistic: 900 ms each way is a slow-but-ordinary Tor hop.
const WARM_HIDDEN_RTT_MS = 900;
// The chain's own costs, from the constants in this tree.
const BLOCK_INTERVAL_MS = 3_000;
const HEAD_TAILER_POLL_MS = 2_000;
// The target the maintainer set.
const TARGET_MS = 6_000;

// NOT unref'd. Several scenarios model network legs with nothing else pending
// on the loop; an unref'd timer there lets node exit mid-scenario and the await
// never settles, which surfaces as a hang rather than as a result.
/**
 * Survive an escaped rejection, exactly as production does.
 *
 * apps/indexer/src/main.ts installs an `unhandledRejection` handler, so a
 * promise that rejects with nobody watching does NOT stop the indexer — it logs
 * a line, and whatever work was in flight behind it is simply abandoned. That
 * abandonment is the interesting failure, and without this the process would
 * die instead, which a harness reads as "the test crashed" and correctly counts
 * as nothing. Modelling the real process is what lets the assertions speak.
 *
 * Counted, not ignored: an escaped rejection is a defect in its own right, and
 * the run asserts there were none at the end.
 */
let unhandled = 0;
process.on('unhandledRejection', () => {
	unhandled++;
});

const sleep = (ms: number) =>
	new Promise<void>((r) => {
		setTimeout(r, ms);
	});

// ── a real signed chat transaction ───────────────────────────────────

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const SENDER = 'alice';
const RECIPIENT = 'bob';
const senderKey = PrivateKey.fromSeed('morphit-federation-fast-smoke-sender');
const senderPub = senderKey.createPublic().toString();
const strangerKey = PrivateKey.fromSeed('morphit-federation-fast-smoke-stranger');

interface BuildOpts {
	readonly sender?: string;
	readonly recipient?: string;
	readonly clientTag?: string;
	readonly orderPermlink?: string | null;
	readonly signWith?: typeof senderKey;
	readonly expiration?: string;
	readonly extraOp?: boolean;
	readonly opId?: string;
}

function buildSignedChatTx(o: BuildOpts = {}): unknown {
	const sender = o.sender ?? SENDER;
	const recipient = o.recipient ?? RECIPIENT;
	const tag = o.clientTag ?? `tag-${Math.random().toString(36).slice(2, 10)}`;
	// Field-for-field the payload apps/web/src/lib/chat/chatService.ts puts on
	// the wire. A fixture that invents its own shape proves the fast path
	// accepts THE FIXTURE, which is worth nothing — this must be the same bytes
	// a real client sends, so that a parser change breaks this smoke.
	const payload = {
		recipient,
		ciphertext: Buffer.from('an encrypted message body').toString('base64'),
		header: {
			client_tag: tag,
			ephemeral_pub: Buffer.from('ephemeral-public-key-32-bytes!!!').toString('base64'),
			nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64')
		},
		...(o.orderPermlink !== undefined && o.orderPermlink !== null
			? { order_permlink: o.orderPermlink }
			: {})
	};
	const ops: unknown[] = [
		[
			'custom_json',
			{
				id: o.opId ?? 'morphit_chat_v1',
				required_auths: [],
				required_posting_auths: [sender],
				json: JSON.stringify(payload)
			}
		]
	];
	if (o.extraOp === true) {
		ops.push([
			'custom_json',
			{ id: 'morphit_profile_v1', required_auths: [], required_posting_auths: [sender], json: '{}' }
		]);
	}
	const tx = {
		ref_block_num: 1234,
		ref_block_prefix: 5678,
		expiration: o.expiration ?? new Date(Date.now() + 60_000).toISOString().slice(0, 19),
		operations: ops,
		extensions: []
	};
	return cryptoUtils.signTransaction(tx as Parameters<typeof cryptoUtils.signTransaction>[0], [
		o.signWith ?? senderKey
	]);
}

// ── the receiving instance's gates ───────────────────────────────────

interface GateState {
	blocked: boolean;
	blockThrows: boolean;
	replied: boolean;
	pushes: string[];
}
function makeGates(state: GateState): FastDeliveryGates {
	return {
		async recipientBlockedSender(): Promise<boolean> {
			if (state.blockThrows) throw new Error('db down');
			return state.blocked;
		},
		async fastNotifyAllowed(): Promise<boolean> {
			return state.replied;
		},
		async enqueuePush(located: LocatedChatOp, trxId: string): Promise<void> {
			state.pushes.push(`${located.signer}->${located.recipient}:${trxId.slice(0, 8)}`);
		}
	};
}

const lookupKnown: PostingKeyLookup = async (account) => (account === SENDER ? senderPub : null);

/** The receiving instance's database, answering the queries the real gates
 *  issue. Same shape the scenarios below build inline; extracted so the later
 *  ones can stand up a real intake without repeating it. */
function makeDb(): FastFederationDb {
	return {
		async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
			const rows: unknown[] = [];
			if (text.includes('posting_pubkey')) rows.push({ posting_pubkey: senderPub });
			else if (text.includes('FROM blocks')) rows.push({ exists: false });
			else if (text.includes('FROM chat_messages')) rows.push({ exists: true });
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

/** Wait for the next fast event on the bus, or null after `ms`. */
function nextFastEvent(ms: number): Promise<ChatFastEvent | null> {
	return new Promise((resolve) => {
		// NOT unref'd. This is a bounded wait whose EXPIRY is the answer in the
		// negative cases (blocked sender, fail-closed) — if the timer does not
		// hold the loop open, node finds nothing else pending, exits, and the
		// await never settles, which reads as a hang rather than as "no event".
		const timer = setTimeout(() => {
			off();
			resolve(null);
		}, ms);
		const off = chatEventBus.onFast((ev) => {
			clearTimeout(timer);
			off();
			resolve(ev);
		});
	});
}

/** A PeerSender whose isolated-Tor transport is stood in for by plain HTTP to
 *  loopback peers. This is the production class — the smoke deliberately has
 *  no fan-out implementation of its own, so a scenario passing here says
 *  something about what ships. */
function makeSender(timeoutMs = 5_000): PeerSender {
	return new PeerSender({
		proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' },
		timeoutMs,
		postIsolated: async (url, body, _proxies, ms) => {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), ms);
			try {
				const r = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
					signal: ctrl.signal
				});
				return { status: r.status, body: await r.text() };
			} finally {
				clearTimeout(t);
			}
		}
	});
}

/** A PeerSender on the REAL transport: one isolated Tor circuit per push
 *  (postJsonViaTorIsolated), through whatever SOCKS5 proxy `proxies` names. */
function makeHiddenSender(
	proxies: { torSocks: string; i2pHttpProxy: string },
	timeoutMs = 20_000
): PeerSender {
	return new PeerSender({ proxies, timeoutMs });
}

console.log('federation-chat-fast — two zero-clearnet instances, under six seconds');
console.log('');

// ── 1. THE BUDGET: the chain path cannot fit, the fast path does ─────
{
	// Not an opinion — the chain's minimum, from this tree's own constants.
	const chainFloor = BLOCK_INTERVAL_MS + HEAD_TAILER_POLL_MS + 3 * WARM_HIDDEN_RTT_MS;
	if (chainFloor > TARGET_MS)
		ok(
			`chain-mediated delivery cannot meet the target: block ${BLOCK_INTERVAL_MS}ms + poll ` +
				`${HEAD_TAILER_POLL_MS}ms + 3 hidden hops = ${chainFloor}ms floor, target ${TARGET_MS}ms`
		);
	else
		bad(
			`the chain floor (${chainFloor}ms) is inside the target, so this whole mechanism ` +
				'is unnecessary — recheck the constants before shipping it'
		);

	const fastFloor = 3 * WARM_HIDDEN_RTT_MS;
	if (fastFloor < TARGET_MS)
		ok(`the fast path's floor is 3 hidden hops = ${fastFloor}ms, inside the ${TARGET_MS}ms target`);
	else bad(`even the fast path's floor (${fastFloor}ms) exceeds the target`);
}

// ── 2. END TO END over a real HTTP receiving instance ────────────────
{
	_resetSeenForTest();
	const state: GateState = { blocked: false, blockThrows: false, replied: true, pushes: [] };
	const gates = makeGates(state);

	// Instance B: a real HTTP server running the real verify+deliver path.
	let connections = 0;
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			void (async () => {
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { trx: unknown };
				const verdict = await verifyPushedChatOp(body, lookupKnown);
				if (!verdict.ok) {
					res.writeHead(400, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ code: verdict.code }));
					return;
				}
				void deliverVerifiedPush(verdict.located, verdict.trxId, gates);
				res.writeHead(202, { 'content-type': 'application/json' });
				res.end('{"status":"accepted"}');
			})();
		});
	});
	server.on('connection', () => {
		connections++;
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;
	const peers: FastPeer[] = [{ origin: `http://127.0.0.1:${port}`, hidden: false }];

	// Instance A's transport, with the modelled hidden latency injected on each
	// leg so the measurement reflects a tunnel rather than loopback.
	const postWithHiddenLatency = async (url: string, body: unknown, timeoutMs: number) => {
		await sleep(WARM_HIDDEN_RTT_MS / 2);
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: ctrl.signal
			});
			const text = await res.text();
			await sleep(WARM_HIDDEN_RTT_MS / 2);
			return { status: res.status, body: text };
		} finally {
			clearTimeout(t);
		}
	};

	const waiter = nextFastEvent(TARGET_MS + 2_000);
	const started = Date.now();
	// One more hidden hop for browser→A, which the real send also pays.
	await sleep(WARM_HIDDEN_RTT_MS);
	const e2eSender = new PeerSender({
		proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' },
		timeoutMs: 5_000,
		postIsolated: (url, body, _proxies, ms) => postWithHiddenLatency(url, body, ms)
	});
	e2eSender.enqueue(buildSignedChatTx(), peers);
	await e2eSender.drain();
	const dispatch = e2eSender.stats();
	const ev = await waiter;
	const elapsed = Date.now() - started;

	if (dispatch.delivered === 1) ok('the peer accepted the push (1/1 delivered)');
	else
		bad(
			`dispatch reported ${dispatch.delivered}/1 delivered`,
			dispatch.failures
				.map((f) => f.reason)
				.join('; ')
				.slice(0, 200)
		);

	if (ev !== null) ok(`the message reached the receiving instance's event bus`);
	else bad('the message never reached the receiving side');

	if (ev !== null && ev.sender === SENDER && ev.recipient === RECIPIENT)
		ok('it arrived with the right sender and recipient');
	else if (ev !== null) bad(`wrong parties: ${ev.sender} -> ${ev.recipient}`);

	if (elapsed < TARGET_MS)
		ok(
			`END TO END in ${elapsed}ms, under the ${TARGET_MS}ms target ` +
				`(with ${WARM_HIDDEN_RTT_MS}ms modelled per hidden hop, 3 hops)`
		);
	else
		bad(
			`END TO END took ${elapsed}ms, over the ${TARGET_MS}ms target`,
			`modelled hidden RTT ${WARM_HIDDEN_RTT_MS}ms × 3 hops`
		);

	// A LIVE assertion, not a discarded counter. This used to be `void
	// connections;` — an incremented variable thrown away, left over from a
	// connection-reuse assertion that was removed for being wrong. Dead
	// instrumentation reads like coverage and is worse than none, so either it
	// says something or it goes. Reuse over a hidden transport is measured
	// properly in 2a, through a real SOCKS5 tunnel; what this end-to-end case
	// can honestly say is that one message did not open a fistful of sockets.
	if (connections >= 1 && connections <= 2)
		ok(`the whole exchange used ${connections} connection(s) to the peer`);
	else bad(`one message opened ${connections} connections to the peer`);

	server.closeAllConnections?.();
	await new Promise<void>((r) => server.close(() => r()));
}

// ── 2a. ONE PUSH, ONE CIRCUIT, OVER A REAL SOCKS5 TUNNEL ─────────────
//
// a push must not be linkable to another push — or to this instance —
// by the connection it arrives on. Pushes used to share ONE long-lived pooled
// connection per hidden peer, so a peer that sent one message of its own through
// an instance could label that connection and with it every account on it.
//
// So this scenario routes a `.onion` peer through the REAL transport
// (postJsonViaTorIsolated), through a REAL SOCKS5 proxy implemented below that
// demands username/password authentication — the credentials Tor isolates
// circuits by (IsolateSOCKSAuth) — to the real receiving handler. The proxy
// counts tunnels and records each one's credentials.
//
// It also charges CIRCUIT_BUILD_MS before completing any new CONNECT, which is
// what a fresh Tor circuit costs: every push pays it now, and must still land
// inside the delivery target.
{
	_resetSeenForTest();
	await closePool(); // no dispatcher carried over from another scenario

	/** What a cold circuit costs. Conservative — real ones are often worse. */
	const CIRCUIT_BUILD_MS = 1_500;

	const state: GateState = { blocked: false, blockThrows: false, replied: true, pushes: [] };
	const gates = makeGates(state);

	// The receiving instance, same real handler as scenario 2.
	const origin: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			void (async () => {
				let body: { trx: unknown };
				try {
					body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { trx: unknown };
				} catch {
					res.writeHead(400).end('{}');
					return;
				}
				const verdict = await verifyPushedChatOp(body, lookupKnown);
				if (!verdict.ok) {
					res.writeHead(400, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ code: verdict.code }));
					return;
				}
				void deliverVerifiedPush(verdict.located, verdict.trxId, gates);
				res.writeHead(202, { 'content-type': 'application/json' });
				res.end('{"status":"accepted"}');
			})();
		});
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	const originPort = (origin.address() as AddressInfo).port;

	// A minimal but genuine SOCKS5 proxy: greeting, username/password
	// (RFC 1929), CONNECT (ATYP=domain), then a raw pipe. It counts tunnels and
	// records each tunnel's username, and makes every new one expensive.
	// net.createServer, NOT http.createServer: an HTTP server attaches a parser
	// to every connection, and it destroys the socket the moment the SOCKS
	// greeting fails to look like a request line.
	let tunnels = 0;
	const tunnelUsers: string[] = [];
	const socks: NetServer = createNetServer();
	socks.on('connection', (client) => {
		tunnels++;
		if (process.env.SOCKS_DEBUG)
			console.log(`      [socks] tunnel #${tunnels} at ${Date.now() % 100000}`);
		client.on('close', () => {
			if (process.env.SOCKS_DEBUG)
				console.log(`      [socks] tunnel closed at ${Date.now() % 100000}`);
		});
		let stage: 'greet' | 'auth' | 'connect' | 'piped' = 'greet';
		let acc = Buffer.alloc(0);
		client.on('error', () => undefined);
		client.on('data', (chunk: Buffer) => {
			if (stage === 'piped') return;
			acc = Buffer.concat([acc, chunk]);
			if (stage === 'greet') {
				if (acc.length < 2) return;
				const n = acc[1] ?? 0;
				if (acc.length < 2 + n) return;
				const offersAuth = [...acc.subarray(2, 2 + n)].includes(0x02);
				acc = acc.subarray(2 + n);
				if (!offersAuth) {
					// No credentials, no isolation: refuse, as a proxy that isolates must.
					client.end(Buffer.from([0x05, 0xff]));
					return;
				}
				stage = 'auth';
				client.write(Buffer.from([0x05, 0x02]));
				if (acc.length === 0) return;
			}
			if (stage === 'auth') {
				if (acc.length < 2) return;
				const ulen = acc[1] ?? 0;
				if (acc.length < 3 + ulen) return;
				const plen = acc[2 + ulen] ?? 0;
				if (acc.length < 3 + ulen + plen) return;
				tunnelUsers.push(acc.subarray(2, 2 + ulen).toString('ascii'));
				acc = acc.subarray(3 + ulen + plen);
				stage = 'connect';
				client.write(Buffer.from([0x01, 0x00]));
				if (acc.length === 0) return;
			}
			// CONNECT: VER CMD RSV ATYP LEN <domain> PORT(2)
			if (acc.length < 5) return;
			const len = acc[4] ?? 0;
			if (acc.length < 5 + len + 2) return;
			const rest = acc.subarray(5 + len + 2);
			stage = 'piped';
			// Pay for the circuit before answering — the cost the pool avoids.
			setTimeout(() => {
				const upstream = createConnection({ host: '127.0.0.1', port: originPort });
				upstream.on('error', () => client.destroy());
				upstream.on('connect', () => {
					// 10-byte success reply with an IPv4 BND.ADDR, as the connector
					// parses it.
					client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					if (rest.length > 0) upstream.write(rest);
					client.pipe(upstream);
					upstream.pipe(client);
				});
			}, CIRCUIT_BUILD_MS);
		});
	});
	await new Promise<void>((r) => socks.listen(0, '127.0.0.1', r));
	const socksPort = (socks.address() as AddressInfo).port;

	// A .onion peer. The hostname is never resolved — the SOCKS proxy is asked
	// to reach it, exactly as Tor would be.
	// A valid v3 address shape: exactly 56 characters from base32's [a-z2-7].
	// `hiddenHostNetworkOf` enforces that, and a lookalike using 0/1/8/9 is
	// classified as clearnet — which is how the first draft of this scenario
	// silently routed nowhere.
	const ONION_HOST = `${'morphitfastchatsmoke'.padEnd(56, 'a')}.onion`;
	const onionPeer: FastPeer[] = [{ origin: `http://${ONION_HOST}`, hidden: true }];
	const proxies = { torSocks: `127.0.0.1:${socksPort}`, i2pHttpProxy: '' };

	// First message: pays the circuit build, because nothing warmed it.
	const w1 = nextFastEvent(TARGET_MS + 4_000);
	const cold0 = Date.now();
	const onionSender = makeHiddenSender(proxies);
	onionSender.enqueue(buildSignedChatTx(), onionPeer);
	await onionSender.drain();
	const d1 = onionSender.stats();
	const e1 = await w1;
	const coldMs = Date.now() - cold0;

	if (d1.delivered === 1 && e1 !== null)
		ok(`a .onion peer is reached over an isolated circuit through a real SOCKS5 tunnel`);
	else
		bad(
			`the .onion peer was not reached: delivered=${d1.delivered} event=${e1 !== null}`,
			JSON.stringify(d1).slice(0, 160)
		);

	if (coldMs >= CIRCUIT_BUILD_MS)
		ok(
			`the message paid the ${CIRCUIT_BUILD_MS}ms circuit build (${coldMs}ms) — as every push must`
		);
	else
		bad(
			`the first message took ${coldMs}ms, less than the ${CIRCUIT_BUILD_MS}ms circuit build ` +
				'the proxy charges — the tunnel is not being used, so this scenario proves nothing'
		);

	// Six more. Each must get its OWN tunnel with its own credentials.
	const tunnelsBefore = tunnels;
	const usersBefore = tunnelUsers.length;
	let slowest = 0;
	for (let i = 0; i < 6; i++) {
		const w = nextFastEvent(TARGET_MS + 4_000);
		const t0 = Date.now();
		const one = makeHiddenSender(proxies);
		one.enqueue(buildSignedChatTx(), onionPeer);
		await one.drain();
		await w;
		const took = Date.now() - t0;
		if (process.env.SOCKS_DEBUG) console.log(`      [msg ${i}] ${took}ms tunnels=${tunnels}`);
		slowest = Math.max(slowest, took);
	}
	const opened = tunnels - tunnelsBefore;
	const sixUsers = tunnelUsers.slice(usersBefore);

	if (opened === 6 && new Set(sixUsers).size === 6)
		ok(
			'six further messages took six tunnels with six different isolation credentials — none shares a circuit'
		);
	else
		bad(
			`six further messages opened ${opened} tunnel(s) with ${new Set(sixUsers).size} distinct credential(s)`,
			'two pushes on one connection or one circuit can be tied together by the peer, and ' +
				'with them the accounts they carry'
		);

	if (slowest < TARGET_MS)
		ok(
			`and the slowest of them was ${slowest}ms, inside the ${TARGET_MS}ms target even with a fresh circuit each`
		);
	else
		bad(
			`the slowest subsequent message took ${slowest}ms, over the ${TARGET_MS}ms target`,
			'a fresh circuit per push must still fit the delivery budget'
		);

	// Concurrent pushes to one onion: the claim is about CONCURRENT requests,
	// which a sequential loop cannot make — a pool would merge them onto one
	// connection here if anything did.
	{
		const before = tunnels;
		const beforeUsers = tunnelUsers.length;
		const url = `http://${ONION_HOST}/v1/federation/chat-fast`;
		await Promise.all(
			Array.from({ length: 4 }, () =>
				postJsonViaTorIsolated(url, { trx: buildSignedChatTx() }, proxies, 20_000).catch(
					() => undefined
				)
			)
		);
		const extra = tunnels - before;
		const users = new Set(tunnelUsers.slice(beforeUsers));
		if (extra === 4 && users.size === 4)
			ok('four CONCURRENT pushes to one .onion take four isolated circuits');
		else
			bad(
				`four concurrent pushes to one .onion took ${extra} tunnel(s), ${users.size} credential(s)`
			);
	}

	// Three distinct .onion peers, all cold: if pushes were serialised across
	// peers, three circuit builds would cost 3 × CIRCUIT_BUILD_MS. Concurrent,
	// they cost one.
	const threePeers: FastPeer[] = ['bravo', 'charlie', 'delta'].map((n) => ({
		origin: `http://${`morphitfastchat${n}`.padEnd(56, 'a')}.onion`,
		hidden: true
	}));
	const tunnelsBeforeFan = tunnels;
	const fanStart = Date.now();
	const fanSender = makeHiddenSender(proxies);
	fanSender.enqueue(buildSignedChatTx(), threePeers);
	await fanSender.drain();
	const fan = fanSender.stats();
	const fanMs = Date.now() - fanStart;
	const fanTunnels = tunnels - tunnelsBeforeFan;

	// All three "peers" resolve to the one receiving server here, so two of them
	// answer 400 duplicate — the replay memory doing its job. In production they
	// are three processes with three separate memories and all three take it.
	// What this scenario is about is the TRANSPORT, so the assertion is that
	// every peer was REACHED: an HTTP status back means the circuit built and the
	// round trip completed, whatever the status said.
	const transportFailures = fan.failures.filter((f) => !f.reason.startsWith('HTTP '));
	if (transportFailures.length === 0 && fanTunnels === 3)
		ok('three separate .onion peers each get their own circuit');
	else
		bad(
			`hidden fan-out did not reach all three peers: ${transportFailures.length} transport ` +
				`failure(s), ${fanTunnels} tunnel(s) opened for 3 peers`,
			transportFailures
				.map((f) => f.reason)
				.join('; ')
				.slice(0, 200)
		);

	if (fanMs < CIRCUIT_BUILD_MS * 2)
		ok(
			`and all three were built concurrently (${fanMs}ms, not ${CIRCUIT_BUILD_MS * 3}ms) — ` +
				'peers are not serialised against each other'
		);
	else
		bad(
			`three cold peers took ${fanMs}ms, near the ${CIRCUIT_BUILD_MS * 3}ms a serial fan-out ` +
				"would cost — the slowest peer has become everyone else's latency"
		);

	await closePool();
	socks.close();
	origin.closeAllConnections?.();
	await new Promise<void>((r) => origin.close(() => r()));
}

// ── 2c. A PEER THAT ANSWERS BADLY IS NOT A DELIVERY ──────────────────
//
// A dead peer throws and is obviously a failure. A peer that is UP but answering
// 500 — mid-restart, out of disk, a bad deploy — answers promptly and happily,
// and if the status were not checked it would be counted as a successful
// delivery. The federation would then report itself perfectly healthy while
// delivering nothing at all, which is worse than being down: an operator
// watching the counters would have no reason to look.
{
	_resetSeenForTest();
	const sick: Server = createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end('{"error":"out of disk"}');
		});
	});
	await new Promise<void>((r) => sick.listen(0, '127.0.0.1', r));
	const sickPort = (sick.address() as AddressInfo).port;

	const sickSender = makeSender();
	sickSender.enqueue(buildSignedChatTx(), [
		{ origin: `http://127.0.0.1:${sickPort}`, hidden: false }
	]);
	await sickSender.drain();
	const res = sickSender.stats();

	if (res.delivered === 0 && res.failed === 1)
		ok('a peer answering 500 is counted as a FAILURE, not a delivery');
	else
		bad(
			`a peer answering 500 was counted as delivered=${res.delivered} failed=${res.failed}`,
			'an instance that answers but refuses the message has not delivered it'
		);

	if (res.failures[0]?.reason === 'HTTP 500')
		ok('and the reason recorded is the status it actually returned');
	else
		bad(
			`expected reason 'HTTP 500', got ${JSON.stringify(res.failures[0]?.reason)}`,
			'an operator needs the reason, not just a count'
		);

	sick.closeAllConnections?.();
	await new Promise<void>((r) => sick.close(() => r()));
}

// ── 2d. BATCHING: what makes fan-out survive thousands of users ──────
//
// Every message goes to every instance, so each instance must ACCEPT the whole
// federation's message rate. A thousand users sending once a minute is about
// seventeen messages a second. One message per POST cannot carry that over a
// hidden transport: a connection completes one round trip at a time, so at a
// 1.5-second round trip it sustains well under one message a second, and more
// connections is not the answer — seventeen a second would need twenty-five
// circuits per peer, and building circuits is the cost this design exists to
// avoid.
//
// So messages that arrive while a push is in flight ride along with the next
// one. This measures that: the number of ROUND TRIPS a burst costs, which is
// what the throughput ceiling is actually made of.
{
	_resetSeenForTest();
	const PEER_RTT_MS = 300;
	let requests = 0;
	let largestSeen = 0;

	const peer: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			requests++;
			try {
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
					trx?: unknown;
					trxs?: unknown[];
				};
				const n = Array.isArray(body.trxs) ? body.trxs.length : 1;
				if (n > largestSeen) largestSeen = n;
			} catch {
				/* the assertions below will catch a malformed push */
			}
			// Answer after a round trip, so queueing behaviour is real rather than
			// collapsed by an instant loopback reply.
			setTimeout(() => {
				res.writeHead(202, { 'content-type': 'application/json' });
				res.end('{"status":"accepted"}');
			}, PEER_RTT_MS);
		});
	});
	await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
	const peerPort = (peer.address() as AddressInfo).port;

	const sender = new PeerSender({
		proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' },
		timeoutMs: 10_000,
		postIsolated: async (url, body, _proxies, timeoutMs) => {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), timeoutMs);
			try {
				const r = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
					signal: ctrl.signal
				});
				return { status: r.status, body: await r.text() };
			} finally {
				clearTimeout(t);
			}
		}
	});

	const peers: FastPeer[] = [{ origin: `http://127.0.0.1:${peerPort}`, hidden: false }];
	const BURST = 40;
	const t0 = Date.now();
	for (let i = 0; i < BURST; i++) sender.enqueue(buildSignedChatTx(), peers);
	await sender.drain();
	const burstMs = Date.now() - t0;

	// Without batching this is BURST round trips. With it, the first message
	// goes alone and everything queued behind it rides in the next push or two.
	const unbatchedMs = BURST * PEER_RTT_MS;
	if (requests < BURST / 2)
		ok(
			`${BURST} messages to one peer cost ${requests} round trips, not ${BURST} — ` +
				`they are riding together (largest batch ${largestSeen})`
		);
	else
		bad(
			`${BURST} messages cost ${requests} round trips; they are not being batched`,
			'per-peer throughput is then one message per round trip, which a federation ' +
				'of any size will outrun'
		);

	if (burstMs < unbatchedMs / 2)
		ok(
			`the burst cleared in ${burstMs}ms against ${unbatchedMs}ms unbatched — ` +
				`${(unbatchedMs / Math.max(burstMs, 1)).toFixed(1)}x the throughput per peer`
		);
	else bad(`the burst took ${burstMs}ms, no better than the ${unbatchedMs}ms unbatched cost`);

	const st = sender.stats();
	if (st.delivered === BURST && st.failed === 0)
		ok(`and all ${BURST} were accounted as delivered — batching loses nothing`);
	else bad(`delivered=${st.delivered} failed=${st.failed}, expected ${BURST} delivered`);

	if (largestSeen <= BATCH_MAX)
		ok(`no push exceeded the ${BATCH_MAX}-transaction cap (largest ${largestSeen})`);
	else
		bad(
			`a push carried ${largestSeen} transactions, over the ${BATCH_MAX} cap`,
			'each entry costs the receiver a signature recovery, so the cap is a cost bound'
		);

	peer.closeAllConnections?.();
	await new Promise<void>((r) => peer.close(() => r()));
}

// ── 2e. AN IDLE PEER IS NEVER MADE TO WAIT ───────────────────────────
//
// The batching above must not have been bought by delaying anybody. It is
// opportunistic: a batch forms only from messages that turn up while a push is
// already in flight. A lone message to an idle peer must leave immediately —
// that is the case the six-second target is actually measured on, and a timed
// batching window would have quietly taxed it.
{
	_resetSeenForTest();
	let firstSeenAt = 0;
	const peer: Server = createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			if (firstSeenAt === 0) firstSeenAt = Date.now();
			res.writeHead(202, { 'content-type': 'application/json' });
			res.end('{"status":"accepted"}');
		});
	});
	await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
	const peerPort = (peer.address() as AddressInfo).port;

	const sender = new PeerSender({
		proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' },
		timeoutMs: 5_000,
		postIsolated: async (url, body, _proxies, timeoutMs) => {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), timeoutMs);
			try {
				const r = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
					signal: ctrl.signal
				});
				return { status: r.status, body: await r.text() };
			} finally {
				clearTimeout(t);
			}
		}
	});

	const t0 = Date.now();
	sender.enqueue(buildSignedChatTx(), [{ origin: `http://127.0.0.1:${peerPort}`, hidden: false }]);
	await sender.drain();
	const leftAfterMs = firstSeenAt - t0;

	// Generous: this is loopback, so anything beyond a few tens of milliseconds
	// would be a deliberate wait rather than scheduling noise.
	if (firstSeenAt > 0 && leftAfterMs < 100)
		ok(`a lone message left for an idle peer in ${leftAfterMs}ms — nothing is held back`);
	else if (firstSeenAt === 0) bad('a lone message never left at all');
	else
		bad(
			`a lone message waited ${leftAfterMs}ms before leaving`,
			'batching must be opportunistic; delaying an idle send taxes every conversation ' +
				'to buy throughput that is only needed under load'
		);

	peer.closeAllConnections?.();
	await new Promise<void>((r) => peer.close(() => r()));
}

// ── 2f. THE REAL ENDPOINT, HANDED A REAL BATCH ───────────────────────
//
// The batching scenarios above measure the SENDER against a counting stub. That
// says nothing about whether the receiving endpoint understands what it is sent
// — and a sender that batches perfectly into a peer that drops all but the
// first message is worse than no batching at all, because it looks healthy.
// So this drives the actual `federationChatFastRoute`.
{
	_resetSeenForTest();

	// The route's own queries, answered as the real gates would see them.
	const db: FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
			const rows: unknown[] = [];
			if (text.includes('posting_pubkey')) rows.push({ posting_pubkey: senderPub });
			else if (text.includes('FROM blocks')) rows.push({ exists: false });
			else if (text.includes('FROM chat_messages')) rows.push({ exists: true });
			return {
				rows: rows as R[],
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	};
	const intake = federationChatFastRoute(db);
	const route = intake.app;

	const seenEvents: string[] = [];
	const off = chatEventBus.onFast((ev) => {
		if (ev.clientTag !== null) seenEvents.push(ev.clientTag);
	});

	const post = async (body: unknown): Promise<number> => {
		const r = await route.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		return r.status;
	};

	// A batch of three distinct messages.
	const three = [buildSignedChatTx(), buildSignedChatTx(), buildSignedChatTx()];
	const status = await post({ trxs: three });
	// Delivery is fire-and-forget inside the route, so give it a tick to land.
	await sleep(120);

	if (status === 202) ok('the real endpoint accepts a batch (202)');
	else bad(`the real endpoint answered ${status} to a batch of three`);

	if (seenEvents.length === 3)
		ok('and every message in the batch was delivered, not just the first');
	else
		bad(
			`a batch of 3 produced ${seenEvents.length} delivered message(s)`,
			'a peer that batches into an endpoint that drops the rest is worse than no batching'
		);

	// One rotten entry must not discard the good ones beside it. A batch is an
	// accident of timing — unrelated messages from unrelated senders.
	_resetSeenForTest();
	seenEvents.length = 0;
	const mixed = [buildSignedChatTx(), { not: 'a transaction' }, buildSignedChatTx()];
	const mixedStatus = await post({ trxs: mixed });
	await sleep(120);
	if (mixedStatus === 202 && seenEvents.length === 2)
		ok('a malformed entry is dropped and the good messages beside it still arrive');
	else
		bad(
			`mixed batch: status ${mixedStatus}, ${seenEvents.length} delivered (expected 202 and 2)`,
			'one bad entry must not cost unrelated senders their messages'
		);

	// A batch of nothing but rubbish is the peer's problem to hear about.
	_resetSeenForTest();
	const junkStatus = await post({ trxs: [{ junk: true }, { junk: true }] });
	if (junkStatus === 400) ok('a batch with nothing usable in it is refused (400)');
	else bad(`a wholly unusable batch answered ${junkStatus}, expected 400`);

	// Unbounded batches would be a cheap way to make us burn CPU on signature
	// recovery, so the cap is enforced at the door.
	const oversized = Array.from({ length: BATCH_MAX + 1 }, () => buildSignedChatTx());
	const bigStatus = await post({ trxs: oversized });
	if (bigStatus === 400) ok(`a batch over the ${BATCH_MAX} cap is refused (400)`);
	else
		bad(
			`a batch of ${oversized.length} answered ${bigStatus}, expected 400`,
			'each entry costs a signature recovery; an unbounded batch is a cheap CPU attack'
		);

	if ((await post({ trxs: [] })) === 400) ok('an empty batch is refused (400)');
	else bad('an empty batch was not refused');

	off();
}

// ── 2g. THE RESPONSE PATH DOES NO CRYPTOGRAPHY ───────────────────────
//
// Signature recovery costs about 4.4 ms — measured on this tree, not assumed —
// so verifying a full batch inline would cost roughly a quarter of a second of
// blocking CPU before the peer got its answer. Two things go wrong if it does.
//
// It puts that CPU inside the sender's round trip, which is the budget this
// whole mechanism exists to protect. And it makes the instance measurably
// slower to answer for a message it cared about than for one it did not, which
// turns the deliberately uniform 202 into a stopwatch that says whether a given
// account reads their mail here.
{
	_resetSeenForTest();
	const db: FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
			const rows: unknown[] = [];
			if (text.includes('posting_pubkey')) rows.push({ posting_pubkey: senderPub });
			else if (text.includes('FROM blocks')) rows.push({ exists: false });
			else if (text.includes('FROM chat_messages')) rows.push({ exists: true });
			return {
				rows: rows as R[],
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	};
	const intake = federationChatFastRoute(db);

	const full = Array.from({ length: BATCH_MAX }, () => buildSignedChatTx());

	// How long verifying this batch actually costs, measured right here rather
	// than taken from a comment — so the assertion below compares against this
	// machine on this day.
	_resetSeenForTest();
	const vStart = Date.now();
	for (const trx of full.slice(0, 8)) await verifyPushedChatOp({ trx }, lookupKnown);
	const perVerifyMs = (Date.now() - vStart) / 8;
	const inlineCostMs = perVerifyMs * BATCH_MAX;

	_resetSeenForTest();
	const t0 = Date.now();
	const res = await intake.app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ trxs: full })
	});
	const answeredMs = Date.now() - t0;

	if (res.status === 202) ok(`a full batch of ${BATCH_MAX} is accepted (202)`);
	else bad(`a full batch answered ${res.status}`);

	// Generous: a third of what inline verification would cost. The point is the
	// order of magnitude, not a tight bound on a shared machine.
	if (answeredMs < inlineCostMs / 3)
		ok(
			`answered in ${answeredMs}ms against the ~${Math.round(inlineCostMs)}ms verifying ` +
				`${BATCH_MAX} signatures costs (${perVerifyMs.toFixed(1)}ms each) — the crypto is ` +
				'not on the response path'
		);
	else
		bad(
			`answering took ${answeredMs}ms, close to the ~${Math.round(inlineCostMs)}ms of inline ` +
				'verification',
			"that CPU is inside the sender's round trip, and it times how interesting the " +
				'message was to us'
		);

	// The work still happens — this is deferral, not discarding.
	const deadline = Date.now() + 8_000;
	while (intake.stats().verified < BATCH_MAX && Date.now() < deadline) await sleep(50);
	if (intake.stats().verified === BATCH_MAX)
		ok(`and all ${BATCH_MAX} were verified afterwards — deferred, not dropped`);
	else bad(`only ${intake.stats().verified}/${BATCH_MAX} were verified after the answer`);
}

// ── 2h. A BATCH MUST NOT STARVE THE EVENT LOOP ───────────────────────
//
// Verification is synchronous CPU. Without an explicit yield, a batch of it runs
// to completion before Node does anything else — no SSE frames, no user
// requests, nothing. The instance would go briefly deaf every time a peer sent
// it a busy moment's worth of chat, which is precisely when it can least afford
// to. An `await` is not enough: awaiting an already-resolved promise drains the
// microtask queue without ever reaching the I/O phase.
{
	_resetSeenForTest();
	const db: FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
			const rows: unknown[] = [];
			if (text.includes('posting_pubkey')) rows.push({ posting_pubkey: senderPub });
			else if (text.includes('FROM blocks')) rows.push({ exists: false });
			else if (text.includes('FROM chat_messages')) rows.push({ exists: true });
			return {
				rows: rows as R[],
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	};
	const intake = federationChatFastRoute(db);

	// Measured as the LONGEST GAP between timer ticks, not as a count of them.
	//
	// Two earlier versions of this got it wrong. The first divided by "however
	// long verification took", which was zero when the work had already
	// finished — vacuously true. The second counted ticks in a fixed window,
	// which does separate a healthy loop from a starved one but only just: a
	// batch that blocks for 184 ms inside a 500 ms window still lets 31 of 50
	// ticks through, so any threshold loose enough to tolerate a busy machine
	// was also loose enough to miss the bug.
	//
	// The gap is the honest measure. A loop that is breathing never misses a
	// 10 ms timer by much, whatever else it is doing; a loop held by a batch of
	// synchronous cryptography shows one long silence exactly as wide as the
	// work. Count says "mostly fine on average"; gap says "for 184 ms this
	// instance answered nobody", which is the thing that matters to someone
	// waiting on an SSE frame.
	const WINDOW_MS = 600;
	const TICK_MS = 10;

	const tickAt: number[] = [];
	const ticker = setInterval(() => {
		tickAt.push(Date.now());
	}, TICK_MS);

	const full = Array.from({ length: BATCH_MAX }, () => buildSignedChatTx());
	const windowStart = Date.now();
	await intake.app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ trxs: full })
	});
	await sleep(WINDOW_MS);
	clearInterval(ticker);

	let longestGapMs = 0;
	let previous = windowStart;
	for (const t of tickAt) {
		longestGapMs = Math.max(longestGapMs, t - previous);
		previous = t;
	}

	// Generous: six times the tick interval. Ordinary scheduler noise is a few
	// milliseconds; a batch of 64 verifications is 200-350 ms of solid CPU, so
	// there is an order of magnitude between "busy machine" and "deaf instance".
	const MAX_ACCEPTABLE_GAP_MS = TICK_MS * 6;
	if (tickAt.length > 0 && longestGapMs < MAX_ACCEPTABLE_GAP_MS)
		ok(
			`the event loop never went quiet for more than ${longestGapMs}ms while ${BATCH_MAX} ` +
				'verifications ran — it is yielding between them'
		);
	else
		bad(
			`the event loop went silent for ${longestGapMs}ms while a batch verified ` +
				`(${tickAt.length} timer ticks seen)`,
			'for that whole stretch the instance answered nobody — no SSE frames, no user ' +
				'requests — which is the moment it can least afford to go deaf'
		);
	// And the work must still have happened; a yield that dropped it would also
	// keep the ticker happy.
	if (intake.stats().verified > 0) ok('and the batch was verified, not abandoned');
	else bad('nothing was verified at all');
}

// ── 2i. OVERLOAD SHEDS RATHER THAN PILING UP ─────────────────────────
//
// The queue is the real admission control, because the per-IP rate limit cannot
// see peers apart on a hidden transport — over Tor every instance in the
// federation arrives as 127.0.0.1. Past the queue bound the right move is to
// drop: the chain is carrying every one of these messages anyway, so an
// overloaded instance degrades to ordinary chain timing instead of queueing work
// it cannot finish inside anyone's six seconds.
{
	_resetSeenForTest();
	// A database that answers SLOWLY rather than one that never answers. An
	// earlier version used a promise that never settled, which filled the queue
	// nicely and also meant any mutation making the handler await its own work
	// hung the whole smoke — reported as a crash rather than as a caught bug.
	// Slow-but-finite fills the queue just as well and always terminates.
	const db: FastFederationDb = {
		async query<R extends pg.QueryResultRow>(): Promise<pg.QueryResult<R>> {
			await sleep(25);
			return {
				rows: [] as R[],
				rowCount: 0,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	};
	const intake = federationChatFastRoute(db);

	// Offered CONCURRENTLY, the way a federation actually behaves: twenty peers
	// do not wait politely for each other.
	const results = await Promise.all(
		Array.from({ length: 20 }, () => {
			const batch = Array.from({ length: BATCH_MAX }, () => buildSignedChatTx());
			return intake.app.request('/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ trxs: batch })
			});
		})
	);
	const sawShed = intake.stats().shed > 0;
	const allAccepted = results.every((r) => r.status === 202);

	if (sawShed) ok('past its queue bound the instance sheds instead of queueing without limit');
	else bad('the intake queue never shed — it is unbounded, and a flood becomes memory');

	if (allAccepted)
		ok('and it still answers 202 while shedding — a peer that did nothing wrong is not blamed');
	else
		bad(
			'a shedding instance answered something other than 202',
			'the peer cannot fix our backlog, and a retry would only add to it'
		);

	const st = intake.stats();
	// `queueDepth <= VERIFY_QUEUE_MAX` is true by construction — the push is the
	// only thing that grows the queue and it checks the bound first — so reading
	// it back proves nothing at all, and it is read while the worker is draining
	// besides. The evidence that the bound was REACHED and HONOURED is the shed
	// count: transactions that were offered and deliberately not taken.
	const offered = 20 * BATCH_MAX;
	if (st.shed > 0 && st.verified + st.refused + st.shed + st.queueDepth <= offered)
		ok(
			`${st.shed} of ${offered} offered were shed rather than queued, and the queue ` +
				`never exceeded its bound (now ${st.queueDepth})`
		);
	else if (st.shed === 0)
		bad(
			`nothing was shed out of ${offered} transactions offered`,
			'the queue is either unbounded or the flood was not large enough to reach it — ' +
				'either way this scenario is not testing what it says'
		);
	else bad(`the accounting does not add up: ${JSON.stringify(st)} against ${offered} offered`);
}

// ── 2i-bis. THE QUEUE BOUND IS A TIME, NOT A COUNT ───────────────────
//
// The scenario above proves the queue sheds. It cannot prove the bound is the
// RIGHT one, because it floods far past any plausible bound and would shed
// against a fixed 500 exactly as it does against a derived depth.
//
// The bound is what decides whether a message this instance ACCEPTS can still
// be delivered inside six seconds. A message entering at depth D waits for D
// verifications before its own — one worker, sequentially, each a signature
// recovery plus an uncached posting-key read. So depth is latency, and the
// depth that fits depends on what a verification costs on this box: measured at
// ~5.75 ms here, 500 deep is 2.9 s and fits; at 20 ms on a small VPS it is 10 s
// and does not, and the instance would be accepting messages (202, the peer
// counts them delivered) that it cannot deliver in time. That is worse than
// shedding them, because a shed message goes by chain and nobody was misled.
//
// `admissionDepthFor` is pure and exported precisely so this can be checked at
// costs no test machine produces. Asserted through the REAL function rather
// than a copy of the formula: three mutations against an earlier version of
// this fix survived a test that re-implemented the arithmetic, because on fast
// hardware every one of them was equivalent.
{
	// A fast box: the ceiling binds, not the budget. Memory is still finite.
	if (admissionDepthFor(0.5) === VERIFY_QUEUE_MAX)
		ok('a fast box is capped by the ceiling, not by the clock');
	else bad('the ceiling no longer caps a fast box', String(admissionDepthFor(0.5)));

	// A slow box: the budget binds, and the queue gets shallower than the
	// ceiling. This is the case the whole mechanism exists for.
	const slow = admissionDepthFor(20);
	if (slow < VERIFY_QUEUE_MAX && slow > 0)
		ok(`a slow box (20ms/verify) is held to ${slow}, below the ${VERIFY_QUEUE_MAX} ceiling`);
	else
		bad(
			'a slow box is not held below the ceiling — it will accept messages it cannot deliver in time',
			`got ${slow}`
		);

	// THE INVARIANT, across the whole plausible range: whatever depth is
	// admitted, draining it must still fit the budget the transport path leaves.
	// This is the property; the numbers above are examples of it.
	// The MODULE's value, not a copy of the arithmetic. Hard-coding 6000-1400
	// here meant changing the transport budget left this assertion green against
	// a number nothing shipped.
	const ALLOWANCE_MS = QUEUE_WAIT_ALLOWANCE_MS;
	let worst = '';
	for (const cost of [1, 2, 5.75, 8, 10, 15, 20, 40]) {
		const depth = admissionDepthFor(cost);
		if (depth * cost > ALLOWANCE_MS) {
			worst = `${cost}ms/verify -> depth ${depth} = ${(depth * cost).toFixed(0)}ms`;
			break;
		}
	}
	if (worst === '')
		ok(`a full queue drains inside ${ALLOWANCE_MS}ms at every verification cost tried`);
	else
		bad(
			'a full queue would miss the six-second budget at some verification cost',
			`${worst} exceeds the ${ALLOWANCE_MS}ms the transport path leaves`
		);

	// And the bound must MOVE with the cost, or it is not derived from anything.
	if (admissionDepthFor(40) < admissionDepthFor(10))
		ok('the bound tracks the machine — slower box, shallower queue');
	else bad('the bound does not vary with the measured cost — it is not derived');
}

// ── 2i-ter. THE REPLAY MEMORY CANNOT BE FLUSHED TO MAKE ROOM ─────────
//
// The replay window above is closed by TIME. This is the other way in: flush
// the memory instead of waiting for it.
//
// `seen` remembers a trx id so a second push of it is refused. It is bounded,
// and it used to evict the oldest entry whenever it was full — which silently
// turns "remembered for ten minutes" into "remembered until 50,000 other things
// happen", and an attacker signs transactions of their own for free, so THEY
// decide how fast those other things happen.
//
// The arithmetic, measured rather than assumed: verification costs ~5.75 ms on
// this box, so 50,000 entries turn over in 288 s — inside the 480 s a captured
// push stays valid. Capture a push, flood for five minutes, push it again.
// Note the inversion: the FASTER the instance, the sooner the table turns over,
// so better hardware made the hole wider. Raising the cap only moves it — at
// 2 ms a verification it would need a quarter of a million entries.
//
// So the table refuses instead of forgetting: an entry still inside
// MAX_FUTURE_MS + MAX_AGE_MS is never evicted, and a push that would require
// evicting one is declined and falls back to chain delivery, exactly like every
// other capacity limit here.
//
// Exercised with the table shrunk, because filling the real one is 50,000
// signature verifications. Same code path, a scale that fits in a smoke.
{
	_resetSeenForTest();
	_setSeenMaxForTest(8);
	const T0 = Date.now();
	const captured = buildSignedChatTx({
		expiration: new Date(T0 + MAX_FUTURE_MS).toISOString().slice(0, 19)
	});

	const first = await verifyPushedChatOp({ trx: captured }, lookupKnown, new Date(T0));
	if (first.ok) ok('the captured push is accepted the first time');
	else bad(`the fixture push was refused as ${first.code} — the rest proves nothing`);

	// The flood. Each entry needs only a distinct trx id, which a distinct
	// client_tag gives; a real attacker signs with their own account, which
	// costs them nothing and reaches the identical code path — the table does
	// not care who signed, only that the signature verified.
	let accepted = 0;
	let refusedFull = 0;
	for (let i = 1; i <= 20; i++) {
		const r = await verifyPushedChatOp(
			{ trx: buildSignedChatTx({ clientTag: `flood-${i}` }) },
			lookupKnown,
			new Date(T0 + 2_000)
		);
		if (r.ok) accepted++;
		else if (r.code === 'replay_table_full') refusedFull++;
	}
	if (refusedFull > 0)
		ok(`a flood is refused once the table is full of protected entries (${refusedFull} of 20)`);
	else
		bad(
			'the replay memory evicted protected entries to make room for a flood',
			`${accepted} of 20 accepted with no refusal — the captured push can now be replayed`
		);

	// THE PROPERTY. Still inside its validity window, the captured push must
	// still be recognised as a replay.
	const replay = await verifyPushedChatOp({ trx: captured }, lookupKnown, new Date(T0 + 240_000));
	if (!replay.ok && replay.code === 'duplicate')
		ok('and the captured push is still refused as a duplicate after the flood');
	else
		bad(
			'a captured push was REPLAYED after flushing the replay memory',
			`got ${replay.ok ? 'accepted' : replay.code} — flooding the table defeats replay protection`
		);

	// And the refusal must be counted, or an operator cannot tell this from
	// ordinary quiet.
	if (replayTableFullCount() > 0)
		ok(`the refusals are counted for the operator (${replayTableFullCount()})`);
	else bad('pushes were refused to protect the replay memory and nothing counted it');

	// The table must RECOVER: once entries age past the protection horizon they
	// are evictable again, or one flood disables the fast path permanently.
	// Its expiry has to be valid at the SIMULATED time, not at real `now` — a
	// default-expiry transaction is long dead by T0+500s and would be refused as
	// `expired`, which would pass this assertion for entirely the wrong reason.
	const horizonAt = T0 + MAX_FUTURE_MS + MAX_AGE_MS + 20_000;
	const later = await verifyPushedChatOp(
		{
			trx: buildSignedChatTx({
				clientTag: 'after-horizon',
				expiration: new Date(horizonAt + 60_000).toISOString().slice(0, 19)
			})
		},
		lookupKnown,
		new Date(horizonAt)
	);
	if (later.ok) ok('and the table recovers once its entries age past the protection horizon');
	else
		bad(
			'the replay memory never recovers — one flood disables the fast path for good',
			`a push past the horizon was still refused as ${later.code}`
		);

	_resetSeenForTest();
}

// ── 2j. THE WHOLE FEDERATION ARRIVES AS ONE IP ───────────────────────
//
// On a hidden-service instance the per-IP rate limiter cannot tell peers apart.
// Tor and I2P hand every inbound request to the local daemon, so nginx sees
// 127.0.0.1 and sets `X-Real-IP: 127.0.0.1`, and every instance in the
// federation — plus every human user, on a zero-clearnet node where all traffic
// arrives that way — shares ONE bucket.
//
// This was not theory. At the endpoint's first value of 240 a minute, the 241st
// push in a minute was refused no matter how many distinct instances sent them,
// which would have throttled the federation to a crawl on exactly the nodes this
// feature was built for. The limit now has to accommodate the whole federation,
// and this scenario exists to stop anyone quietly lowering it back.
{
	_resetSeenForTest();
	const db: FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
			const rows: unknown[] = [];
			if (text.includes('posting_pubkey')) rows.push({ posting_pubkey: senderPub });
			else if (text.includes('FROM blocks')) rows.push({ exists: false });
			else if (text.includes('FROM chat_messages')) rows.push({ exists: true });
			return {
				rows: rows as R[],
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	};
	const intake = federationChatFastRoute(db);

	// What a real federation puts through that single bucket in one minute:
	// forty instances, each with at most one push in flight at a time, over a
	// 1.5-second round trip.
	const PEERS = 40;
	const RTT_MS = 1_500;
	const PUSHES_PER_MINUTE = Math.round((PEERS * 60_000) / RTT_MS);

	// The socket peer and the forwarded address are both loopback — precisely
	// what nginx reports for a .onion request.
	const torEnv = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
	const body = JSON.stringify({ trx: buildSignedChatTx() });

	let limited = 0;
	for (let i = 0; i < PUSHES_PER_MINUTE; i++) {
		const r = await intake.app.request(
			'/',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-real-ip': '127.0.0.1' },
				body
			},
			torEnv
		);
		if (r.status === 429) limited++;
	}

	if (limited === 0)
		ok(
			`a ${PEERS}-instance federation's ${PUSHES_PER_MINUTE} pushes a minute pass through ` +
				'one shared bucket without being throttled'
		);
	else
		bad(
			`${limited} of ${PUSHES_PER_MINUTE} federation pushes were rate-limited`,
			'over a hidden transport every peer looks like 127.0.0.1, so a per-IP ceiling sized ' +
				'for one caller throttles the entire federation'
		);
}

// ── 2b. THE OLD PATH, ACTUALLY RUN ───────────────────────────────────
//
// Scenario 1 shows by arithmetic that the chain cannot fit in six seconds.
// Arithmetic is an argument, and an argument is not a measurement: if the
// constants in this file ever drifted from the ones the system uses, that sum
// would go on being internally consistent and mean nothing.
//
// So this walks the architecture we replaced, with real timers, under exactly
// the modelled conditions scenario 2 used. BE PRECISE ABOUT WHAT THAT IS: no
// product code runs in this block, so it is not a measurement of the old
// system — it is the same arithmetic with timers attached, which makes it take
// real time without making it evidence. What it IS good for is holding the same
// constants as the measured path above, so the two cannot drift apart: retune a
// hop and both numbers move together. Without a baseline of some kind, "1.4
// seconds" is a number nobody can judge; with this one, the comparison is at
// least internally consistent, and the comparison is all it claims to be.
{
	const started = Date.now();

	// Leg 1 — the sender's browser reaches its own instance over a hidden hop.
	await sleep(WARM_HIDDEN_RTT_MS);

	// Leg 2 — broadcast_transaction_synchronous does not return until the
	// transaction is IN a block. One block interval, and this is the floor: it
	// is what you pay when your transaction happens to catch the very next
	// block, not the average.
	await sleep(BLOCK_INTERVAL_MS);

	// Leg 3 — the RECEIVING instance's head tailer has to notice. A real
	// polling loop, at the real interval, started at a real moment: the arrival
	// lands wherever it lands inside the tick, which is the honest model of a
	// poller nobody is coordinating with.
	const chainDelivered = new Promise<void>((resolve) => {
		const tick = setInterval(() => {
			clearInterval(tick);
			resolve();
		}, HEAD_TAILER_POLL_MS);
	});
	await chainDelivered;

	// Leg 4 — the tailer fetches that block from an RPC node, over a hidden
	// hop, and only then does the event reach the recipient's browser (a
	// further hop). Two more hidden legs.
	await sleep(WARM_HIDDEN_RTT_MS * 2);

	const chainElapsed = Date.now() - started;
	if (chainElapsed > TARGET_MS)
		ok(
			`the old chain-mediated path, on the same modelled hops, comes to ${chainElapsed}ms — over the ` +
				`${TARGET_MS}ms target, and this is its BEST case. This is the failure the fast ` +
				'path exists to fix'
		);
	else
		bad(
			`the old chain path completed in ${chainElapsed}ms, inside the target — if that is ` +
				'real, the fast path is unnecessary and should be reverted rather than shipped',
			`block ${BLOCK_INTERVAL_MS}ms + poll ${HEAD_TAILER_POLL_MS}ms + 3 × ${WARM_HIDDEN_RTT_MS}ms`
		);
}

// ── 3. A forged message is refused ───────────────────────────────────
{
	_resetSeenForTest();
	const forged = buildSignedChatTx({ signWith: strangerKey });
	const v = await verifyPushedChatOp({ trx: forged }, lookupKnown);
	if (!v.ok && v.code === 'bad_signature')
		ok('a transaction signed by someone other than the sender is refused');
	else bad(`a forged signature was accepted: ${JSON.stringify(v).slice(0, 120)}`);
}

// ── 4. A sender we have never seen is refused ────────────────────────
{
	_resetSeenForTest();
	const v = await verifyPushedChatOp({ trx: buildSignedChatTx() }, async () => null);
	// TWO assertions, and the order matters. The first is the invariant: an
	// account we have never seen is REFUSED. There is no key to check the
	// signature against, so accepting would mean emitting a message on the word
	// of whoever pushed it — the one thing this path must never do. The second
	// only checks that the refusal says why, and would be satisfied by a
	// misleading label; asserting only that, as this scenario used to, meant a
	// mutation could rename the code and look caught while the hole stayed shut,
	// or open the hole and look fine.
	if (!v.ok) ok('a sender with no posting key on file is REFUSED, not guessed at');
	else bad(`an unverifiable sender was accepted: ${JSON.stringify(v).slice(0, 160)}`);
	if (!v.ok && v.code === 'unknown_sender')
		ok('and the refusal names the reason, so an operator can tell it from a bad signature');
	else if (!v.ok) bad(`refused, but reported as '${v.code}' rather than unknown_sender`);
}

// ── 5. A replay is refused ───────────────────────────────────────────
{
	_resetSeenForTest();
	const tx = buildSignedChatTx();
	const first = await verifyPushedChatOp({ trx: tx }, lookupKnown);
	const second = await verifyPushedChatOp({ trx: tx }, lookupKnown);
	if (first.ok && !second.ok && second.code === 'duplicate')
		ok('the same transaction pushed twice is delivered once');
	else bad('a replayed push was not suppressed');
}

// ── 6. Shape abuse is refused ────────────────────────────────────────
{
	_resetSeenForTest();
	const cases: [string, unknown, string][] = [
		['a non-chat op', buildSignedChatTx({ opId: 'morphit_profile_v1' }), 'not_a_chat_op'],
		['a second op riding along', buildSignedChatTx({ extraOp: true }), 'too_many_ops'],
		[
			'a long-expired transaction',
			buildSignedChatTx({
				expiration: new Date(Date.now() - 3_600_000).toISOString().slice(0, 19)
			}),
			'expired'
		],
		['no transaction at all', undefined, 'malformed']
	];
	for (const [label, trx, expected] of cases) {
		const v = await verifyPushedChatOp({ trx }, lookupKnown);
		if (!v.ok && v.code === expected) ok(`${label} is refused (${expected})`);
		else bad(`${label} was not refused as ${expected}`, JSON.stringify(v).slice(0, 120));
	}
}

// ── 6a. THE REPLAY WINDOW HOLDS WHATEVER TYPE THE EXPIRY ARRIVES AS ──
//
// v1.18.0 review (R1). The expiry bounds ran only `if (typeof expiration ===
// 'string')`. dblurt's serializer builds the date as `new Date(value + 'Z')`,
// so an ARRAY holding the same string serializes to the same bytes: same
// digest, same signature, same transaction id — and no expiry check at all.
// Every chat message ever written to the chain is public, signature included,
// so any of them could be pushed to any instance as new, forever. These are the
// shapes that must now be refused, each for the reason that applies.
{
	const oldExp = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19);
	const nowExp = new Date(Date.now() + 60_000).toISOString().slice(0, 19);
	const reshape = (tx: unknown, patch: Record<string, unknown>): unknown => ({
		...(tx as Record<string, unknown>),
		...patch
	});
	const oldTx = buildSignedChatTx({ expiration: oldExp });
	const curTx = buildSignedChatTx({ expiration: nowExp });

	// Setup check, so a refusal below is about the SHAPE and not the signature:
	// the current transaction verifies as sent.
	_resetSeenForTest();
	const baseline = await verifyPushedChatOp({ trx: curTx }, lookupKnown);
	if (baseline.ok) ok('setup: an ordinary current transaction verifies');
	else bad('setup: an ordinary current transaction did not verify', JSON.stringify(baseline));

	const cases: [string, unknown][] = [
		[
			'an hour-old message with its expiry wrapped in an array (the replay itself)',
			reshape(oldTx, { expiration: [oldExp] })
		],
		[
			'a current message with its expiry wrapped in an array',
			reshape(curTx, { expiration: [nowExp] })
		],
		['an expiry given as a number', reshape(curTx, { expiration: Date.now() })],
		['no expiry at all', reshape(curTx, { expiration: undefined })],
		['an expiry with a zone suffix', reshape(curTx, { expiration: `${nowExp}Z` })],
		['a reference block number given as a string', reshape(curTx, { ref_block_num: '1234' })],
		['a reference block prefix out of range', reshape(curTx, { ref_block_prefix: 2 ** 32 })],
		['non-empty transaction extensions', reshape(curTx, { extensions: [[0, 'x']] })]
	];
	for (const [label, trx] of cases) {
		_resetSeenForTest();
		let v: Awaited<ReturnType<typeof verifyPushedChatOp>> | null = null;
		let threw: unknown = null;
		try {
			v = await verifyPushedChatOp({ trx }, lookupKnown);
		} catch (err) {
			threw = err;
		}
		if (threw !== null) bad(`${label}: verification THREW`, String(threw));
		else if (v !== null && !v.ok) ok(`${label} is refused (${v.code})`);
		else
			bad(
				`${label} was ACCEPTED`,
				'an expiry the bounds do not read is a message that is replayable forever'
			);
	}

	// Operations that are not [name, body] pairs used to THROW out of the
	// structural check ("op is not iterable") — which the route does not catch,
	// so one such entry turned a whole batch into a 500.
	for (const op of [null, 5, {}, 'custom_json', ['custom_json'], ['custom_json', null]]) {
		let threw: unknown = null;
		let res: ReturnType<typeof structuralCheckChatOp> | null = null;
		try {
			res = structuralCheckChatOp({ ...(curTx as object), operations: [op] });
		} catch (err) {
			threw = err;
		}
		if (threw !== null) bad(`an operation of ${JSON.stringify(op)} THREW`, String(threw));
		else if (res !== null && !res.ok)
			ok(`an operation of ${JSON.stringify(op)} is refused, not thrown`);
		else bad(`an operation of ${JSON.stringify(op)} was accepted`);
	}

	// And through the REAL route: one such entry in a batch costs that entry,
	// never the good message beside it.
	_resetSeenForTest();
	const tags: string[] = [];
	const off = chatEventBus.onFast((ev) => {
		if (ev.clientTag !== null) tags.push(ev.clientTag);
	});
	const intake = federationChatFastRoute(makeDb());
	const goodTag = `good-${Math.random().toString(36).slice(2, 10)}`;
	const r = await intake.app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			trxs: [
				{ ...(curTx as object), operations: [null] },
				buildSignedChatTx({ clientTag: goodTag })
			]
		})
	});
	for (let i = 0; i < 500 && !tags.includes(goodTag); i++) await sleep(2);
	off();
	if (r.status === 202 && tags.includes(goodTag))
		ok('a batch carrying a null operation still answers 202 and delivers the good entry');
	else
		bad(
			`a batch with a null operation answered ${r.status} and delivered ${tags.includes(goodTag) ? 'the good entry' : 'NOTHING'}`,
			'one malformed entry must never cost the unrelated message beside it'
		);

	// The QUEUED form is the rebuilt transaction, not the peer's object: a
	// kilobyte of junk hung off a valid transaction is not carried along.
	const s = structuralCheckChatOp({ ...(curTx as object), junk: 'x'.repeat(1024) });
	const queued = s.ok ? (s as { canonical?: object }).canonical : undefined;
	if (queued !== undefined && !('junk' in queued) && Object.keys(queued).length === 6)
		ok('the transaction that is queued is rebuilt from validated fields only');
	else bad('the queued transaction still carries fields the peer attached');
}

// ── 7. The receiving side's gates are the head tailer's gates ────────
{
	_resetSeenForTest();
	// Blocked recipient → nothing is emitted.
	const blockedState: GateState = { blocked: true, blockThrows: false, replied: true, pushes: [] };
	const v1 = await verifyPushedChatOp({ trx: buildSignedChatTx() }, lookupKnown);
	if (!v1.ok) {
		bad('setup: a valid push failed to verify');
	} else {
		const waiter = nextFastEvent(300);
		const outcome = await deliverVerifiedPush(v1.located, v1.trxId, makeGates(blockedState));
		const ev = await waiter;
		if (outcome === 'blocked' && ev === null)
			ok('a sender the recipient blocked is dropped, and nothing reaches the bus');
		else bad(`a blocked sender produced outcome=${outcome} event=${ev !== null}`);
	}

	// A failing block check must FAIL CLOSED, exactly as the head tailer does.
	_resetSeenForTest();
	const throwState: GateState = { blocked: false, blockThrows: true, replied: true, pushes: [] };
	const v2 = await verifyPushedChatOp({ trx: buildSignedChatTx() }, lookupKnown);
	if (v2.ok) {
		const waiter = nextFastEvent(300);
		const outcome = await deliverVerifiedPush(v2.located, v2.trxId, makeGates(throwState));
		const ev = await waiter;
		if (outcome === 'block_check_failed' && ev === null)
			ok('a block check that errors fails CLOSED — no emit, as on the head-block path');
		else bad(`a failing block check produced outcome=${outcome} event=${ev !== null}`);
	}

	// A stranger with no prior reply: DELIVERED (they may be looking at the
	// chatroom) but NOT pushed (a notification is the spam vector).
	_resetSeenForTest();
	const strangerState: GateState = {
		blocked: false,
		blockThrows: false,
		replied: false,
		pushes: []
	};
	const v3 = await verifyPushedChatOp({ trx: buildSignedChatTx() }, lookupKnown);
	if (v3.ok) {
		const waiter = nextFastEvent(500);
		await deliverVerifiedPush(v3.located, v3.trxId, makeGates(strangerState));
		const ev = await waiter;
		if (ev !== null && strangerState.pushes.length === 0)
			ok('an unestablished sender is DELIVERED to an open chatroom but sends no push');
		else if (ev === null) bad('an unestablished sender was not delivered at all');
		else bad('an unestablished sender fired a push notification — that is the spam door');
		if (ev !== null && ev.replayable === false)
			ok('and it is marked non-replayable, so it cannot enter a later snapshot');
		else if (ev !== null) bad('an ungated message was marked replayable');
	}

	// An established pair: delivered AND pushed.
	_resetSeenForTest();
	const establishedState: GateState = {
		blocked: false,
		blockThrows: false,
		replied: true,
		pushes: []
	};
	const v4 = await verifyPushedChatOp({ trx: buildSignedChatTx() }, lookupKnown);
	if (v4.ok) {
		const waiter = nextFastEvent(500);
		await deliverVerifiedPush(v4.located, v4.trxId, makeGates(establishedState));
		const ev = await waiter;
		if (ev !== null && establishedState.pushes.length === 1)
			ok('an established conversation is delivered AND fires exactly one push');
		else
			bad(
				`established pair: event=${ev !== null} pushes=${establishedState.pushes.length}`,
				'expected one of each'
			);
	}
}

// ── 8. Dead peers are reported, and peers do not queue behind each other ─
//
// An earlier version of this scenario used two peers on the SAME closed port,
// each refused in about a millisecond, and then asserted the pair cost under two
// seconds. That passes whether the fan-out is concurrent or serial — two
// millisecond failures in a row are still fast — so it was not testing
// concurrency at all, and a serialising mutation survived it.
//
// Peers are now DISTINCT (the sender queues per origin, so two references to one
// origin are legitimately one queue) and SLOW ENOUGH for the difference to show.
{
	_resetSeenForTest();
	const PEER_DELAY_MS = 400;

	const slowPeer = (): Promise<{ port: number; close: () => Promise<void> }> => {
		const srv: Server = createServer((req, res) => {
			req.resume();
			req.on('end', () => {
				setTimeout(() => {
					res.writeHead(202, { 'content-type': 'application/json' });
					res.end('{"status":"accepted"}');
				}, PEER_DELAY_MS);
			});
		});
		return new Promise((resolve) =>
			srv.listen(0, '127.0.0.1', () =>
				resolve({
					port: (srv.address() as AddressInfo).port,
					close: async () => {
						srv.closeAllConnections?.();
						await new Promise<void>((r) => srv.close(() => r()));
					}
				})
			)
		);
	};

	const p1 = await slowPeer();
	const p2 = await slowPeer();
	const p3 = await slowPeer();

	const sender = makeSender();
	const started = Date.now();
	sender.enqueue(buildSignedChatTx(), [
		{ origin: `http://127.0.0.1:${p1.port}`, hidden: false },
		{ origin: `http://127.0.0.1:${p2.port}`, hidden: false },
		{ origin: `http://127.0.0.1:${p3.port}`, hidden: false }
	]);
	await sender.drain();
	const elapsed = Date.now() - started;
	const st = sender.stats();

	if (st.delivered === 3 && st.failed === 0) ok('three live peers each took the message');
	else
		bad(`delivered=${st.delivered} failed=${st.failed}`, JSON.stringify(st.failures).slice(0, 200));

	// Serial would be 3 x PEER_DELAY_MS. Concurrent is one of them plus change.
	const serialMs = 3 * PEER_DELAY_MS;
	if (elapsed < serialMs * 0.7)
		ok(
			`three peers cost ${elapsed}ms, not the ${serialMs}ms a serial fan-out would — ` +
				'they are pushed to concurrently'
		);
	else
		bad(
			`three peers took ${elapsed}ms, close to the ${serialMs}ms of a serial fan-out`,
			"sequential fan-out makes the last peer's latency the sum of all of them, and the " +
				'recipient may well be behind that last peer'
		);

	await p1.close();
	await p2.close();
	await p3.close();

	// And a peer that is simply not there is reported, never thrown.
	_resetSeenForTest();
	const deadSender = makeSender(1_000);
	deadSender.enqueue(buildSignedChatTx(), [
		{ origin: 'http://127.0.0.1:1', hidden: false },
		{ origin: 'http://127.0.0.1:2', hidden: false }
	]);
	await deadSender.drain();
	const dead = deadSender.stats();
	if (dead.failed === 2 && dead.delivered === 0)
		ok('unreachable peers are reported as failures, not thrown into the sender');
	else bad(`expected 2 failures, got delivered=${dead.delivered} failed=${dead.failed}`);
}

// ── 9. Only chat ops are dispatched ──────────────────────────────────
{
	if (containsChatOp(buildSignedChatTx())) ok('a chat transaction is recognised for dispatch');
	else bad('a chat transaction was not recognised');
	if (!containsChatOp(buildSignedChatTx({ opId: 'morphit_order_v1' })))
		ok('a non-chat transaction is not dispatched to the federation');
	else bad('a non-chat transaction would be fanned out to every peer');
}

// ── 10. THE INTAKE'S OWN BOUNDS ──────────────────────────────────────
//
// Everything below is cheap to attack and was unbounded. Each of these is
// reachable by anyone who can send this endpoint a request: no key, no valid
// message, no account.
{
	// A signature costs a full elliptic-curve recovery — milliseconds each, in a
	// loop that does not yield. Unbounded, a single request well inside the body
	// cap fits dozens of canonical-but-wrong signatures, every one of which is
	// recovered before the transaction is refused. That is tens of milliseconds
	// of uninterrupted CPU per request, aimed at the event loop that serves the
	// SSE streams this whole mechanism exists to feed.
	const many = buildSignedChatTx() as { signatures: string[] };
	const real = many.signatures[0] ?? '';
	const overloaded = { ...many, signatures: [real, real, real, real] };
	const v = structuralCheckChatOp(overloaded);
	if (!v.ok && v.code === 'malformed')
		ok('a transaction carrying more signatures than a chat op can need is refused');
	else bad('an unbounded signature array reached the recovery loop');

	// And refused STRUCTURALLY — before any cryptography. A cap enforced after
	// the expensive part is not a cap.
	const t0 = Date.now();
	for (let i = 0; i < 50; i++) structuralCheckChatOp(overloaded);
	const perCheck = (Date.now() - t0) / 50;
	if (perCheck < 1) ok(`and refused before any key recovery (${perCheck.toFixed(3)}ms per check)`);
	else
		bad(
			`the structural refusal took ${perCheck.toFixed(2)}ms per check — too slow to be ` +
				'crypto-free, so the cap is being applied after the work it is meant to prevent'
		);

	// A FAR-FUTURE expiry is not a message running early; it is a message that
	// stays replayable for as long as its author chose. Graphene allows an hour,
	// against a ten-minute replay memory — so without this bound an attacker can
	// simply wait the memory out and push a captured message again.
	const far = buildSignedChatTx({
		expiration: new Date(Date.now() + 45 * 60_000).toISOString().slice(0, 19)
	});
	const vf = structuralCheckChatOp(far);
	if (!vf.ok && vf.code === 'expired')
		ok('a transaction whose expiry is far in the future is refused');
	else bad('a transaction could declare an hour-long replay window for itself');

	// A legitimate one — the client signs head + 60s — must still pass, or the
	// bound above is just an outage.
	const okTx = structuralCheckChatOp(buildSignedChatTx());
	if (okTx.ok) ok('and an ordinary client transaction still passes that bound');
	else bad(`a normal chat transaction was refused as ${okTx.code}`);

	// ── THE REPLAY WINDOW IS CLOSED, demonstrated rather than computed ──
	//
	// The two bounds above are each tested on their own, and each passes while
	// saying nothing about the property that actually matters. Replay protection
	// is the dedup memory: a trx id is remembered for SEEN_TTL_MS and a second
	// push of it is refused. That memory is finite, so the real question is
	// whether a captured transaction can OUTLIVE it — wait for the instance to
	// forget, then push again.
	//
	// It cannot, and the reason is the two bounds TOGETHER: a transaction may
	// expire at most MAX_FUTURE_MS ahead, and is refused once it is MAX_AGE_MS
	// past expiry, so the longest it can remain pushable is their sum — which has
	// to be less than how long it is remembered. 3 + 5 = 8 minutes against a
	// 10-minute memory.
	//
	// Nothing enforced that. The bound tests pass identically with SEEN_TTL_MS
	// cut to five minutes, or MAX_FUTURE_MS raised to ten, and either one opens
	// the window silently. The relationship is stated in three separate comments
	// and was implemented by nothing — the same shape as the keep-alive/warm
	// interval pair and the intake queue bound, and this one is security-bearing.
	//
	// Demonstrated by walking the clock, because `now` is injectable: take the
	// most replayable transaction the bounds permit, and show it is already
	// refused by the time the memory would have let go of it.
	{
		const t0 = Date.now();
		// The worst case an attacker can capture: expiry as far ahead as allowed.
		const mostReplayable = buildSignedChatTx({
			expiration: new Date(t0 + MAX_FUTURE_MS).toISOString().slice(0, 19)
		});

		// Accepted now, of course — that is what makes it worth capturing.
		if (structuralCheckChatOp(mostReplayable, new Date(t0)).ok)
			ok('a transaction at the maximum permitted future expiry is accepted when fresh');
		else bad('the most-replayable permitted transaction was refused while fresh');

		// The instant the dedup memory lets go of it, it must ALREADY be too old
		// to push. This is the security property, stated as behaviour.
		const atForget = structuralCheckChatOp(mostReplayable, new Date(t0 + SEEN_TTL_MS));
		if (!atForget.ok && atForget.code === 'expired')
			ok('and by the time the replay memory forgets it, it is already refused as expired');
		else
			bad(
				'a captured transaction is still pushable after the replay memory forgets it',
				`waiting out SEEN_TTL_MS (${SEEN_TTL_MS / 60000} min) and re-pushing would succeed — ` +
					`the bounds permit it to stay valid for ${(MAX_FUTURE_MS + MAX_AGE_MS) / 60000} min`
			);

		// And the margin, so a future edit that narrows it to zero is caught
		// before it becomes a window rather than after. The sum must be strictly
		// less than the memory; equality is not enough, because the two clocks
		// (expiry arithmetic here, wall-clock eviction there) are not the same.
		if (MAX_FUTURE_MS + MAX_AGE_MS < SEEN_TTL_MS)
			ok(
				`the replay window is closed with ${(SEEN_TTL_MS - MAX_FUTURE_MS - MAX_AGE_MS) / 60000} min to spare ` +
					`(${MAX_FUTURE_MS / 60000} + ${MAX_AGE_MS / 60000} < ${SEEN_TTL_MS / 60000})`
			);
		else
			bad(
				'the replay window is OPEN: a captured push outlives the memory of it',
				`MAX_FUTURE_MS + MAX_AGE_MS = ${(MAX_FUTURE_MS + MAX_AGE_MS) / 60000} min is not less than ` +
					`SEEN_TTL_MS = ${SEEN_TTL_MS / 60000} min`
			);
	}
}

// ── 11. THE SENDER NEVER BUILDS A REQUEST A PEER WILL REFUSE ─────────
//
// A batch bounded only by COUNT is not bounded. Sixty-four maximum-length chat
// transactions is a quarter of a megabyte, and an indexer's body cap is a small
// number of kilobytes because nearly every other endpoint is a read. Batches
// form precisely when a peer is already busy — so a fast path that 413s its own
// batches works while idle and switches itself off under exactly the load it
// exists to carry.
{
	let largestBody = 0;
	let requests = 0;
	const srv = createServer((req, res) => {
		let n = 0;
		req.on('data', (c: Buffer) => {
			n += c.length;
		});
		req.on('end', () => {
			requests++;
			if (n > largestBody) largestBody = n;
			res.writeHead(202, { 'content-type': 'application/json' });
			res.end('{"status":"accepted"}');
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
	const port = (srv.address() as AddressInfo).port;
	const peer = [{ origin: `http://127.0.0.1:${port}`, hidden: false }];

	// Big messages: 3 KB of ciphertext each, which is about what a
	// maximum-length chat message weighs on the wire.
	const bulky = (): unknown => {
		const t = buildSignedChatTx() as { operations: [string, { json: string }][] };
		const op = t.operations[0];
		if (op !== undefined) {
			const p = JSON.parse(op[1].json) as Record<string, unknown>;
			p.ciphertext = 'A'.repeat(3000);
			op[1].json = JSON.stringify(p);
		}
		return t;
	};

	const sender = makeSender();
	// Hold the first push open by sending a burst: everything after the first
	// coalesces, which is the only way a batch forms at all.
	for (let i = 0; i < 120; i++) sender.enqueue(bulky(), peer);
	await sender.drain();

	if (largestBody <= BATCH_MAX_BYTES)
		ok(`no push exceeded the byte budget (largest ${largestBody} of ${BATCH_MAX_BYTES} bytes)`);
	else
		bad(
			`a push carried ${largestBody} bytes, over the ${BATCH_MAX_BYTES}-byte budget`,
			'a peer with a matching body cap would 413 it, and the batch would be dropped'
		);

	// And it must still be BATCHING — a byte budget that degenerates into one
	// message per request has fixed the 413 by removing the feature.
	if (requests > 0 && requests < 120)
		ok(`and still batched them: 120 messages in ${requests} requests`);
	else bad(`120 messages took ${requests} requests — the byte budget killed batching`);
	srv.close();
}

// ── 12. A PEER THAT REFUSES THE SIZE STILL GETS THE MESSAGES ─────────
//
// Our budget keeps us under a correctly configured peer's cap, but a peer
// running an older or tighter configuration is entitled to say no. Dropping the
// batch would silently disable the fast path for that pair — the failure this
// whole mechanism is supposed to prevent, arriving through the back door.
{
	let singles = 0;
	let refused = 0;
	const srv = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
				trx?: unknown;
				trxs?: unknown[];
			};
			if (Array.isArray(body.trxs)) {
				refused++;
				res.writeHead(413, { 'content-type': 'application/json' });
				res.end('{"status":"error","code":"payload_too_large"}');
				return;
			}
			singles++;
			res.writeHead(202, { 'content-type': 'application/json' });
			res.end('{"status":"accepted"}');
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
	const port = (srv.address() as AddressInfo).port;
	const peer = [{ origin: `http://127.0.0.1:${port}`, hidden: false }];

	const sender = makeSender();
	for (let i = 0; i < 12; i++) sender.enqueue(buildSignedChatTx(), peer);
	await sender.drain();

	if (refused > 0) ok(`the peer refused ${refused} batch(es) as too large, as configured`);
	else bad('the test peer never saw a batch, so this scenario proves nothing');

	const st = sender.stats();
	if (st.delivered === 12)
		ok(`and all 12 messages still arrived, one at a time (${singles} single pushes)`);
	else
		bad(
			`only ${st.delivered} of 12 arrived after the 413`,
			'a peer with a smaller body cap silently loses the fast path for every pair it serves'
		);
	srv.close();
}

// ── 13. THE SAME TRANSACTION IS NEVER EMITTED TWICE ──────────────────
//
// Two peers can push the same message, and on an instance whose registered site
// origin does not match its indexer origin, local delivery and this instance's
// own federation push are both live for it. The replay memory does not cover
// that: it is written inside verification, and local delivery never goes
// through verification. The ledger is the thing both routes share.
{
	_resetFastEmitLedgerForTest();
	const state: GateState = { blocked: false, blockThrows: false, replied: true, pushes: [] };
	const gates = makeGates(state);
	const trx = buildSignedChatTx();
	const v = await verifyPushedChatOp({ trx }, lookupKnown);
	if (!v.ok) {
		bad(`the fixture did not verify: ${v.code}`);
	} else {
		// Counted through a listener armed BEFORE the call, not by waiting after
		// it: the emit happens synchronously inside deliverVerifiedPush, so a
		// watcher armed afterwards has already missed it and reports the emit as
		// absent — which would make this scenario pass for the wrong reason in
		// the second half while failing in the first.
		const emits: string[] = [];
		const offCount = chatEventBus.onFast((ev) => emits.push(ev.clientTag ?? ''));
		const first = await deliverVerifiedPush(v.located, v.trxId, gates);
		const afterFirst = emits.length;
		const second = await deliverVerifiedPush(v.located, v.trxId, gates);
		const afterSecond = emits.length;
		offCount();
		if (first === 'emitted' && afterFirst === 1) ok('the first delivery emits');
		else bad(`the first delivery did not emit (outcome ${first}, emits ${afterFirst})`);
		if (afterSecond === afterFirst)
			ok('and a second delivery of the same transaction emits nothing');
		else
			bad(
				'the same transaction was emitted twice',
				'every consumer sees it twice — the SSE stream, the replay ring, the push queue'
			);
		if (second === 'emitted') ok('while still reporting success, so no caller retries it');
		else bad(`the second delivery reported ${second}, which a caller may treat as a failure`);
	}

	// ...AND NOT WHEN THE TWO ARRIVE AT ONCE (v1.18.0 review, R8). The ledger
	// check and the ledger mark straddled the notify-gate query, so two routes
	// delivering the same transaction CONCURRENTLY — both in flight during that
	// await — both passed the check. Sequential calls, above, never see it.
	_resetFastEmitLedgerForTest();
	const trx2 = buildSignedChatTx();
	_resetSeenForTest();
	const v2 = await verifyPushedChatOp({ trx: trx2 }, lookupKnown);
	if (!v2.ok) {
		bad(`the second fixture did not verify: ${v2.code}`);
	} else {
		const slowGates: FastDeliveryGates = {
			...makeGates({ blocked: false, blockThrows: false, replied: true, pushes: [] }),
			async fastNotifyAllowed(): Promise<boolean> {
				// Long enough that the other delivery reaches the same point.
				for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
				return true;
			}
		};
		const emits: string[] = [];
		const off = chatEventBus.onFast((ev) => emits.push(ev.clientTag ?? ''));
		await Promise.all([
			deliverVerifiedPush(v2.located, v2.trxId, slowGates),
			deliverVerifiedPush(v2.located, v2.trxId, slowGates)
		]);
		off();
		if (emits.length === 1) ok('two routes delivering the same transaction at once emit it once');
		else
			bad(
				`two concurrent deliveries emitted ${emits.length} times`,
				'the ledger check and its mark straddled an await'
			);
	}
}

// ── 14. THE SENDER'S CLOCK, NOT OURS ─────────────────────────────────
//
// The two delivery routes would otherwise stamp their events from different
// clocks: the head tailer uses the block timestamp, and a receiver's wall clock
// at arrival is a different number. The client sorts a transcript strictly by
// this field, so two consecutive messages arriving by different routes could
// render in the wrong order — and a replayed message stamped "now" always lands
// past the reader's cursor, which is exactly what a replay wants.
{
	_resetSeenForTest();
	// Signed against a head block two minutes old: the client sets expiry to
	// head + 60s, so this transaction's expiry is 60s in the PAST.
	const oldHead = Date.now() - 120_000;
	const trx = buildSignedChatTx({
		expiration: new Date(oldHead + 60_000).toISOString().slice(0, 19)
	});
	const v = await verifyPushedChatOp({ trx }, lookupKnown);
	if (!v.ok) {
		bad(`an older-but-valid transaction was refused as ${v.code}`);
	} else {
		const skewMs = Math.abs(v.sentAt.getTime() - oldHead);
		if (skewMs < 5_000)
			ok(`sentAt is read off the signed transaction (within ${skewMs}ms of the sender's head)`);
		else
			bad(
				`sentAt is ${Math.round(skewMs / 1000)}s from when the sender actually sent it`,
				'stamping arrival time re-dates a replayed message to now and can reorder a transcript'
			);
		if (v.sentAt.getTime() <= Date.now())
			ok('and is never in the future, whatever the transaction claims');
		else bad('a transaction was able to claim it was sent later than it arrived');
	}
}

// ── 15. ONE FAILURE COSTS ONE MESSAGE, NOT THE QUEUE ─────────────────
//
// Verification reads the sender's posting key from the database, so any
// transient failure there — a reset connection, an exhausted pool, a failover —
// rejects. If that unwinds the drain loop, every transaction still queued is
// orphaned with nothing scheduled to come back for it: the fast path goes quiet
// until the next inbound push happens to restart the worker, and meanwhile the
// orphans occupy the bounded queue until it is permanently full and shedding
// everything. A database blip would turn the whole feature off, silently, and
// stay off.
{
	_resetSeenForTest();
	const flaky: FastFederationDb = {
		async query<R extends pg.QueryResultRow>(
			text: string,
			params?: readonly unknown[]
		): Promise<pg.QueryResult<R>> {
			if (text.includes('posting_pubkey')) {
				if (params?.[0] === 'boom') throw new Error('connection terminated unexpectedly');
				return {
					rows: [{ posting_pubkey: senderPub }] as unknown as R[],
					rowCount: 1,
					command: 'SELECT',
					oid: 0,
					fields: []
				} as pg.QueryResult<R>;
			}
			const rows: unknown[] = [];
			if (text.includes('FROM blocks')) rows.push({ exists: false });
			else if (text.includes('FROM chat_messages')) rows.push({ exists: true });
			return {
				rows: rows as R[],
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	};
	const intake = federationChatFastRoute(flaky);
	const tags: string[] = [];
	const off = chatEventBus.onFast((ev) => {
		if (ev.clientTag !== null) tags.push(ev.clientTag);
	});

	// The failing one is SECOND, so a loop that unwinds on it loses the two
	// behind it — which is exactly the shape of the bug and not visible if the
	// failure is last.
	const good = ['g1', 'g2', 'g3'];
	const batch = [
		buildSignedChatTx({ clientTag: good[0] }),
		buildSignedChatTx({ sender: 'boom', clientTag: 'boom-tag' }),
		buildSignedChatTx({ clientTag: good[1] }),
		buildSignedChatTx({ clientTag: good[2] })
	];
	const res = await intake.app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ trxs: batch })
	});
	if (res.status === 202) ok('a batch containing one poisonous entry is still accepted');
	else bad(`the batch was answered ${res.status}`);

	// Give the worker time to drain all four.
	for (let i = 0; i < 40 && tags.length < 3; i++) await sleep(25);
	off();

	const delivered = good.filter((t) => tags.includes(t));
	if (delivered.length === 3) ok('and every healthy message behind the failure is still delivered');
	else
		bad(
			`only ${delivered.length} of 3 healthy messages were delivered after a database error`,
			'the drain loop unwound on the failure and orphaned the rest of the queue'
		);

	if (intake.stats().queueDepth === 0) ok('with nothing left stranded in the verify queue');
	else
		bad(
			`${intake.stats().queueDepth} transactions were left in the queue with no worker`,
			'they will sit there until an unrelated push happens to restart the drain'
		);
}

// ── 16. THE INTAKE ANSWERS BADLY-SHAPED REQUESTS HONESTLY ────────────
{
	const intake = federationChatFastRoute(makeDb());
	const post = async (body: string): Promise<number> => {
		const r = await intake.app.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body
		});
		return r.status;
	};
	// `JSON.parse('null')` succeeds, and reading a property off the result
	// throws — which Hono turns into a 500. A peer with a serialisation bug
	// should hear "your request is wrong", not "this instance is broken"; the
	// second sends them hunting for a fault that is theirs.
	const nullStatus = await post('null');
	if (nullStatus === 400) ok('a JSON body of `null` is answered 400, not 500');
	else bad(`a JSON body of \`null\` was answered ${nullStatus}`);

	const junkStatus = await post('{"trx":{"nope":true}}');
	if (junkStatus === 400) ok('and a batch with nothing usable in it is answered 400');
	else bad(`an all-rubbish batch was answered ${junkStatus}`);

	// AND IT MUST STILL DO SO AFTER THE INSTANCE HAS SHED SOMETHING.
	//
	// The shed counter is a lifetime total for the operator's benefit; the
	// verdict above is about THIS request. Confusing the two means that once an
	// instance has ever been overloaded — once, at any point since it started —
	// it answers 202 to every rubbish batch for the rest of its life, and the
	// peer sending malformed transactions is never told. A busy instance is
	// exactly the one whose peers most need to hear it.
	const flood = federationChatFastRoute(makeDb());
	const postTo = async (body: string): Promise<number> => {
		const r = await flood.app.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body
		});
		return r.status;
	};
	// Fill the verify queue past VERIFY_QUEUE_MAX so that shedding happens. The
	// worker drains it asynchronously, so push in big batches without awaiting
	// anything in between.
	const big = Array.from({ length: BATCH_MAX }, () => buildSignedChatTx());
	const bodies = Array.from({ length: 12 }, () => JSON.stringify({ trxs: big }));
	await Promise.all(bodies.map((b) => postTo(b)));
	if (flood.stats().shed > 0) ok(`the instance has now shed ${flood.stats().shed} messages`);
	else bad('the flood did not shed anything, so the next assertion proves nothing');

	const afterShed = await postTo('{"trx":{"nope":true}}');
	if (afterShed === 400)
		ok('and an all-rubbish batch is STILL answered 400 after the instance has shed');
	else
		bad(
			`after shedding once, an all-rubbish batch was answered ${afterShed}`,
			'the per-request verdict is reading a process-lifetime counter, so a peer with a ' +
				'serialisation bug is told "accepted" forever'
		);
}

// ── 16a. THE FIRST-CONTACT BUDGET IS PER PAIR, NOT PER VICTIM ────────
//
// This is the whole design of fastNotifyBudget, and getting it wrong turns a
// spam control into a denial-of-service aimed at the person it was meant to
// protect. Order permlinks are public, the endpoint is unauthenticated on
// purpose, and a signed chat op costs microseconds to mint — so if the budget
// belonged to the RECIPIENT, one hostile account could empty a seller's
// allowance every minute for free and the next real buyer would get no push, no
// badge and no replay.
{
	_resetFastNotifyBudgetForTest();
	const t0 = 1_700_000_000_000;

	// One sender, twenty through, twenty-first refused.
	let allowed = 0;
	for (let i = 0; i < 20; i++) if (spendFastNotifyBudget('mallory', 'vera', t0)) allowed++;
	if (allowed === 20) ok('a sender gets a full allowance to one recipient');
	else bad(`only ${allowed} of the first 20 were allowed`);

	if (!spendFastNotifyBudget('mallory', 'vera', t0))
		ok('and is refused past it, so the fast path is not an unmetered channel');
	else bad('the allowance did not bind at all');

	// THE ASSERTION THAT MATTERS. A different sender must arrive with a full
	// allowance at the SAME recipient.
	if (spendFastNotifyBudget('bob', 'vera', t0))
		ok('a DIFFERENT sender still reaches the same recipient — the flood is not contagious');
	else
		bad(
			'a real buyer was refused because someone else had flooded that seller',
			'the budget is keyed on the recipient, which makes it a denial-of-service ' +
				'against the victim rather than a cap on the attacker'
		);

	// And the same sender still reaches a different recipient.
	if (spendFastNotifyBudget('mallory', 'wendy', t0))
		ok('and a flooded sender still reaches a different recipient');
	else bad('the budget is leaking across recipients');

	// The window slides: one window later the pair is clear again.
	if (spendFastNotifyBudget('mallory', 'vera', t0 + 60_001))
		ok('the window slides, so a refused pair recovers on its own');
	else bad('a refused pair never recovers — the window is not sliding');

	// A REFUSED attempt must not extend the window. Fill it, hammer it through
	// the whole window, then check it opens exactly when it should.
	_resetFastNotifyBudgetForTest();
	for (let i = 0; i < 20; i++) spendFastNotifyBudget('mallory', 'vera', t0);
	// Once per second, not once per five: at five-second steps only eleven
	// refusals land inside the window, which is under the cap — so the pair would
	// open again even if refusals WERE being recorded, and the assertion below
	// would hold for the wrong reason. Sixty attempts is a real flood.
	for (let t = t0 + 1; t < t0 + 60_000; t += 1_000) spendFastNotifyBudget('mallory', 'vera', t);
	if (spendFastNotifyBudget('mallory', 'vera', t0 + 60_001))
		ok('and a flood of refusals does not hold the window open');
	else
		bad(
			'sustained refusals kept the window from draining',
			'an attacker could then hold a pair closed indefinitely at no cost'
		);

	// Bounded, like everything else attacker-facing here.
	_resetFastNotifyBudgetForTest();
	for (let i = 0; i < 25_000; i++) spendFastNotifyBudget(`spam${i}`, 'vera', t0);
	const size = fastNotifyBudgetSize();
	if (size <= 20_000) ok(`the budget table holds at its bound (${size} pairs)`);
	else bad(`the budget table grew to ${size}`);
}

// ── 16a-ii. THE GATE PASSES THE RIGHT TWO NAMES ──────────────────────
//
// The scenarios above drive fastNotifyBudget directly, which pins the module's
// own behaviour and NOTHING about how it is called — and the call site is
// exactly where this went wrong the first time: the budget was spent against
// `located.recipient` twice, making it the victim's allowance rather than the
// sender's. A module that keys on the pair, called with the same name twice, is
// a per-victim budget with extra steps. So this runs the REAL gate.
{
	_resetFastNotifyBudgetForTest();
	const db: FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
			const rows: unknown[] = [];
			if (text.includes('FROM blocks')) rows.push({ exists: false });
			// Never replied: every message here is a first contact.
			else if (text.includes('FROM chat_messages')) rows.push({ exists: false });
			// The recipient's own live order — the one thing that lets a stranger
			// through the gate at all.
			else if (text.toLowerCase().includes('orders')) rows.push({ account: RECIPIENT, live: true });
			return {
				rows: rows as R[],
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	};
	const gate = gatesFromDb(db, { meterFirstContact: true });
	const asFrom = (signer: string): LocatedChatOp =>
		({
			signer,
			recipient: RECIPIENT,
			ciphertext: 'x',
			header: { client_tag: 't' },
			clientTag: 't',
			orderPermlink: 'an-order-of-theirs'
		}) as unknown as LocatedChatOp;

	let through = 0;
	for (let i = 0; i < 20; i++)
		if (await gate.fastNotifyAllowed(asFrom('mallory'), new Date())) through++;
	if (through === 20) ok('the real gate lets a stranger through their full allowance');
	else bad(`the gate allowed only ${through} of 20 first-contact messages`);

	if (!(await gate.fastNotifyAllowed(asFrom('mallory'), new Date()))) ok('and meters them past it');
	else bad('the gate did not meter a flooding stranger at all');

	if (await gate.fastNotifyAllowed(asFrom('bob'), new Date()))
		ok('while a DIFFERENT stranger still gets through to the same person');
	else
		bad(
			'a second stranger was refused because the first had flooded',
			'the gate is spending the RECIPIENT allowance, so anyone can deny anyone ' +
				'— the control becomes an attack on the person it protects'
		);
}

// ── 16b. A PEER THAT REFUSES A BATCH IS NAMED, NOT JUST SURVIVED ─────
//
// The split-and-retry keeps the messages flowing, which is what matters to the
// two people talking — and is exactly why it can hide the condition from the
// operator. If every single then succeeds, deliveries look healthy while that
// peer is quietly turning each batch into up to sixty-four sequential round
// trips. "failed: 3" is not a diagnosis; neither is silence.
{
	const srv = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { trxs?: unknown[] };
			if (Array.isArray(body.trxs)) {
				res.writeHead(413, { 'content-type': 'application/json' });
				res.end('{"status":"error"}');
				return;
			}
			res.writeHead(202, { 'content-type': 'application/json' });
			res.end('{"status":"accepted"}');
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
	const port = (srv.address() as AddressInfo).port;
	const sender = makeSender();
	for (let i = 0; i < 10; i++)
		sender.enqueue(buildSignedChatTx(), [{ origin: `http://127.0.0.1:${port}`, hidden: false }]);
	await sender.drain();

	const st = sender.stats();
	if (st.delivered === 10) ok('every message still arrives past a batch-refusing peer');
	else bad(`only ${st.delivered} of 10 arrived`);

	const named = st.failures.some((f) => f.status === 413);
	if (named) ok('and the 413 is recorded, so an operator can see which peer is refusing batches');
	else
		bad(
			'a peer refusing every batch left no trace at all',
			'deliveries look healthy while that peer costs one round trip per message'
		);
	srv.close();
}

// ── 16c. A ROTATED POSTING KEY ───────────────────────────────────────
//
// `accounts.posting_pubkey` is written once and never updated — the durable
// upsert COALESCEs it and the backfill only fills NULLs — because until this
// release nothing depended on it being current. This path does: it is the only
// thing between a pushed transaction and a message rendered as authentically
// from that account. Frozen, a STOLEN key keeps working after its owner has
// rotated it away on chain (which the chain itself would refuse), and the
// owner's own messages stop verifying, silently, forever.
//
// This whole path — the refresh, its cooldown, its ceiling, and the deliberate
// decision NOT to persist the answer — had no test at all until now.
{
	_resetSeenForTest();
	_resetKeyRefreshForTest();

	// The database holds an OLD key. The chain has a new one.
	const rotatedKey = PrivateKey.fromSeed('morphit-rotated-key');
	const rotatedPub = rotatedKey.createPublic().toString();
	const staleDb: FastFederationDb = {
		async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
			const rows: unknown[] = text.includes('posting_pubkey')
				? [{ posting_pubkey: senderPub }]
				: [];
			return {
				rows: rows as R[],
				rowCount: rows.length,
				command: 'SELECT',
				oid: 0,
				fields: []
			} as pg.QueryResult<R>;
		}
	};
	let chainReads = 0;
	const refresher = async (): Promise<string | null> => {
		chainReads++;
		return rotatedPub;
	};
	const lookup = postingKeyLookupFromDb(staleDb, refresher);

	// A message signed with the NEW key. Against the stale column it cannot
	// verify; the refresh is what rescues it.
	const rotatedTx = buildSignedChatTx({ signWith: rotatedKey });
	const v = await verifyPushedChatOp({ trx: rotatedTx }, lookup);
	if (v.ok) ok('a message signed with a ROTATED key verifies after one chain re-read');
	else
		bad(
			`a rotated key was refused as ${v.code}`,
			"the owner's own messages stop verifying the moment they rotate, silently and " +
				'for as long as the stale column survives — which is forever'
		);
	if (chainReads === 1) ok('and the chain was asked exactly once');
	else bad(`the chain was asked ${chainReads} times for one message`);

	// THE CORRECTION IS NOT WRITTEN BACK — that is the invariant this module
	// exists under, and the reason it is held in memory. The stub above answers
	// every SELECT with the STALE key, so if the next message verifies it can
	// only be because the correction was remembered in memory.
	_resetSeenForTest();
	const second = await verifyPushedChatOp(
		{ trx: buildSignedChatTx({ signWith: rotatedKey }) },
		lookup
	);
	if (second.ok) ok('and the correction is remembered, so the next message costs no chain read');
	else bad(`the second message from a rotated account was refused as ${second.code}`);
	if (chainReads === 1) ok('— still exactly one chain read, from the in-memory correction');
	else bad(`the chain was asked ${chainReads} times across two messages`);

	// THE COOLDOWN. A failing signature is free to produce and an RPC call is
	// not, so an attacker naming accounts with junk signatures must not be able
	// to turn this into a reflected load amplifier.
	_resetSeenForTest();
	_resetKeyRefreshForTest();
	let attackReads = 0;
	const countingLookup = postingKeyLookupFromDb(staleDb, async () => {
		attackReads++;
		return null; // the chain says nothing useful
	});
	for (let i = 0; i < 8; i++) {
		_resetSeenForTest();
		await verifyPushedChatOp(
			{ trx: buildSignedChatTx({ signWith: rotatedKey, clientTag: `atk-${i}` }) },
			countingLookup
		);
	}
	if (attackReads <= 2)
		ok(`eight bad signatures for one account cost ${attackReads} chain read(s), not eight`);
	else
		bad(
			`eight bad signatures for one account cost ${attackReads} chain reads`,
			'a failing signature is free to produce, so this is a reflected amplifier ' +
				'pointed at whichever node this instance is using'
		);
}

// ── 18. THE TRANSPORTS, AND WHAT CHAT FAN-OUT MAY USE ────────────────
//
// Chat fan-out uses Tor only, one isolated circuit per push: an onion
// inside Tor, a clearnet https origin through a Tor exit. I2P and Lokinet
// cannot isolate one request from the next, so a push over them could be tied
// to the instance's other pushes; they are not used for fan-out. Their
// transports are still used — by the login-pairing forward — and the I2P one
// is exercised directly below, as is what fan-out does when Tor is unusable.
{
	_resetSeenForTest();
	await closePool();

	// ── an I2P destination, reached the way i2pd actually presents one ──
	//
	// IT IS A TUNNEL, NOT A FORWARD. The I2P connector issues an HTTP
	// CONNECT to the proxy and speaks HTTP down the tunnel it gets back — even
	// for a plain `http://` target, where absolute-URI forwarding would also
	// have been legal. The first draft of this scenario assumed the forwarding
	// shape, so the proxy's request handler never fired and the scenario failed
	// while the code was fine. Both real proxies accept it: i2pd parses
	// `CONNECT host:port` with no port whitelist (libi2pd_client/HTTPProxy.cpp),
	// and the Java router has supported CONNECT since 0.9.11 — though an
	// operator there CAN disable it with `allowInternalSSL=false`, which is why
	// OPERATIONS names that setting.
	//
	// So the stub below is a real CONNECT proxy splicing to a real origin —
	// the same shape ops/test/lib/hidden-proxy-stubs.mjs already uses. Nothing
	// on this machine could otherwise answer for a `.b32.i2p` hostname: there is
	// no DNS entry and no listener, so a request arriving at the origin is proof
	// the CONNECT branch carried it.
	let i2pRequests = 0;
	let i2pConnectTarget = '';
	/** How many TUNNELS the I2P proxy was asked to open. On a real router each
	 *  one is a tunnel pair to build, which is the cost the pool exists to pay
	 *  once. */
	let i2pConnects = 0;
	const i2pOrigin: Server = createServer((req, res) => {
		i2pRequests++;
		req.resume();
		req.on('end', () => {
			res.writeHead(202, { 'content-type': 'application/json' });
			res.end('{"status":"accepted"}');
		});
	});
	await new Promise<void>((r) => i2pOrigin.listen(0, '127.0.0.1', r));
	const i2pOriginPort = (i2pOrigin.address() as AddressInfo).port;

	const i2pProxy: Server = createServer((_req, res) => {
		// An ordinary request reaching the proxy means undici stopped tunnelling.
		res.writeHead(400).end('{}');
	});
	i2pProxy.on('connect', (req, clientSocket, head: Buffer) => {
		i2pConnectTarget = req.url ?? '';
		i2pConnects++;
		const upstream = createConnection({ host: '127.0.0.1', port: i2pOriginPort }, () => {
			clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head?.length) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		upstream.on('error', () => clientSocket.destroy());
		clientSocket.on('error', () => upstream.destroy());
	});
	await new Promise<void>((r) => i2pProxy.listen(0, '127.0.0.1', r));
	const i2pPort = (i2pProxy.address() as AddressInfo).port;

	const I2P_HOST = `${'b'.repeat(52)}.b32.i2p`;
	const i2pProxies = { torSocks: '', i2pHttpProxy: `127.0.0.1:${i2pPort}` };
	// The pairing forward's I2P transport, driven directly.
	const i2pPush = await postJsonViaHiddenService(
		`http://${I2P_HOST}/v1/federation/chat-fast`,
		{ trx: buildSignedChatTx() },
		i2pProxies,
		20_000
	).catch((e: unknown) => ({ status: 0, body: String(e) }));

	if (i2pPush.status === 202 && i2pRequests === 1)
		ok('a .b32.i2p peer is reached through our CONNECT connector and a real I2P HTTP proxy');
	else
		bad(
			`the I2P branch did not route: status=${i2pPush.status} proxyRequests=${i2pRequests}`,
			'this is the transport the pairing forward uses on I2P'
		);

	// Asserting the CONNECT target means the scenario cannot pass by accident if
	// the dispatcher ever stops proxying and simply dials the host: nothing
	// resolves `.b32.i2p`, so that would fail — but it would fail for the wrong
	// reason, and this says which.
	if (i2pConnectTarget === `${I2P_HOST}:80`)
		ok(`and it was tunnelled with CONNECT ${I2P_HOST}:80, as i2pd's proxy expects`);
	else bad(`the proxy was asked to CONNECT to "${i2pConnectTarget}", not ${I2P_HOST}:80`);

	// ── the I2P tunnel is POOLED, not rebuilt per message ───────────────
	//
	// This is the scenario that was missing when the I2P leg was carried by
	// undici's `ProxyAgent`, and it matters more now that the leg goes through a
	// connector of ours: a hand-written connector sits UNDERNEATH undici's
	// pooling, so getting it wrong does not break delivery — every message still
	// arrives — it just silently pays a fresh tunnel each time. On loopback that
	// is invisible. On a real I2P router it is a tunnel-pair build per message,
	// which does not so much miss the six-second target as ignore it, and the
	// single-push scenario above would stay green throughout.
	//
	// Sequential first: `CONNECTIONS_PER_ORIGIN = 1` means the same socket is
	// reused, so six further messages must open NO further tunnels.
	{
		const before = i2pConnects;
		const url = `http://${I2P_HOST}/v1/federation/chat-fast`;
		for (let i = 0; i < 6; i++) {
			await postJsonViaHiddenService(url, { trx: buildSignedChatTx() }, i2pProxies, 20_000).catch(
				() => undefined
			);
		}
		const extra = i2pConnects - before;
		if (extra === 0) ok('six further messages to one .b32.i2p reuse the established tunnel');
		else
			bad(
				`six sequential messages to one .b32.i2p opened ${extra} further tunnel(s)`,
				'a reused tunnel should cost a round trip; rebuilding one per message is the ' +
					'cost the connection pool exists to pay exactly once'
			);
	}

	// ...and CONCURRENTLY, which is the claim the sequential loop cannot make:
	// a serial loop reuses one connection at ANY pool size, so the constant
	// could be raised to four and nothing above would notice.
	{
		const before = i2pConnects;
		const url = `http://${I2P_HOST}/v1/federation/chat-fast`;
		await Promise.all(
			Array.from({ length: 4 }, () =>
				postJsonViaHiddenService(url, { trx: buildSignedChatTx() }, i2pProxies, 20_000).catch(
					() => undefined
				)
			)
		);
		const extra = i2pConnects - before;
		if (extra === 0) ok('four CONCURRENT pushes to one .b32.i2p share the single pooled tunnel');
		else
			bad(
				`four concurrent pushes to one .b32.i2p opened ${extra} extra tunnel(s)`,
				'each is a fresh I2P tunnel pair — the same cost CONNECTIONS_PER_ORIGIN = 1 ' +
					'refuses to pay on Tor, and it was never asserted on this transport'
			);
	}

	// ── fan-out when this box's Tor is unusable ─────────────────────────
	//
	// Tor is configured but nothing is listening — the shape of a box whose
	// daemon is not installed, since the shipped default (`127.0.0.1:9050`) is
	// non-empty whether or not anything is behind it. Both of the peer's
	// fan-out addresses — its onion and its https origin through an exit — need
	// Tor, so the push fails locally, at once, and the message goes by chain.
	// What must NOT happen is a direct clearnet connection: that is what told a
	// peer which instance a user is on.
	_resetSeenForTest();
	const DEAD_TOR = { torSocks: '127.0.0.1:1', i2pHttpProxy: '127.0.0.1:1' };
	const deadTorSender = new PeerSender({ proxies: DEAD_TOR, timeoutMs: 5_000 });
	const deadTorPeer = fanOutPeerFromRow(
		{ origin: 'https://peer.example', reg_alt_networks: { tor: `${'c'.repeat(56)}.onion` } },
		DEAD_TOR
	);
	if (
		deadTorPeer !== null &&
		deadTorPeer.origin === `http://${'c'.repeat(56)}.onion` &&
		(deadTorPeer.alternates ?? []).map((a) => a.origin).join(',') === 'https://peer.example'
	)
		ok('a peer is addressed by its onion, then its https origin — both over Tor');
	else bad(`unexpected fan-out addresses: ${JSON.stringify(deadTorPeer)}`);

	const deadStart = Date.now();
	if (deadTorPeer !== null) deadTorSender.enqueue(buildSignedChatTx(), [deadTorPeer]);
	await deadTorSender.drain();
	const deadMs = Date.now() - deadStart;
	const deadStats = deadTorSender.stats();
	if (deadStats.delivered === 0 && deadStats.failed === 1 && deadMs < 1_000)
		ok(`a dead Tor fails the push locally in ${deadMs}ms — nothing is sent around it`);
	else
		bad(
			`dead Tor: delivered=${deadStats.delivered} failed=${deadStats.failed} in ${deadMs}ms`,
			'a refused local proxy is immediate; delivery without Tor would mean a non-Tor road'
		);
	if (deadStats.failures.every((f) => f.localFault === true) && deadStats.failures.length > 0)
		ok('and every recorded failure is attributed to this instance, not the peer');
	else bad(`failures: ${JSON.stringify(deadStats.failures).slice(0, 200)}`);
	if (deadTorSender.reachability.isDown('tor'))
		ok('the instance records that its Tor is down, so a failure count is a diagnosis');
	else bad('a local Tor outage left no record an operator could read');

	// ── a zero-clearnet peer that also publishes I2P ────────────────────
	//
	// Fan-out does not fall back to I2P when Tor is down: the I2P proxy would put
	// every push on one client tunnel, and the peer could link them.
	const i2pBefore = i2pRequests;
	const bothNetworks = fanOutPeerFromRow(
		{
			origin: `http://${'d'.repeat(56)}.onion`,
			reg_alt_networks: { tor: `${'d'.repeat(56)}.onion`, i2p_b32: I2P_HOST }
		},
		{ torSocks: '127.0.0.1:1', i2pHttpProxy: `127.0.0.1:${i2pPort}` }
	);
	const zeroSender = new PeerSender({
		proxies: { torSocks: '127.0.0.1:1', i2pHttpProxy: `127.0.0.1:${i2pPort}` },
		timeoutMs: 5_000
	});
	if (bothNetworks !== null) zeroSender.enqueue(buildSignedChatTx(), [bothNetworks]);
	await zeroSender.drain();
	if (
		bothNetworks !== null &&
		[bothNetworks.origin, ...(bothNetworks.alternates ?? []).map((a) => a.origin)].every((o) =>
			o.endsWith('.onion')
		) &&
		i2pRequests === i2pBefore
	)
		ok('a zero-clearnet peer is pushed to over its onion only — never over I2P');
	else
		bad(
			`I2P was used for fan-out: requests ${i2pRequests - i2pBefore}, peer ${JSON.stringify(bothNetworks)}`
		);

	// ...and a node with no Tor at all has no fan-out address for anyone.
	if (
		fanOutPeerFromRow(
			{
				origin: 'https://peer.example',
				reg_alt_networks: { tor: `${'c'.repeat(56)}.onion`, i2p_b32: I2P_HOST }
			},
			{ torSocks: '', i2pHttpProxy: `127.0.0.1:${i2pPort}` }
		) === null
	)
		ok('without Tor there is no fan-out address — its users get chain-speed delivery instead');
	else bad('a node without Tor was given a fan-out address');

	// ── a peer that ANSWERED is not dialled again somewhere else ────────
	//
	// The counterweight to everything above, and the reason the failover is safe
	// to have at all. A peer that returned a status has been REACHED; dialling
	// its other address would not be a retry, it would be a second delivery of
	// the same batch to the same instance by a different road — and the peer has
	// no way to tell those apart. Failover is for faults that happened on THIS
	// machine, and for nothing else.
	_resetSeenForTest();
	let refusingHits = 0;
	const refusingPeer: Server = createServer((req, res) => {
		refusingHits++;
		req.resume();
		req.on('end', () => {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end('{"status":"error"}');
		});
	});
	await new Promise<void>((r) => refusingPeer.listen(0, '127.0.0.1', r));
	const refusingPort = (refusingPeer.address() as AddressInfo).port;

	let altHits = 0;
	const altPeer: Server = createServer((req, res) => {
		altHits++;
		req.resume();
		req.on('end', () => {
			res.writeHead(202, { 'content-type': 'application/json' });
			res.end('{"status":"accepted"}');
		});
	});
	await new Promise<void>((r) => altPeer.listen(0, '127.0.0.1', r));
	const altPort = (altPeer.address() as AddressInfo).port;

	const refuseSender = makeSender();
	refuseSender.enqueue(buildSignedChatTx(), [
		{
			origin: `http://127.0.0.1:${refusingPort}`,
			hidden: false,
			key: 'https://refusing.example',
			alternates: [{ origin: `http://127.0.0.1:${altPort}`, hidden: false }]
		}
	]);
	await refuseSender.drain();

	if (refusingHits === 1 && altHits === 0)
		ok('a peer that answered badly is NOT dialled again at its other address');
	else
		bad(
			`the batch was delivered twice by two roads: refused=${refusingHits} alternate=${altHits}`,
			'the peer cannot tell a failover from a duplicate, so this is a second delivery of ' +
				'the same messages rather than a retry of a failed one'
		);
	if (refuseSender.stats().failed === 1 && refuseSender.stats().delivered === 0)
		ok('and it is recorded as the failure it is');
	else
		bad(
			`delivered=${refuseSender.stats().delivered} failed=${refuseSender.stats().failed}`,
			'a peer refusing every message must not read as healthy'
		);

	// ── a peer whose ONLY address is on a down network ──────────────────
	//
	// The breaker must never be able to silence a peer. If every candidate is on
	// a network we have set aside, the push is ATTEMPTED anyway — both because
	// the cooldown may be stale and because that attempt is the only way a
	// recovery is ever noticed. The failure mode being guarded against is worse
	// than a wasted round trip: with no candidate left, the send loop falls
	// straight through and reports the batch DELIVERED, which is a silence that
	// nothing downstream can question.
	// The assertion is that the peer was DIALLED, not merely that the push was
	// recorded as failing. Those come apart exactly here: a candidate list that
	// filtered the peer out entirely also produces "one failure, nothing
	// delivered" — because the guard in sendBatchToPeer refuses to call an empty
	// list a success — and that guard, while correct, would hide the difference
	// between a peer that was tried and a peer that was abandoned. Only an
	// attempt can notice a recovery, so only an attempt will do.
	_resetSeenForTest();
	let strandedAttempts = 0;
	const strandedSender = new PeerSender({
		proxies: { torSocks: '127.0.0.1:1', i2pHttpProxy: '' },
		timeoutMs: 1_000,
		postIsolated: async () => {
			strandedAttempts++;
			throw new ProxyUnavailableError('Tor SOCKS proxy unreachable');
		}
	});
	strandedSender.reachability.markDown('tor');
	strandedSender.enqueue(buildSignedChatTx(), [
		{ origin: `http://${'e'.repeat(56)}.onion`, hidden: true, key: 'https://stranded.example' }
	]);
	await strandedSender.drain();

	const stranded = strandedSender.stats();
	if (strandedAttempts === 1 && stranded.delivered === 0 && stranded.failed === 1)
		ok('a peer whose only network is down is still attempted, and its failure reported');
	else
		bad(
			`a peer whose only network is down was mishandled: attempts=${strandedAttempts} ` +
				`delivered=${stranded.delivered} failed=${stranded.failed}`,
			stranded.delivered > 0
				? 'a message nobody was sent was counted as delivered — the worst shape this bug ' +
						'can take, because a silence that reports success cannot be questioned'
				: 'the peer was never dialled, so its network could never be found working again ' +
						'and the cooldown would renew itself off its own failures forever'
		);

	// ── the proxy that answers CONNECT and refuses it ───────────────────
	//
	// The Java router's `i2ptunnel.httpclient.allowInternalSSL=false` refuses
	// CONNECT to in-network destinations outright. The proxy is up and answers —
	// it just will not open the tunnel — so the transport must report OUR fault
	// (not the peer refusing), and an AMBIGUOUS one: a router refusing by policy
	// refuses every destination, one that cannot reach a destination refuses
	// that one. Driven on the pairing forward's I2P transport.
	_resetSeenForTest();
	const refuseProxy: Server = createServer((_req, res) => res.writeHead(400).end());
	refuseProxy.on('connect', (_req, socket) => {
		socket.write('HTTP/1.1 403 Refused\r\ncontent-length: 0\r\n\r\n');
		socket.end();
	});
	await new Promise<void>((r) => refuseProxy.listen(0, '127.0.0.1', r));
	const refusePort = (refuseProxy.address() as AddressInfo).port;
	const refusedErr = await postJsonViaHiddenService(
		`http://${'c'.repeat(52)}.b32.i2p/v1/federation/chat-fast`,
		{ trx: buildSignedChatTx() },
		{ torSocks: '', i2pHttpProxy: `127.0.0.1:${refusePort}` },
		4_000
	).then(
		() => null,
		(e: unknown) => e
	);
	if (isProxyUnavailable(refusedErr))
		ok('a router that refuses CONNECT is reported as OUR fault, not the peer refusing');
	else bad(`a refused CONNECT surfaced as ${String(refusedErr)}`);
	if (localFaultConfidence(refusedErr, 'i2p') === 'ambiguous')
		ok('...and as an ambiguous one, so one refusal cannot convict the network');
	else bad(`a refused CONNECT was classified ${localFaultConfidence(refusedErr, 'i2p')}`);
	refuseProxy.closeAllConnections?.();
	await new Promise<void>((r) => refuseProxy.close(() => r()));

	// Tor's local-fault evidence names our own proxy, so one fault is enough.
	_resetSeenForTest();
	const torOneShot = new PeerSender({
		proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '127.0.0.1:4444' },
		timeoutMs: 1_000,
		postIsolated: async () => {
			throw new ProxyUnavailableError('SOCKS proxy 127.0.0.1:9050 unreachable');
		}
	});
	torOneShot.enqueue(buildSignedChatTx(), [
		{
			origin: `http://${'f'.repeat(56)}.onion`,
			hidden: true,
			key: 'https://onepeer.example',
			alternates: [{ origin: 'https://onepeer.example', hidden: false }]
		}
	]);
	await torOneShot.drain();

	if (torOneShot.reachability.isDown('tor'))
		ok('one Tor local fault is still conclusive on its own');
	else
		bad(
			'a single Tor local fault no longer marks Tor down',
			'the SOCKS connector raises that marker only for our OWN proxy, so waiting ' +
				'for a second one costs every onion peer a refused dial for nothing'
		);

	refusingPeer.closeAllConnections?.();
	await new Promise<void>((r) => refusingPeer.close(() => r()));
	altPeer.closeAllConnections?.();
	await new Promise<void>((r) => altPeer.close(() => r()));
	i2pProxy.closeAllConnections?.();
	await new Promise<void>((r) => i2pProxy.close(() => r()));
	i2pOrigin.closeAllConnections?.();
	await new Promise<void>((r) => i2pOrigin.close(() => r()));
	await closePool();
}

// ── 17. NOTHING ESCAPED ──────────────────────────────────────────────
//
// A rejection with nobody watching does not stop this process (see the handler
// at the top, which mirrors the indexer's own), but it does mean some piece of
// work stopped where it was. On this path that is a batch of chat messages
// nobody will come back for.
if (unhandled === 0) ok('no promise rejection escaped during the run');
else
	bad(
		`${unhandled} promise rejection(s) escaped`,
		'in the indexer these are logged and swallowed, so whatever work was behind ' +
			'them is abandoned with no error anyone sees'
	);

console.log('');
console.log('─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} federation-chat-fast scenarios passed`);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
