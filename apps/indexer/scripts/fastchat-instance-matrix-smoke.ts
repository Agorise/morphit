#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/fastchat-instance-matrix-smoke.ts
 *
 * EVERY KIND OF INSTANCE, BOTH DIRECTIONS, AND THE INBOX — under six seconds.
 *
 * The maintainer's bar, in his words: "regardless of which, or which kind of instance you
 * are on, legit chats need to be under 6 seconds, sending and receiving. The
 * initial notification of a new chatroom request (and its appearance in your
 * inbox) from a potential buyer or seller too."
 *
 * That is three claims the earlier smokes did not make.
 *
 *   1. EVERY COMBINATION. clearnet↔clearnet, clearnet↔hidden, hidden↔hidden —
 *      and the combination that turns out to be the ordinary one, BOTH PEOPLE ON
 *      THE SAME INSTANCE. That last case had no fast path at all: the peer
 *      directory excludes self, so a local recipient waited for the head tailer
 *      to read the message back off the chain. A block interval, a poll
 *      interval and an RPC read — up to 6.8 seconds on a privacy-only instance,
 *      for two people on the same server.
 *
 *   2. THE INBOX, not just an open chatroom. A first contact is by definition a
 *      conversation the recipient does not have open. What has to arrive is the
 *      inbox ping — the one that lights the badge and lets the inbox draw a card
 *      for a thread the durable table will not know about for another minute.
 *      This drives the REAL `chatActivityStreamRoute` and measures the ping.
 *
 *   3. BOTH DIRECTIONS. The buyer's opening message worked already, because it
 *      answers the recipient's own live order. The seller's REPLY did not: the
 *      order belongs to the seller rather than to the recipient, and "has this
 *      buyer written to me before?" is read from a durable table that is 45-63
 *      seconds behind the buyer's own opening message. Measured before the fix:
 *      the gate returned false, so the person who started the conversation was
 *      told nothing until the chain caught up.
 *
 * WHAT IS REAL: the broadcast route, the federation endpoint, the activity
 * stream, the gates, a real Blurt keypair and a real signature, real sockets.
 * WHAT IS MODELLED: per-hop latency, and the Blurt node's acknowledgement.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import {
	createConnection,
	createServer as createNetServer,
	type Server as NetServer
} from 'node:net';
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';
import type pg from 'pg';

import { broadcastRoute } from '../src/api/broadcast';
import { chatEventBus } from '../src/indexer/chatEventBus';
import { federationChatFastRoute, gatesFromDb } from '../src/api/federationChatFast';
import { chatActivityStreamRoute } from '../src/api/chatActivityStream';
import { ChatFastDispatcher } from '../src/indexer/chatFastDispatcher';
import {
	deliverVerifiedPush,
	_resetSeenForTest,
	type FastFederationDb
} from '../src/indexer/chatFastFederation';
import { _resetOutboundChatForTest } from '../src/indexer/recentOutboundChat';
import { _resetFastEmitLedgerForTest } from '../src/indexer/fastEmitLedger';
import { _resetFastNotifyBudgetForTest } from '../src/indexer/fastNotifyBudget';
import type { LocatedChatOp } from '../src/indexer/headTailer';
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

/** The line the maintainer drew. */
const TARGET_MS = 6_000;
/**
 * A hop to or between PRIVACY instances. Pessimistic on purpose.
 *
 * "Privacy instance" is not one network. Morphit runs over three, and they do
 * not perform alike: a warm Tor circuit is roughly a second, a warm I2P tunnel
 * pair is usually slower and more variable because both ends build their own
 * inbound and outbound tunnels, and Lokinet is typically the quickest of the
 * three. One number cannot describe all of that, so this is the DEFAULT and
 * `HIDDEN_BANDS` below walks the range.
 */
const HIDDEN_RTT_MS = Number(process.env.MORPHIT_FASTCHAT_HIDDEN_RTT_MS ?? '') || 900;
/** A hop to or between CLEARNET instances. An ordinary internet round trip. */
const CLEARNET_RTT_MS = 120;
/** How long the Blurt node takes to accept a transaction (not to block it). */
const CHAIN_ACK_MS = 400;

/**
 * The hidden-transport round trips the worst case is walked across.
 *
 * The maintainer's requirement is sub-six-seconds "across instances of all types across
 * multiple kinds of networks", and a matrix pinned to a single Tor-shaped
 * number does not answer that — it answers it for Tor and asserts the rest by
 * resemblance. These are run as real cases so the answer is measured.
 *
 * The figures are deliberately not presented as measurements of the live
 * networks, which nothing in this tree is in a position to measure. They are a
 * range chosen to bracket what those networks plausibly do, from a fast
 * Lokinet hop to an I2P tunnel pair having a bad day.
 */
const HIDDEN_BANDS: readonly { readonly label: string; readonly rttMs: number }[] = [
	{ label: 'lokinet-fast', rttMs: 350 },
	{ label: 'tor-typical', rttMs: 900 },
	{ label: 'i2p-typical', rttMs: 1_800 },
	{ label: 'i2p-slow', rttMs: 2_600 }
];

const sleep = (ms: number) =>
	new Promise<void>((r) => {
		setTimeout(r, ms);
	});

/**
 * Assert an elapsed time against a BAND, not just a ceiling.
 *
 * Every timing assertion in this release used to be `elapsed < 6000`, and that
 * is not an assertion about the numbers this file prints — a four-fold
 * regression to 5,900 ms passes it, and so does a message that did not travel
 * the route at all. Both ends matter and for different reasons:
 *
 *   THE CEILING is the maintainer's line. Six seconds, whatever the instances are.
 *
 *   THE FLOOR is what makes the measurement mean anything. `floor` is the sum of
 *   the hops this case's message actually has to cross. Arriving FASTER than
 *   that is not good news — it means the message skipped a leg, which is
 *   precisely how a false green looks: a replayed frame from a previous case, a
 *   cross-instance message that never crossed, a watcher resolved by something
 *   it should have ignored. Every one of those was a real defect in this file.
 *
 * The tolerance is asymmetric on purpose: 20% under the floor absorbs scheduler
 * jitter on the modelled hops, while the ceiling stays exactly where the maintainer put it.
 */
function checkTiming(label: string, what: string, elapsedMs: number, floorMs: number): void {
	const min = Math.floor(floorMs * 0.8);
	if (elapsedMs < 0) {
		bad(`${label}: ${what} — never arrived`);
		return;
	}
	if (elapsedMs < min) {
		bad(
			`${label}: ${what} in ${elapsedMs}ms — FASTER than the ${min}ms floor`,
			'the message cannot have crossed the hops this case models, so something ' +
				'short-circuited: a replayed frame, a skipped federation leg, or a watcher ' +
				'resolved by an event from another case. A number that is too good is a bug.'
		);
		return;
	}
	if (elapsedMs >= TARGET_MS) {
		bad(`${label}: ${what} took ${elapsedMs}ms — over the ${TARGET_MS}ms line`);
		return;
	}
	ok(`${label}: ${what} in ${elapsedMs}ms (floor ${min}ms, limit ${TARGET_MS}ms)`);
}

// ── a delaying TCP tunnel: an established circuit, just distant ──────
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
						/* peer gone mid-flight */
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
							/* gone */
						}
					}
					srv.close();
				}
			});
		});
	});
}

// ── real keys, real signatures ───────────────────────────────────────

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const BUYER = 'buyer';
const SELLER = 'seller';
const ORDER = 'sell-usd-for-blurt-abc';

const keys: Record<string, ReturnType<typeof PrivateKey.fromSeed>> = {
	[BUYER]: PrivateKey.fromSeed('morphit-matrix-smoke-buyer'),
	[SELLER]: PrivateKey.fromSeed('morphit-matrix-smoke-seller')
};
const pubs: Record<string, string> = {
	[BUYER]: keys[BUYER].createPublic().toString(),
	[SELLER]: keys[SELLER].createPublic().toString()
};

function signedChat(from: string, to: string, withOrder: boolean): unknown {
	const payload: Record<string, unknown> = {
		recipient: to,
		ciphertext: Buffer.from(`msg-${Math.random()}`).toString('base64'),
		header: {
			client_tag: `tag-${Math.random().toString(36).slice(2, 12)}`,
			ephemeral_pub: Buffer.from('ephemeral-public-key-32-bytes!!!').toString('base64'),
			nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64')
		}
	};
	if (withOrder) payload.order_permlink = ORDER;
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
					required_posting_auths: [from],
					json: JSON.stringify(payload)
				}
			]
		],
		extensions: []
	};
	return cryptoUtils.signTransaction(
		tx as unknown as Parameters<typeof cryptoUtils.signTransaction>[0],
		[keys[from]]
	);
}

/**
 * An instance's database, answering the queries the real gates issue.
 *
 * The durable chat table is EMPTY throughout, deliberately: every scenario here
 * happens inside the 45-63 seconds the poller takes to catch up, which is the
 * whole window the fast path exists to cover. Anything that passes here passes
 * without help from durable history.
 */
function instanceDb(): FastFederationDb {
	return {
		async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
			const rows: unknown[] = [];
			if (text.includes('posting_pubkey')) {
				// Both accounts are known to every instance — they are on-chain.
				rows.push({ posting_pubkey: null });
			} else if (text.includes('FROM blocks')) {
				rows.push({ exists: false });
			} else if (text.includes('FROM chat_messages')) {
				rows.push({ exists: false }); // nothing durable yet, on purpose
			} else if (text.toLowerCase().includes('orders')) {
				// THE SHAPE THE REAL QUERY RETURNS, not a plausible-looking row.
				//
				// checkChatOrder selects `account` and a COMPUTED `live` boolean
				// (`status = 'live' AND ...`) — it does not select `status` at all,
				// and it does not compare against 'open'. A stub that answered
				// `{ status: 'open', fee_status: 'verified', owner: SELLER }`
				// therefore produced `live === undefined`, which made
				// `orderResponseBypass` false, which made every first-contact
				// message in this file NON-notifying. The pings still arrived —
				// delivery is ungated by design — so the whole matrix passed while
				// silently testing the opposite of the release's headline claim:
				// that a buyer's first contact reaches a seller's INBOX, including
				// a seller whose browser is shut.
				//
				// A stub is a claim about the database. Getting it wrong does not
				// make a test lenient, it makes it a test of something else.
				rows.push({ account: SELLER, live: true });
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

/** Posting keys resolve per account — the federation endpoint needs the real
 *  one to recover a signature against. */
function instanceDbWithKeys(): FastFederationDb {
	const base = instanceDb();
	return {
		async query<R extends pg.QueryResultRow>(
			text: string,
			params?: readonly unknown[]
		): Promise<pg.QueryResult<R>> {
			if (text.includes('posting_pubkey')) {
				const who = String(params?.[0] ?? '');
				const pub = pubs[who];
				const rows = pub === undefined ? [] : [{ posting_pubkey: pub }];
				return {
					rows: rows as unknown as R[],
					rowCount: rows.length,
					command: 'SELECT',
					oid: 0,
					fields: []
				} as pg.QueryResult<R>;
			}
			return base.query<R>(text, params);
		}
	};
}

// ── an instance, as a real HTTP server ───────────────────────────────

interface Instance {
	readonly kind: 'clearnet' | 'hidden';
	readonly port: number;
	readonly hopMs: number;
	readonly dispatcher: ChatFastDispatcher;
	/** The REAL activity route. Subscribed to directly rather than through a
	 *  socket — see watchInbox for why that is the honest choice here. */
	readonly activity: Hono;
	close(): Promise<void>;
}

/** Stand up one instance: broadcast route, federation endpoint, activity
 *  stream, and a dispatcher pointed at whatever peers it has. */
async function startInstance(
	kind: 'clearnet' | 'hidden',
	peerPortsProvider: () => number[],
	/**
	 * Deliver locally — i.e. does THIS instance host both people?
	 *
	 * Set only for the same-instance rows, and that is the difference between
	 * this file measuring federation and this file pretending to.
	 *
	 * `chatEventBus` is a process-wide singleton with no per-instance seam, so
	 * both "instances" in this process share one bus. With local delivery wired
	 * on both, instance A's own emit was heard by instance B's activity route,
	 * and every cross-instance row passed WITHOUT THE FEDERATION DOING ANYTHING
	 * — proven by deleting the fan-out entirely and watching all thirty
	 * scenarios stay green.
	 *
	 * Leaving it off for the cross-instance rows is faithful, not a dodge: in
	 * production A does call it, and it emits into A's bus, where nobody is
	 * listening for a recipient who lives on B. The only route to B's inbox is
	 * the peer push. That is now the only route here too, and harness mutations
	 * Q5 and Q6 delete each end of it to prove this file notices.
	 */
	deliverLocally: boolean,
	/** The hidden hop this instance is modelled at. Overridable so the worst
	 *  case can be walked across the range of transports Morphit runs on,
	 *  rather than measured once at a Tor-shaped number and assumed for I2P. */
	hiddenRttMs: number = HIDDEN_RTT_MS
): Promise<Instance> {
	const db = instanceDbWithKeys();
	const gates = gatesFromDb(db);
	const federation = federationChatFastRoute(db).app;
	const activity = chatActivityStreamRoute();

	// A DISTINCT id per transaction, as a real node gives. The stub used to
	// return the same constant every time, which is not a harmless
	// simplification: the fast-emit ledger keys on the transaction id, so every
	// message after the first in a case looked like a duplicate of the first and
	// was correctly suppressed. The smoke could not see it, because it only ever
	// asserted that pings ARRIVED — and the first one did.
	let acks = 0;
	const blurtStub = {
		callCondenser: async () => {
			await sleep(CHAIN_ACK_MS);
			acks += 1;
			return { id: `${kind}${acks}`.padEnd(40, '0').slice(0, 40) };
		}
	} as unknown as BlurtClient;

	const dispatcher = new ChatFastDispatcher({
		db: {
			async query<R extends pg.QueryResultRow>(): Promise<pg.QueryResult<R>> {
				// Probe-verified peers only receive pushes, so the rows
				// carry a probe status. The registered origin names the loopback
				// port; `postIsolated` below stands in for Tor and dials it.
				const rows = peerPortsProvider().map((p) => ({
					origin: `https://peer-${p}.example`,
					reg_alt_networks: null,
					last_probe_status: 'good',
					last_probed_at: null,
					registered_at_time: null
				}));
				return {
					rows: rows as unknown as R[],
					rowCount: rows.length,
					command: 'SELECT',
					oid: 0,
					fields: []
				} as pg.QueryResult<R>;
			}
		},
		selfOrigin: `http://self-${kind}-${Math.random()}.invalid`,
		// Tor configured (fan-out runs only over Tor); never dialled here, since
		// `postIsolated` is injected.
		proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' },
		// The instance knows its users' posting keys, as a real one does from
		// chain sync. A message must verify against them before this instance
		// fans it out early or delivers it to its own listeners: the node's
		// "accepted" alone is one node's word.
		lookupPostingKey: async (account) => pubs[account] ?? null,
		postIsolated: async (url, body, _proxies, timeoutMs) => {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), timeoutMs);
			try {
				const r = await fetch(url.replace(/^https:\/\/peer-(\d+)\.example/, 'http://127.0.0.1:$1'), {
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

	const localDeliver = (located: LocatedChatOp, trxId: string): void => {
		if (process.env.MATRIX_DEBUG)
			console.log(
				`      [local-deliver] ${located.signer}->${located.recipient} trx=${trxId.slice(0, 8)}`
			);
		void deliverVerifiedPush(located, trxId, gates)
			.then((o) => {
				if (process.env.MATRIX_DEBUG) console.log(`      [deliver-outcome] ${o}`);
			})
			.catch((e) => {
				if (process.env.MATRIX_DEBUG) console.log(`      [deliver-threw] ${String(e)}`);
			});
	};

	const broadcast = broadcastRoute(
		blurtStub,
		dispatcher,
		deliverLocally ? localDeliver : undefined
	);

	const srv: Server = createServer((req, res) => {
		const url = req.url ?? '';
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			void (async () => {
				const target = url.includes('/federation') ? federation : broadcast;
				const r = await target.request('/', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: Buffer.concat(chunks).toString('utf8')
				});
				res.writeHead(r.status, { 'content-type': 'application/json' });
				res.end(await r.text());
			})();
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));

	return {
		kind,
		port: (srv.address() as AddressInfo).port,
		hopMs: kind === 'hidden' ? hiddenRttMs : CLEARNET_RTT_MS,
		dispatcher,
		activity,
		close: async () => {
			dispatcher.stop();
			srv.closeAllConnections?.();
			await new Promise<void>((r) => srv.close(() => r()));
		}
	};
}

/**
 * A browser watching its inbox.
 *
 * Subscribed DIRECTLY to the real `chatActivityStreamRoute` stream rather than
 * through a socket, with the instance→browser hop added as an explicit delay.
 *
 * An earlier version of this file wrapped the route in a hand-rolled HTTP
 * server and read it over a delaying tunnel. That was more plumbing than the
 * question needed and it had its own bug: the wrappers were never cancelled
 * between cases, so each case left a live subscription writing into a destroyed
 * response, and the interleaving made a working product look broken. The
 * real-socket SSE leg is measured in `fastchat-three-leg-smoke.ts`, which is
 * where that claim belongs; what THIS file is about is which messages reach an
 * inbox at all, across every kind of instance, and how fast.
 *
 * `close()` cancels the reader, which cancels the stream, which unsubscribes it
 * from the bus — so one case cannot leak a listener into the next.
 */
interface InboxWatch {
	/** Arm a fresh wait. Resolves with the NEXT inbound ping to arrive after this
	 *  call, never one already seen. */
	nextInbound(): Promise<{ at: number; raw: string }>;
	/** The most recent chat_activity frame seen, whatever its direction.
	 *
	 *  Captured separately from the inbound wait above so that a frame which no
	 *  longer looks inbound — because a field was renamed, say — can still be
	 *  INSPECTED and reported precisely, instead of only ever surfacing as a
	 *  timeout that says nothing about why. */
	lastFrame(): string | null;
	close(): void;
}

async function watchInbox(activity: Hono, account: string, oneWayMs: number): Promise<InboxWatch> {
	const res = await activity.request(`/${account}/stream`, { method: 'GET' });
	const reader = res.body?.getReader();

	// Armed per direction, NOT once per case — and REPLAYED frames are discarded
	// outright, which is the part that actually closes the trap.
	//
	// The bus keeps a short replay ring of recent gated events and hands it to
	// any stream that opens. That is exactly right in production (a browser that
	// was closed when a message landed still lights its badge) and a menace to a
	// test, because each case here opens fresh streams and the ring is a
	// process-wide singleton.
	//
	// Arming per direction was the first attempt at this and it is NOT
	// sufficient: a replayed frame is read at open, and the instance→browser hop
	// is then added with a setTimeout, so its callback lands up to 900 ms later
	// — comfortably after the watcher is armed. It then resolves the wait, and
	// the case reports an arrival it never sent, with an elapsed time below the
	// modelled floor. A replayed frame is distinguishable at the wire level and
	// always has been: the route sends `at: <original block time>` on a replay
	// and `at: null` on a live ping. So the test can simply refuse to count one,
	// which is both the honest fix and one that keeps working if the ring's
	// contents change. The ring is also cleared per case in runPair; this is the
	// belt to that pair of braces.
	let waiting: ((v: { at: number; raw: string }) => void) | null = null;
	let lastFrame: string | null = null;

	if (reader !== undefined) {
		void (async () => {
			const dec = new TextDecoder();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value === undefined) continue;
					const text = dec.decode(value);
					if (text.includes('chat_activity')) lastFrame = text;
					// Only an INBOUND ping lights an inbox. The account's own outgoing
					// message pings this stream too (it is a participant stream) and
					// must not be mistaken for a message arriving.
					if (!text.includes('"inbound":true')) continue;
					// A REPLAYED frame, not a live one. `at` carries the event's
					// original time on a replay and null on a live ping
					// (chatActivityStream.ts), so this is the wire's own statement
					// of which it is. Counting a replay as an arrival is how a case
					// measures the previous case's message. See the note above.
					if (!text.includes('"at":null')) continue;
					// The hop from the instance to the person's browser.
					setTimeout(() => {
						const w = waiting;
						if (w !== null) {
							waiting = null;
							w({ at: Date.now(), raw: text });
						}
					}, oneWayMs);
				}
			} catch {
				/* cancelled — expected at the end of a case */
			}
		})();
	}

	return {
		nextInbound: () =>
			new Promise<{ at: number; raw: string }>((resolve) => {
				waiting = resolve;
			}),
		lastFrame: () => lastFrame,
		close: () => {
			void reader?.cancel().catch(() => undefined);
		}
	};
}

console.log('fastchat-instance-matrix — every kind of instance, both ways, to the inbox');
console.log('');
console.log(
	`  modelled: ${CLEARNET_RTT_MS}ms per clearnet hop, ${HIDDEN_RTT_MS}ms per privacy hop, ` +
		`${CHAIN_ACK_MS}ms chain ack`
);
console.log('');

/**
 * One full exchange, measured: a buyer's first contact on the seller's order,
 * then the seller's reply. Both timed to the recipient's INBOX.
 */
async function runPair(
	label: string,
	senderKind: 'clearnet' | 'hidden',
	recipientKind: 'clearnet' | 'hidden',
	sameInstance: boolean,
	hiddenRttMs: number = HIDDEN_RTT_MS
): Promise<void> {
	_resetSeenForTest();
	_resetOutboundChatForTest();
	_resetFastEmitLedgerForTest();
	// And the bus's replay ring, which the other three do not cover. It is a
	// process-wide singleton that hands its recent gated events to any stream
	// that opens, so without this every stream in this case opens holding the
	// PREVIOUS case's events — and a watcher armed a moment later is resolved by
	// one of them. That reported a message as arriving before it was sent.
	chatEventBus._resetFastRingForTest();
	_resetFastNotifyBudgetForTest();

	let bPort = 0;
	let aPort = 0;
	const a = await startInstance(
		senderKind,
		() => (sameInstance ? [] : bPort === 0 ? [] : [bPort]),
		sameInstance,
		hiddenRttMs
	);
	const b = sameInstance
		? a
		: await startInstance(
				recipientKind,
				() => (aPort === 0 ? [] : [aPort]),
				false,
				hiddenRttMs
			);
	aPort = a.port;
	bPort = b.port;

	// The hop between instances is the worse of the two ends: a privacy instance
	// makes the whole route a privacy route.
	const betweenMs = Math.max(a.hopMs, b.hopMs);
	const legToA = await delayingTunnel(a.port, a.hopMs / 2);
	const legToB = await delayingTunnel(b.port, b.hopMs / 2);
	// The federation hop, when there is one — IN BOTH DIRECTIONS.
	//
	// Only the A→B leg used to be tunnelled, so the seller's reply crossed the
	// federation at loopback speed and the reply numbers this file printed were
	// short by half a hop. Nothing noticed, because the only assertion was
	// `< 6000 ms`; the floor check does, which is what it is for. A model that is
	// asymmetric is a model of something that does not exist.
	const legAtoB = sameInstance ? null : await delayingTunnel(b.port, betweenMs / 2);
	const legBtoA = sameInstance ? null : await delayingTunnel(a.port, betweenMs / 2);
	if (legAtoB !== null) bPort = legAtoB.port;
	if (legBtoA !== null) aPort = legBtoA.port;

	// Watch the bus so the GATE's verdict can be asserted alongside the ping.
	const busEvents: { sender: string; recipient: string; replayable: boolean }[] = [];
	const offBus = chatEventBus.onFast((ev) => {
		busEvents.push({
			sender: ev.sender,
			recipient: ev.recipient,
			replayable: ev.replayable === true
		});
	});

	// The hops each direction's message actually has to cross, which is the floor
	// checkTiming holds the measurement to. Written out rather than folded into a
	// constant so that the model is auditable line by line.
	//
	//   sender's browser → sender's instance   half the sender's hop
	//   [if federated] instance → instance      half the between hop
	//   recipient's instance → their browser    half the recipient's hop
	//
	// The chain acknowledgement is deliberately NOT in here: the fan-out happens
	// before the chain call, so a message is not waiting on it. If it ever starts
	// showing up in these numbers, that ordering has regressed — which is exactly
	// what the three-leg smoke's stalled-node case exists to catch.
	const fedHop = sameInstance ? 0 : betweenMs / 2;
	const floor1 = a.hopMs / 2 + fedHop + b.hopMs / 2;
	const floor2 = b.hopMs / 2 + fedHop + a.hopMs / 2;

	// Both people are looking at their inboxes.
	const sellerInbox = await watchInbox(b.activity, SELLER, b.hopMs / 2);
	const buyerInbox = await watchInbox(a.activity, BUYER, a.hopMs / 2);
	await sleep(150);

	const send = async (viaPort: number, trx: unknown): Promise<void> => {
		await fetch(`http://127.0.0.1:${viaPort}/`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ trx })
		});
	};

	// ── Direction 1: the buyer opens a chatroom on the seller's order ──
	// Armed BEFORE the send, so nothing in flight is missed and nothing already
	// seen is counted.
	const awaitSeller = sellerInbox.nextInbound();
	const t1 = Date.now();
	await send(legToA.port, signedChat(BUYER, SELLER, true));
	const ping1 = await Promise.race([awaitSeller, sleep(TARGET_MS + 3_000).then(() => null)]);
	const openMs = ping1 === null ? -1 : ping1.at - t1;

	checkTiming(label, "a buyer's first contact reaches the seller's INBOX", openMs, floor1);

	if (ping1 !== null && ping1.raw.includes(ORDER))
		ok(`${label}: and the ping names the order, so the inbox can draw the right card`);
	else
		bad(
			`${label}: the inbox ping did not carry the order permlink`,
			ping1 === null ? 'no ping arrived at all' : ping1.raw.slice(-160)
		);

	// AND the FIRST CONTACT must clear the notification gate, for exactly the
	// reason spelled out for the reply direction below: the ping reaches an open
	// inbox either way, so asserting only the ping says nothing about the person
	// whose browser is shut — who is, by definition, most first contacts. This is
	// the release's headline claim and it went untested; the order stub was even
	// producing the WRONG ANSWER here (see instanceDb) while the matrix stayed
	// green.
	const openEvent = busEvents.find((e) => e.sender === BUYER && e.recipient === SELLER);
	if (openEvent === undefined) bad(`${label}: no first-contact event reached the bus at all`);
	else if (openEvent.replayable)
		ok(`${label}: and the first contact clears the notification gate (closed browser too)`);
	else
		bad(
			`${label}: the buyer's first contact did NOT clear the notification gate`,
			'a seller whose browser is shut is told nothing until the chain catches up — ' +
				'the ping alone does not prove this, which is why it is asserted separately'
		);

	// THE CROSS-WORKSPACE CONTRACT, from this side.
	//
	// The browser will not light anything unless the frame carries `inbound`
	// true, a non-empty string `peer`, and a string `order`
	// (apps/web/src/lib/chat/globalChatActivityStream.ts, which has its own test
	// driving the same frame). Rename or retype a field here and badges stop
	// working for everyone, silently, with no error on either side. So the exact
	// key set is pinned here and the parse is pinned there; neither half can
	// drift without one of them failing.
	{
		const m = /data: (\{.*?\})/.exec(sellerInbox.lastFrame() ?? '');
		let keys: string[] = [];
		let parsed: Record<string, unknown> = {};
		try {
			parsed = JSON.parse(m?.[1] ?? '{}') as Record<string, unknown>;
			keys = Object.keys(parsed).sort();
		} catch {
			/* the assertion below reports it */
		}
		const expected = ['at', 'inbound', 'order', 'peer'];
		const shapeOk =
			keys.join(',') === expected.join(',') &&
			parsed.inbound === true &&
			typeof parsed.peer === 'string' &&
			(parsed.peer as string).length > 0 &&
			typeof parsed.order === 'string' &&
			// `at` is the fourth field, and the only one whose SEMANTICS were
			// never checked on either side. On a LIVE ping it must be null: the
			// browser reads a number here as "this is a replay, and it happened
			// then", and compares it against the reader's cursor. A live ping
			// carrying a time — the arrival time, say — would be indistinguishable
			// from a replay, and a replay carrying null would be dated to the
			// moment it was read and re-light a badge the user had cleared. The
			// browser's half of this is in globalChatActivityStream.test.ts.
			parsed.at === null;
		if (shapeOk) ok(`${label}: the frame carries exactly the fields the browser parses`);
		else
			bad(
				`${label}: the activity frame does not match what the browser requires`,
				`got keys [${keys.join(', ')}], expected [${expected.join(', ')}] with inbound:true, ` +
					`string peer, string order and at:null (got at:${JSON.stringify(parsed.at)}) — ` +
					'see globalChatActivityStream.test.ts'
			);
	}

	// ── Direction 2: the seller replies ────────────────────────────────
	// The durable table is still empty. Before v1.18.0 this notified nobody:
	// the order belongs to the seller rather than to the recipient, and the
	// buyer's own opening message is not durable yet.
	const awaitBuyer = buyerInbox.nextInbound();
	const t2 = Date.now();
	await send(legToB.port, signedChat(SELLER, BUYER, true));
	const ping2 = await Promise.race([awaitBuyer, sleep(TARGET_MS + 3_000).then(() => null)]);
	const replyMs = ping2 === null ? -1 : ping2.at - t2;

	checkTiming(label, "the seller's REPLY reaches the buyer's inbox", replyMs, floor2);

	// AND the reply must clear the notification gate.
	//
	// The ping above arrives whether or not it does — an open inbox is fed
	// unconditionally. The gate decides the two cases where the person is NOT
	// already looking: whether a web push is sent to a closed browser, and
	// whether the message is replayed into a browser that opens a moment later.
	// For the reply direction both of those used to fail, because the order
	// belongs to the seller rather than to the recipient and the buyer's own
	// opening message is not in the durable table yet. Asserting only the ping
	// would have passed against that bug.
	const replyEvent = busEvents.find((e) => e.sender === SELLER && e.recipient === BUYER);
	if (replyEvent === undefined) bad(`${label}: no reply event reached the bus at all`);
	else if (replyEvent.replayable)
		ok(`${label}: and it clears the notification gate — a closed or reopened browser sees it`);
	else
		bad(
			`${label}: the reply did NOT clear the notification gate`,
			'an open inbox still shows it, but a browser that is closed gets no push and one ' +
				'that opens a moment later never sees it — for the person who STARTED the ' +
				'conversation'
		);

	offBus();
	sellerInbox.close();
	buyerInbox.close();
	legToA.close();
	legToB.close();
	legAtoB?.close();
	legBtoA?.close();
	await a.close();
	if (!sameInstance) await b.close();
}

await runPair('same instance, privacy-only', 'hidden', 'hidden', true);
await runPair('same instance, clearnet', 'clearnet', 'clearnet', true);
await runPair('clearnet → clearnet', 'clearnet', 'clearnet', false);
await runPair('clearnet → privacy', 'clearnet', 'hidden', false);
await runPair('privacy → clearnet', 'hidden', 'clearnet', false);
await runPair('privacy → privacy', 'hidden', 'hidden', false);

// ── THE WORST CASE, ACROSS THE NETWORKS IT ACTUALLY RUNS ON ──────────
//
// `privacy → privacy` is the case with the least headroom and no fallback
// underneath it: two zero-clearnet instances, three hidden legs, and nothing
// to degrade to. Every other row in this matrix is cheaper.
//
// Running it once at a Tor-shaped 900 ms and calling the target met would be
// answering a narrower question than the one asked. So it is walked across the
// band, and each run is held to the same floor-and-ceiling check as everything
// above — the floor is what stops a slow run from passing by not travelling.
for (const band of HIDDEN_BANDS) {
	await runPair(`privacy → privacy [${band.label} ${band.rttMs}ms]`, 'hidden', 'hidden', false, band.rttMs);
}

// ── HOW MUCH SLOWER A NETWORK COULD GET ─────────────────────────────
//
// Derived from the model rather than asserted, so it cannot drift away from
// what the rows above actually measure.
//
// The worst case crosses three half-hops — browser→instance, instance→instance,
// instance→browser — so its latency is 1.5 round trips, and the target divides
// out to the slowest transport that still fits. Stated as a number because
// "it comfortably fits" is not something an operator can check against their
// own network, and because the day a hop gets slower this is the line that
// says whether it still works.
//
// There is a SECOND ceiling, and the two must be reported together: the
// federation push is abandoned at PUSH_TIMEOUT_MS, which bounds the
// instance-to-instance round trip regardless of what the six-second budget
// would allow. A transport inside the latency budget but outside the push
// timeout does not deliver fast — it does not deliver at all on that leg.
{
	const HALF_HOPS = 3;
	const latencyCeilingMs = Math.floor((TARGET_MS * 2) / HALF_HOPS);
	const slowest = HIDDEN_BANDS.reduce((m, b) => Math.max(m, b.rttMs), 0);

	if (latencyCeilingMs >= slowest)
		ok(
			`the 6s budget tolerates a hidden round trip up to ${latencyCeilingMs}ms — above ` +
				`the slowest band walked (${slowest}ms)`
		);
	else
		bad(
			`the budget tolerates only ${latencyCeilingMs}ms but a band of ${slowest}ms is walked`,
			'the bands above are then asserting something the target cannot deliver'
		);

	// PUSH_TIMEOUT_MS is not exported; it is read from the source so this cannot
	// silently disagree with the dispatcher.
	const disp = readFileSync(
		new URL('../src/indexer/chatFastDispatcher.ts', import.meta.url),
		'utf8'
	);
	const m = /const PUSH_TIMEOUT_MS = ([\d_]+)/.exec(disp);
	const pushTimeoutMs = m === null ? -1 : Number(m[1]?.replace(/_/g, ''));
	if (pushTimeoutMs <= 0) {
		bad('could not read PUSH_TIMEOUT_MS from chatFastDispatcher.ts');
	} else if (pushTimeoutMs >= slowest) {
		ok(
			`and the federation push is allowed ${pushTimeoutMs}ms, above the slowest band ` +
				`(${slowest}ms) — the peer leg is not abandoned before it can answer`
		);
	} else {
		bad(
			`the push timeout is ${pushTimeoutMs}ms but the slowest band is ${slowest}ms`,
			'a peer on that transport would have every push abandoned mid-flight, so the ' +
				'latency budget is irrelevant — nothing arrives to be timed'
		);
	}
}

console.log('');
console.log('────────────────────────────────────────────────────────');
if (fail === 0) {
	console.log(`✓ all ${pass} fastchat-instance-matrix scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
