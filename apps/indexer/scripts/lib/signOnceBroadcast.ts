/**
 * Sign ONCE, broadcast to the best RPC node, fall back through the rest
 * — shared by the laptop broadcast scripts:
 * release-broadcast, rpc-directory-broadcast, chain-snapshot-broadcast and
 * indexer-snapshot-broadcast.
 *
 * WHAT WAS WRONG. Each script walked the six clearnet nodes in a fixed order
 * and called dblurt's `customJson` per node. That call PREPARES AND SIGNS A NEW
 * TRANSACTION against each node's own head block. So when a node accepted the
 * op but the answer was lost (a timeout, a reset connection), the next node
 * was handed a DIFFERENT transaction carrying the same op — two
 * `morphit_release_v1` ops on chain from one ceremony. The order was fixed, so
 * a dead first node cost every run its full timeout, and the hidden nodes were
 * never used at all.
 *
 * NOW:
 *   1. every candidate node is asked for its head in parallel (a short,
 *      bounded wait; a spinner-style line says so), and the answers are ranked
 *      — healthy and current first, then by latency;
 *   2. the transaction is built from the best node's head — a head a SECOND
 *      node confirms (same head, or the same block id at that height) — and
 *      SIGNED ONCE;
 *   3. that exact signed transaction goes to the ranked nodes in turn; a node
 *      answering "duplicate transaction" means an earlier attempt landed —
 *      success, with the same id;
 *   4. a node's "accepted" is checked on ANOTHER node: the transaction must be
 *      in the block it named (else the scripts say it is not confirmed);
 *   5. if the transaction expires before any node takes it, the script STOPS
 *      and says to check the chain before running again — it never re-signs
 *      on its own, because the lost answer may have been an acceptance.
 *
 * HIDDEN NODES ARE USED WHEREVER THIS MACHINE CAN REACH THEM (v1.21.18). The
 * federation's RPC nodes are the six clearnet ones and fourteen hidden ones
 * (.onion and .b32.i2p). These scripts run on the maintainer's LAPTOP (Block 4
 * of the release ceremony), which may or may not run Tor or i2pd. So before
 * ranking, the laptop is checked for a Tor SOCKS proxy (MORPHIT_INDEXER_TOR_SOCKS,
 * else 127.0.0.1:9050, else Tor Browser's 127.0.0.1:9150 — it must answer as
 * Tor does: the SOCKS5 greeting, then a CONNECT to an .onion name with "general
 * failure" / "host unreachable") and an i2pd HTTP proxy
 * (MORPHIT_INDEXER_I2P_HTTP_PROXY, else 127.0.0.1:4444 — it must answer with
 * i2pd's own proxy page). `--node <an .onion>` and `--include-hidden` use the
 * Tor found the same way. On a hidden-only Morphit server (its indexer.env has
 * no clearnet RPC nodes, or its Kubo routes nothing) no clearnet node is ever
 * asked. The .onion nodes join the ranking when
 * Tor is there, the .b32.i2p ones when i2pd is, and the run says which. Every
 * candidate is asked in parallel; once a node has answered, the rest get a few
 * more seconds and any still silent are tried last — a dead hidden node never
 * holds the ranking for its full timeout. `--no-hidden` keeps to clearnet;
 * `--include-hidden` asks every hidden node whatever the check found;
 * `--node <url>` still pins exactly one node.
 */
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client, cryptoUtils, type PrivateKey } from '@beblurt/dblurt';
import {
	DEFAULT_BLURT_RPC_ENDPOINTS,
	DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
} from '@morphit/operator-config';

export interface NodeHealth {
	readonly url: string;
	readonly ok: boolean;
	readonly ms: number;
	readonly headBlock: number | null;
	/** The props needed to build a transaction, when the node answered. */
	readonly props?: { head_block_number: number; head_block_id: string; time: string };
	readonly reason?: string;
}

/** The nodes to consider, before ranking. */
export function candidateNodes(opts: {
	readonly nodeOverride: string | null;
	readonly includeHidden: boolean;
}): string[] {
	if (opts.nodeOverride !== null && opts.nodeOverride !== '') return [opts.nodeOverride];
	return [
		...DEFAULT_BLURT_RPC_ENDPOINTS,
		...(opts.includeHidden ? DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS : [])
	];
}

const isHidden = (url: string): boolean => /\.(onion|i2p)(:\d+)?(\/|$)/i.test(url);
const isOnion = (url: string): boolean => /\.onion(:\d+)?(\/|$)/i.test(url);
const isI2p = (url: string): boolean => /\.i2p(:\d+)?(\/|$)/i.test(url);

/** Which hidden nodes to ask: as far as this machine reaches them, none, or all. */
export type HiddenMode = 'auto' | 'off' | 'on';

/** The proxies found on this machine (`host:port`), or null. */
export interface LocalProxies {
	readonly tor: string | null;
	readonly i2p: string | null;
}

function splitHostPort(hp: string): { host: string; port: number } | null {
	const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(hp.trim());
	if (!m) return null;
	const port = Number(m[2]);
	return port > 0 && port < 65536 ? { host: m[1]!, port } : null;
}

/** A name Tor refuses on its own, with no network: a v3 .onion whose version
 *  byte and checksum are wrong (it never reaches a descriptor lookup). */
const PROBE_ONION = `${'a'.repeat(56)}.onion`;

/** Send an HTTP request and hand the reply (up to `max` bytes) to `answers`:
 *  once the whole reply is in (the other side closed, its Content-Length
 *  arrived, or its page's </title> did), else at `timeoutMs`. A reply that
 *  does not start like HTTP is refused at once. */
function httpReplyOf(
	hp: string,
	request: string,
	answers: (all: string) => boolean,
	timeoutMs: number,
	max = 8_192
): Promise<boolean> {
	const a = splitHostPort(hp);
	if (a === null) return Promise.resolve(false);
	return new Promise((resolve) => {
		let done = false;
		let got = '';
		const finish = (v: boolean): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(v);
		};
		const complete = (): boolean => {
			if (got.length >= max || /<\/title>/i.test(got)) return true;
			const end = got.indexOf('\r\n\r\n');
			if (end < 0) return false;
			const len = /\r\ncontent-length:[ \t]*(\d+)/i.exec(got.slice(0, end))?.[1];
			return len !== undefined && got.length - (end + 4) >= Number(len);
		};
		const sock = connect(a.port, a.host);
		const timer = setTimeout(() => finish(got !== '' && answers(got)), timeoutMs);
		sock.once('connect', () => sock.write(request));
		sock.on('data', (d: Buffer) => {
			got = (got + d.toString('latin1')).slice(0, max);
			if (got.length >= 5 && !got.startsWith('HTTP/')) return finish(false);
			if (complete()) finish(answers(got));
		});
		sock.once('error', () => finish(false));
		sock.once('close', () => finish(got !== '' && answers(got)));
	});
}

/**
 * A Tor SOCKS proxy: it answers the SOCKS5 greeting (05 00), and then a CONNECT
 * to a .onion NAME (address type 3) with "general failure" (01) or "host
 * unreachable" (04) — what Tor answers for an onion it cannot reach (and with
 * ExtendedErrors, F0–F7). The name used is one Tor refuses locally, so nothing
 * is looked up. Any other SOCKS5 proxy (an ssh -D tunnel, a generic proxy)
 * that refuses the address type (08) or closes is not Tor: .onion nodes are
 * not sent through it (v1.21.18 review: the greeting alone was trusted).
 */
export function answersSocks5(hp: string, timeoutMs = 3_000): Promise<boolean> {
	const a = splitHostPort(hp);
	if (a === null) return Promise.resolve(false);
	return new Promise((resolve) => {
		let done = false;
		let stage: 'greeting' | 'connect' = 'greeting';
		let got = Buffer.alloc(0);
		const finish = (v: boolean): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(v);
		};
		const sock = connect(a.port, a.host);
		const timer = setTimeout(() => finish(false), timeoutMs);
		sock.once('connect', () => sock.write(Buffer.from([5, 1, 0])));
		sock.on('data', (d: Buffer) => {
			got = Buffer.concat([got, d]);
			if (got.length < 2) return;
			if (stage === 'greeting') {
				if (got[0] !== 5 || got[1] !== 0) return finish(false);
				stage = 'connect';
				got = Buffer.alloc(0);
				const name = Buffer.from(PROBE_ONION, 'latin1');
				sock.write(
					Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([0, 80])])
				);
				return;
			}
			const rep = got[1]!;
			finish(got[0] === 5 && (rep === 1 || rep === 4 || (rep >= 0xf0 && rep <= 0xf7)));
		});
		sock.once('error', () => finish(false));
		sock.once('close', () => finish(false));
	});
}

/** i2pd's HTTP proxy: a request for an .i2p name it does not know is answered
 *  with its own page ("<title>I2Pd HTTP proxy</title>"). Any other HTTP server
 *  on the port (v1.21.18 review: every "HTTP/" reply counted) is not i2pd. */
export function answersHttpProxy(hp: string, timeoutMs = 3_000): Promise<boolean> {
	return httpReplyOf(
		hp,
		'GET http://morphit-probe.i2p/ HTTP/1.1\r\nHost: morphit-probe.i2p\r\nConnection: close\r\n\r\n',
		(t) => t.startsWith('HTTP/') && /<title>\s*I2Pd HTTP proxy\s*<\/title>/i.test(t),
		timeoutMs
	);
}

/** Where to look for this machine's proxies. A configured address is the only
 *  one tried; otherwise Tor's two usual ports (the tor service, Tor Browser). */
export function proxyCandidates(env: NodeJS.ProcessEnv): {
	readonly tor: readonly string[];
	readonly i2p: readonly string[];
} {
	const tor = env.MORPHIT_INDEXER_TOR_SOCKS?.trim();
	const i2p = env.MORPHIT_INDEXER_I2P_HTTP_PROXY?.trim();
	return {
		tor: tor ? [tor] : ['127.0.0.1:9050', '127.0.0.1:9150'],
		i2p: i2p ? [i2p] : ['127.0.0.1:4444']
	};
}

/** The first candidate of each kind that really is that proxy. */
export async function detectLocalProxies(
	env: NodeJS.ProcessEnv = process.env,
	check: {
		readonly socks?: (hp: string) => Promise<boolean>;
		readonly http?: (hp: string) => Promise<boolean>;
	} = {}
): Promise<LocalProxies> {
	const socks = check.socks ?? answersSocks5;
	const http = check.http ?? answersHttpProxy;
	const c = proxyCandidates(env);
	const first = async (
		list: readonly string[],
		ok: (hp: string) => Promise<boolean>
	): Promise<string | null> => {
		const res = await Promise.all(list.map((hp) => ok(hp).catch(() => false)));
		const i = res.indexOf(true);
		return i < 0 ? null : list[i]!;
	};
	const [tor, i2p] = await Promise.all([first(c.tor, socks), first(c.i2p, http)]);
	return { tor, i2p };
}

/**
 * Is the box this runs on a hidden-only Morphit node? 'yes' when its
 * indexer.env sets an EMPTY clearnet RPC pool (`MORPHIT_INDEXER_RPC_ENDPOINTS=`,
 * what the tor-only install writes) or its Kubo routes nothing
 * (`Routing.Type` none); 'no' when indexer.env names clearnet nodes, or there
 * is no Morphit config here at all (a laptop); 'unknown' when indexer.env is
 * there but this user cannot read it and Kubo does not say. Reads files and
 * asks the local `ipfs` only; never the network. MORPHIT_ENV_ROOT relocates
 * the files (tests).
 */
export function hostHiddenOnly(
	deps: {
		readonly env?: NodeJS.ProcessEnv;
		readonly readFile?: (path: string) => string;
		readonly exists?: (path: string) => boolean;
		readonly ipfsRoutingType?: () => string | null;
	} = {}
): 'yes' | 'no' | 'unknown' {
	const env = deps.env ?? process.env;
	const root = env.MORPHIT_ENV_ROOT ?? '';
	const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
	const exists = deps.exists ?? ((p: string) => existsSync(p));
	const kubo = (): string | null => {
		if (deps.ipfsRoutingType !== undefined) return deps.ipfsRoutingType();
		const r = spawnSync('ipfs', ['config', 'Routing.Type'], {
			encoding: 'utf8',
			timeout: 5_000,
			env: { ...process.env, IPFS_PATH: env.IPFS_PATH ?? '/var/lib/ipfs/.ipfs' }
		});
		return r.status === 0 && typeof r.stdout === 'string'
			? r.stdout.trim().replace(/^"|"$/g, '')
			: null;
	};
	let unreadable = false;
	for (const f of [`${root}/etc/morphit/indexer.env`, `${root}/opt/morphit/indexer.env`]) {
		if (!exists(f)) continue;
		let text: string;
		try {
			text = read(f);
		} catch {
			unreadable = true;
			continue;
		}
		let raw: string | undefined;
		for (const m of text.matchAll(
			/^[ \t]*(?:export[ \t]+)?MORPHIT_INDEXER_RPC_ENDPOINTS[ \t]*=(.*)$/gm
		))
			raw = m[1] ?? '';
		if (raw === undefined) break; // not set: the indexer's shipped clearnet list
		const v = raw
			.replace(/\r$/, '')
			.replace(/(^|[ \t])#.*$/, '')
			.trim()
			.replace(/^(["'])(.*)\1$/, '$2');
		if (v.split(',').every((e) => e.trim() === '')) return 'yes';
		return kubo() === 'none' ? 'yes' : 'no';
	}
	if (kubo() === 'none') return 'yes';
	return unreadable ? 'unknown' : 'no';
}

/** The nodes a run asks, and what it says about the hidden ones. */
export interface NodeChoice {
	readonly nodes: readonly string[];
	/** Lines for the operator: which hidden nodes are in, and why. */
	readonly notes: readonly string[];
	/** The proxies to route hidden nodes through (null: none needed). */
	readonly proxies: { readonly torSocks: string; readonly i2pHttpProxy: string } | null;
}

/**
 * Which nodes to ask. `--node` pins one; `off` keeps to clearnet; `on` asks
 * every hidden node through the configured (or usual) proxies; `auto` (the
 * default) adds the .onion nodes when Tor answers here and the .b32.i2p ones
 * when i2pd does.
 */
export async function chooseNodes(
	opts: { readonly nodeOverride: string | null; readonly hidden: HiddenMode },
	deps: {
		readonly env?: NodeJS.ProcessEnv;
		readonly detect?: (env: NodeJS.ProcessEnv) => Promise<LocalProxies>;
		/** This box is a hidden-only node (default: {@link hostHiddenOnly}). */
		readonly hostHiddenOnly?: () => boolean;
	} = {}
): Promise<NodeChoice> {
	const env = deps.env ?? process.env;
	const c = proxyCandidates(env);
	const onion = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter(isOnion);
	const i2p = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter(isI2p);
	const hiddenOnly = (deps.hostHiddenOnly ?? (() => hostHiddenOnly({ env }) === 'yes'))();
	// The proxies this machine really has: the same look at Tor's two usual
	// ports (the tor service, Tor Browser) for every mode that needs them.
	const look = async (): Promise<LocalProxies> => {
		try {
			return await (deps.detect ?? ((e) => detectLocalProxies(e)))(env);
		} catch {
			return { tor: null, i2p: null };
		}
	};
	if (opts.nodeOverride !== null && opts.nodeOverride !== '') {
		const hidden = isHidden(opts.nodeOverride);
		if (!hidden && hiddenOnly)
			throw new Error(
				`${opts.nodeOverride} is a clearnet node, and this server is hidden-only (its indexer.env has no clearnet RPC nodes): it is not asked. Name a .onion or .b32.i2p node.`
			);
		if (!hidden) return { nodes: [opts.nodeOverride], notes: [], proxies: null };
		const found = await look();
		const tor = found.tor ?? c.tor[0]!;
		const i2pp = found.i2p ?? c.i2p[0]!;
		const via = isOnion(opts.nodeOverride)
			? found.tor !== null
				? `through Tor at ${tor}`
				: `through ${tor} (no Tor answered at ${c.tor.join(', ')}; tried anyway)`
			: found.i2p !== null
				? `through i2pd at ${i2pp}`
				: `through ${i2pp} (no i2pd answered at ${c.i2p.join(', ')}; tried anyway)`;
		return {
			nodes: [opts.nodeOverride],
			notes: [`${opts.nodeOverride} is asked ${via}.`],
			proxies: { torSocks: tor, i2pHttpProxy: i2pp }
		};
	}
	if (opts.hidden === 'off') {
		if (hiddenOnly)
			throw new Error(
				'--no-hidden leaves only clearnet nodes, and this server is hidden-only (its indexer.env has no clearnet RPC nodes): nothing would be asked. Run it without --no-hidden.'
			);
		return {
			nodes: [...DEFAULT_BLURT_RPC_ENDPOINTS],
			notes: [`Hidden nodes: left out (--no-hidden).`],
			proxies: null
		};
	}
	const clearnet = hiddenOnly ? [] : [...DEFAULT_BLURT_RPC_ENDPOINTS];
	const clearnetNote = hiddenOnly
		? [
				'This server is hidden-only (its indexer.env has no clearnet RPC nodes): no clearnet node is asked.'
			]
		: [];
	if (opts.hidden === 'on') {
		const found = await look();
		const tor = found.tor ?? c.tor[0]!;
		const i2pp = found.i2p ?? c.i2p[0]!;
		return {
			nodes: [...clearnet, ...DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS],
			notes: [
				...clearnetNote,
				`Hidden nodes: all ${DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.length} asked (--include-hidden), ` +
					`.onion through ${tor}${found.tor === null ? ` (no Tor answered at ${c.tor.join(', ')})` : ''}, ` +
					`.b32.i2p through ${i2pp}${found.i2p === null ? ` (no i2pd answered at ${c.i2p.join(', ')})` : ''}.`
			],
			proxies: { torSocks: tor, i2pHttpProxy: i2pp }
		};
	}
	const found = await look();
	const notes = [
		...clearnetNote,
		found.tor !== null
			? `Tor on this machine (${found.tor}): the ${onion.length} .onion nodes are asked too.`
			: `No Tor on this machine (looked at ${c.tor.join(', ')}): the ${onion.length} .onion nodes are left out. With Tor running (sudo apt install tor) they are asked too.`,
		found.i2p !== null
			? `I2P on this machine (${found.i2p}): the ${i2p.length} .b32.i2p nodes are asked too.`
			: `No I2P on this machine (looked at ${c.i2p.join(', ')}): the ${i2p.length} .b32.i2p nodes are left out. With i2pd running (sudo apt install i2pd) they are asked too.`
	];
	const nodes = [
		...clearnet,
		...(found.tor !== null ? onion : []),
		...(found.i2p !== null ? i2p : [])
	];
	return {
		nodes,
		notes,
		proxies:
			found.tor !== null || found.i2p !== null
				? { torSocks: found.tor ?? '', i2pHttpProxy: found.i2p ?? '' }
				: null
	};
}

/** Ask one node for its head, bounded. */
export async function probeNode(url: string, timeoutMs: number): Promise<NodeHealth> {
	const started = Date.now();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'condenser_api.get_dynamic_global_properties',
				params: []
			}),
			redirect: 'manual',
			signal: ctrl.signal
		});
		const text = await res.text();
		if (!res.ok)
			return {
				url,
				ok: false,
				ms: Date.now() - started,
				headBlock: null,
				reason: `HTTP ${res.status}`
			};
		const j = JSON.parse(text.length > 1_000_000 ? '{}' : text) as {
			result?: { head_block_number?: unknown; head_block_id?: unknown; time?: unknown };
		};
		const r = j.result;
		if (
			typeof r?.head_block_number !== 'number' ||
			typeof r.head_block_id !== 'string' ||
			typeof r.time !== 'string'
		) {
			return {
				url,
				ok: false,
				ms: Date.now() - started,
				headBlock: null,
				reason: 'malformed answer'
			};
		}
		return {
			url,
			ok: true,
			ms: Date.now() - started,
			headBlock: r.head_block_number,
			props: {
				head_block_number: r.head_block_number,
				head_block_id: r.head_block_id,
				time: r.time
			}
		};
	} catch (e) {
		return {
			url,
			ok: false,
			ms: Date.now() - started,
			headBlock: null,
			reason: ctrl.signal.aborted ? `no answer in ${timeoutMs} ms` : errMsg(e)
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probe every candidate in parallel and rank them: answering nodes within
 * three blocks of the highest head first (fastest first), then answering but
 * behind, then silent ones (kept last, still tried).
 */
export async function rankNodes(
	urls: readonly string[],
	opts: {
		readonly clearnetTimeoutMs?: number;
		readonly hiddenTimeoutMs?: number;
		/** Once a node has answered, how long the others still get (default:
		 *  everyone gets their full timeout). A node still silent then is
		 *  ranked last and still tried. */
		readonly graceMs?: number;
		readonly probe?: (url: string, timeoutMs: number) => Promise<NodeHealth>;
		readonly now?: () => number;
	} = {}
): Promise<NodeHealth[]> {
	const probe = opts.probe ?? probeNode;
	const now = opts.now ?? Date.now;
	const started = now();
	const got: (NodeHealth | undefined)[] = new Array(urls.length);
	await new Promise<void>((resolve) => {
		let pending = urls.length;
		let grace: ReturnType<typeof setTimeout> | null = null;
		const done = (): void => {
			if (grace !== null) clearTimeout(grace);
			resolve();
		};
		if (pending === 0) return done();
		urls.forEach((u, i) => {
			const limit = isHidden(u)
				? (opts.hiddenTimeoutMs ?? 20_000)
				: (opts.clearnetTimeoutMs ?? 5_000);
			void probe(u, limit)
				.catch(
					(e: unknown): NodeHealth => ({
						url: u,
						ok: false,
						ms: now() - started,
						headBlock: null,
						reason: errMsg(e)
					})
				)
				.then((h) => {
					got[i] = h;
					pending--;
					if (pending === 0) return done();
					if (h.ok && grace === null && opts.graceMs !== undefined)
						grace = setTimeout(done, opts.graceMs);
				});
		});
	});
	const all: NodeHealth[] = urls.map(
		(u, i) =>
			got[i] ?? {
				url: u,
				ok: false,
				ms: now() - started,
				headBlock: null,
				reason: `no answer in ${Math.round((now() - started) / 1000)} s (tried last)`
			}
	);
	const best = Math.max(0, ...all.map((h) => h.headBlock ?? 0));
	const tier = (h: NodeHealth): number => (!h.ok ? 2 : best - (h.headBlock ?? 0) <= 3 ? 0 : 1);
	return [...all].sort((a, b) => tier(a) - tier(b) || a.ms - b.ms);
}

export interface BroadcastResult {
	readonly trxId: string;
	readonly via: string;
	readonly blockNum: number | null;
	/** The node said the transaction was already known: an earlier attempt landed. */
	readonly duplicate: boolean;
	/** Another node that has the transaction in block `blockNum`; null when no
	 *  second node could confirm it (check a block explorer before announcing). */
	readonly confirmedBy: string | null;
}

/** What `condenser_api.get_block` says about one block (null: no such block yet). */
export type BlockLookup = (
	url: string,
	num: number
) => Promise<{ block_id?: string; transaction_ids?: string[] } | null>;

async function getBlockOnce(
	url: string,
	num: number
): Promise<{ block_id?: string; transaction_ids?: string[] } | null> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 10_000);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'condenser_api.get_block',
				params: [num]
			}),
			redirect: 'manual',
			signal: ctrl.signal
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const j = (await res.json()) as {
			result?: { block_id?: string; transaction_ids?: string[] } | null;
		};
		return j.result ?? null;
	} finally {
		clearTimeout(t);
	}
}

/**
 * The node whose head the transaction is built on (TaPoS), confirmed by a
 * second node: one that reports the same head, or returns the same block id
 * for that height. A single lying node can otherwise hand out a made-up head
 * (the transaction is then invalid on the real chain) and claim it accepted it.
 */
async function confirmedBase(
	ranked: readonly NodeHealth[],
	getBlock: BlockLookup,
	log: (l: string) => void
): Promise<NodeHealth> {
	const live = ranked.filter((h) => h.ok && h.props !== undefined);
	if (live.length === 0) throw new Error('no RPC node answered — nothing was signed or broadcast');
	if (live.length === 1) {
		log(`Only ${live[0]!.url} answered: its head is not cross-checked by a second node.`);
		return live[0]!;
	}
	for (const base of live) {
		const p = base.props!;
		for (const other of live) {
			if (other.url === base.url) continue;
			if (other.props!.head_block_number === p.head_block_number) {
				if (other.props!.head_block_id === p.head_block_id) return base;
				continue;
			}
			if (other.props!.head_block_number < p.head_block_number) continue;
			try {
				if ((await getBlock(other.url, p.head_block_number))?.block_id === p.head_block_id)
					return base;
			} catch {
				/* that node cannot confirm; try another */
			}
		}
		log(
			`  ${base.url}: its head block ${p.head_block_number} is not confirmed by another node — not used.`
		);
	}
	throw new Error('no head block was confirmed by two nodes — nothing was signed or broadcast');
}

/** Another node that has `trxId` in block `num` (a few tries while it catches up). */
async function confirmIncluded(
	ranked: readonly NodeHealth[],
	via: string,
	trxId: string,
	num: number,
	getBlock: BlockLookup,
	sleep: (ms: number) => Promise<void>
): Promise<string | null> {
	const others = ranked.filter((h) => h.ok && h.url !== via).map((h) => h.url);
	for (let attempt = 0; attempt < 5 && others.length > 0; attempt++) {
		let pending = false;
		for (const u of others) {
			try {
				const b = await getBlock(u, num);
				if (b === null) pending = true;
				else if ((b.transaction_ids ?? []).includes(trxId)) return u;
			} catch {
				/* unreachable: not a confirmation */
			}
		}
		if (!pending) return null;
		await sleep(3_000);
	}
	return null;
}

/** Look a transaction up by id on one node: its block, or null when the node
 *  does not have it (yet). */
export type TxLookup = (
	url: string,
	trxId: string
) => Promise<{ block_num?: number; transaction_id?: string } | null>;

async function getTxOnce(
	url: string,
	trxId: string
): Promise<{ block_num?: number; transaction_id?: string } | null> {
	const ctrl = new AbortController();
	// A hidden node answers over Tor/I2P: give it the probe's 20 s.
	const t = setTimeout(
		() => ctrl.abort(),
		/\.(onion|i2p)(:\d+)?(\/|$)/i.test(url) ? 20_000 : 10_000
	);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'condenser_api.get_transaction',
				params: [trxId]
			}),
			redirect: 'manual',
			signal: ctrl.signal
		});
		if (!res.ok) return null;
		const j = (await res.json()) as {
			result?: { block_num?: number; transaction_id?: string } | null;
		};
		return j.result ?? null;
	} finally {
		clearTimeout(t);
	}
}

/**
 * Another node that has `trxId`, found by the id itself, then checked in the
 * block's contents. Every real broadcast needs this: dblurt's `send` uses the
 * asynchronous broadcast_transaction, which answers without a block number
 * (the snapshot anchor of 2026-10-07 printed "NOT confirmed by a second node"
 * for a transaction that was in block 64,290,997).
 *
 * An answer counts only when it names exactly this id and a block the
 * transaction can be in (after the head it was built on, before it expires),
 * and then a node other than the one that answered — when there is one — must
 * list the id in that block (confirmIncluded). Alongside, the new blocks are
 * read from the other nodes in order (from the block after that head, up to
 * the last block it can be in): a block one of them serves that lists the id
 * is a second node's confirmation at once, without waiting for the look-up by
 * id. The other nodes are asked in parallel each round, a line per round,
 * until the transaction has expired plus two blocks.
 */
async function confirmById(
	ranked: readonly NodeHealth[],
	via: string,
	trxId: string,
	baseHead: number,
	getTx: TxLookup,
	getBlock: BlockLookup,
	sleep: (ms: number) => Promise<void>,
	now: () => number,
	log: (l: string) => void
): Promise<{ url: string; blockNum: number } | null> {
	const others = ranked.filter((h) => h.ok && h.url !== via).map((h) => h.url);
	if (others.length === 0) return null;
	const lastBlock = baseHead + Math.ceil(EXPIRE_MS / 3_000) + 2;
	const giveUpAt = now() + EXPIRE_MS + 6_000;
	// 2026-10-08 (v1.21.2 release broadcast): the transaction was in block
	// 64,311,469 about 12 s after it was sent, but the nodes' look-up by id
	// found it only after about 55 s, close to the 66 s this waits. So the new
	// blocks themselves are read too, from the other nodes, one by one from the
	// block after the head it was built on: a block that lists the id IS the
	// second node's confirmation, as soon as that block exists.
	let nextScan = baseHead + 1;
	const scanBlocks = async (): Promise<{ url: string; blockNum: number } | null> => {
		while (nextScan <= lastBlock) {
			let seen = false;
			for (const u of others) {
				let b: Awaited<ReturnType<BlockLookup>> = null;
				try {
					b = await getBlock(u, nextScan);
				} catch {
					b = null;
				}
				if (b === null) continue;
				seen = true;
				if ((b.transaction_ids ?? []).includes(trxId)) return { url: u, blockNum: nextScan };
				break;
			}
			// No other node has this block yet: it has not been produced.
			if (!seen) return null;
			nextScan++;
		}
		return null;
	};
	for (let round = 1; now() < giveUpAt; round++) {
		const [answers, inBlock] = await Promise.all([
			Promise.all(
				others.map(async (u) => {
					try {
						return { u, t: await getTx(u, trxId) };
					} catch {
						return { u, t: null };
					}
				})
			),
			scanBlocks()
		]);
		if (inBlock !== null) return inBlock;
		for (const { u, t } of answers) {
			const num = t?.block_num;
			if (
				t === null ||
				t === undefined ||
				t.transaction_id !== trxId ||
				typeof num !== 'number' ||
				num <= baseHead ||
				num > lastBlock
			)
				continue;
			// The block's contents, on a node other than the one that answered
			// when there is one, else on that one.
			const checkOn = ranked.filter((h) => h.url !== u);
			const by =
				(await confirmIncluded(checkOn, via, trxId, num, getBlock, sleep)) ??
				(await confirmIncluded(
					ranked.filter((h) => h.url === u),
					'',
					trxId,
					num,
					getBlock,
					sleep
				));
			if (by !== null) return { url: by, blockNum: num };
		}
		const read =
			nextScan - 1 > baseHead
				? ` (read blocks ${baseHead + 1}–${nextScan - 1})`
				: ' (no new block yet)';
		log(`  round ${round}: no other node has ${trxId} in a block yet${read} …`);
		await sleep(3_000);
	}
	return null;
}

/** The dblurt default: 60 s from the head the transaction is built on. */
const EXPIRE_MS = 60_000;

/**
 * Build ONE transaction from the best node's head, sign it ONCE, and hand that
 * exact transaction to the ranked nodes in turn.
 */
export async function signOnceAndBroadcast(
	ops: Parameters<Client['broadcast']['sendOperations']>[0],
	key: PrivateKey,
	ranked: readonly NodeHealth[],
	opts: {
		readonly send?: (url: string, signed: unknown) => Promise<{ block_num?: number }>;
		readonly log?: (line: string) => void;
		readonly now?: () => number;
		readonly getBlock?: BlockLookup;
		readonly getTx?: TxLookup;
		readonly sleep?: (ms: number) => Promise<void>;
	} = {}
): Promise<BroadcastResult> {
	const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
	const now = opts.now ?? Date.now;
	const getBlock = opts.getBlock ?? getBlockOnce;
	const getTx = opts.getTx ?? getTxOnce;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const base = await confirmedBase(ranked, getBlock, log);
	const p = base.props!;
	const tx = {
		ref_block_num: p.head_block_number & 0xffff,
		ref_block_prefix: Buffer.from(p.head_block_id, 'hex').readUInt32LE(4),
		expiration: new Date(new Date(`${p.time}Z`).getTime() + EXPIRE_MS).toISOString().slice(0, -5),
		operations: ops,
		extensions: []
	};
	const signed = new Client(base.url).broadcast.sign(tx as never, key);
	const trxId = cryptoUtils.generateTrxId(tx as never);
	const expiresAt = now() + EXPIRE_MS - 5_000;
	log(`Signed once — transaction ${trxId} (built on ${base.url}, block ${p.head_block_number}).`);
	const send =
		opts.send ??
		((url: string, s: unknown) =>
			new Client(url, { timeout: 20_000 }).broadcast.send(s as never) as Promise<{
				block_num?: number;
			}>);
	let lastErr: unknown = null;
	for (const h of ranked) {
		if (now() > expiresAt) {
			throw new Error(
				`transaction ${trxId} expired before any node confirmed it. Do NOT re-run blindly: an earlier ` +
					`node may have accepted it with its answer lost. Look the id up on a block explorer first; ` +
					`re-run only if it is absent. Last error: ${errMsg(lastErr)}`
			);
		}
		log(`Broadcasting via ${h.url} …`);
		try {
			const conf = await send(h.url, signed);
			let blockNum = conf.block_num ?? null;
			let confirmedBy: string | null = null;
			if (blockNum !== null) {
				confirmedBy = await confirmIncluded(ranked, h.url, trxId, blockNum, getBlock, sleep);
			} else {
				log(`  ${h.url} accepted it without a block number; asking the other nodes for ${trxId} …`);
				const found = await confirmById(
					ranked,
					h.url,
					trxId,
					p.head_block_number,
					getTx,
					getBlock,
					sleep,
					now,
					log
				);
				if (found !== null) {
					confirmedBy = found.url;
					blockNum = found.blockNum;
				}
			}
			log(
				confirmedBy !== null
					? `Confirmed: ${confirmedBy} has transaction ${trxId} in block ${blockNum}.`
					: `NOT confirmed by a second node: ${h.url} said it accepted ${trxId}${blockNum !== null ? ` (block ${blockNum})` : ''}. Look the id up on a block explorer before announcing it.`
			);
			return { trxId, via: h.url, blockNum, duplicate: false, confirmedBy };
		} catch (e) {
			if (/duplicate/i.test(errMsg(e))) {
				log(`  ${h.url}: already has it — an earlier attempt was accepted; looking up its block …`);
				const found = await confirmById(
					ranked,
					h.url,
					trxId,
					p.head_block_number,
					getTx,
					getBlock,
					sleep,
					now,
					log
				);
				if (found === null) {
					log(`  Look ${trxId} up on a block explorer to see its block.`);
				} else {
					log(`Confirmed: ${found.url} has transaction ${trxId} in block ${found.blockNum}.`);
				}
				return {
					trxId,
					via: h.url,
					blockNum: found?.blockNum ?? null,
					duplicate: true,
					confirmedBy: found?.url ?? null
				};
			}
			lastErr = e;
			log(`  ✗ ${h.url}: ${errMsg(e)}`);
		}
	}
	throw new Error(
		`no node took transaction ${trxId}. Check a block explorer for that id before running again. ` +
			`Last error: ${errMsg(lastErr)}`
	);
}

/** Route .onion / .i2p through the local proxies (clearnet stays direct). */
export async function enableHiddenTransport(proxies?: {
	readonly torSocks: string;
	readonly i2pHttpProxy: string;
}): Promise<void> {
	const { hiddenServiceProxyConfigFromEnv } = await import('@morphit/hidden-transport');
	const { installHiddenServiceDispatcher } = await import('@morphit/hidden-transport/router');
	const fromEnv = hiddenServiceProxyConfigFromEnv(process.env);
	installHiddenServiceDispatcher(proxies ? { ...fromEnv, ...proxies } : fromEnv, 'allow');
}

/**
 * Choose the nodes for a run (chooseNodes), say which hidden ones are in, and
 * route those through this machine's proxies. Every laptop broadcast script
 * calls this once and hands the result to the broadcast and to the history
 * wait.
 */
export async function prepareNodes(
	opts: { readonly nodeOverride: string | null; readonly hidden: HiddenMode },
	err: NodeJS.WritableStream = process.stderr,
	deps: {
		readonly choose?: typeof chooseNodes;
		readonly enable?: typeof enableHiddenTransport;
		/** How the run ends when no node may be asked (default process.exit). */
		readonly exit?: (code: number) => never;
	} = {}
): Promise<readonly string[]> {
	if (opts.hidden === 'auto' && opts.nodeOverride === null)
		err.write('\nLooking for Tor and I2P on this machine …\n');
	let choice: NodeChoice;
	try {
		choice = await (deps.choose ?? chooseNodes)(opts);
	} catch (e) {
		// A choice that would break this box's own rules (a clearnet node on a
		// hidden-only server): said plainly, nothing asked, no stack trace.
		err.write(`\n✗ ${errMsg(e)}\n  Nothing was signed or sent.\n`);
		return (deps.exit ?? ((c: number) => process.exit(c)))(1);
	}
	for (const n of choice.notes) err.write(`  ${n}\n`);
	if (choice.proxies !== null) await (deps.enable ?? enableHiddenTransport)(choice.proxies);
	return choice.nodes;
}

/** `--no-hidden` / `--include-hidden` / neither (auto), from argv. */
export function hiddenModeFromArgs(argv: readonly string[]): HiddenMode {
	if (argv.includes('--no-hidden')) return 'off';
	if (argv.includes('--include-hidden')) return 'on';
	return 'auto';
}

/** A braille spinner on a terminal while `work` runs; nothing otherwise. */
async function withSpinner<T>(label: string, work: Promise<T>): Promise<T> {
	const out = process.stderr;
	if (!out.isTTY) {
		out.write(`${label}\n`);
		return work;
	}
	const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
	let i = 0;
	out.write(`${frames[0]} ${label}`);
	const t = setInterval(() => out.write(`\r${frames[++i % frames.length]} ${label}`), 100);
	try {
		return await work;
	} finally {
		clearInterval(t);
		out.write(`\r\x1b[2K${label}\n`);
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * The whole flow for one custom_json op, as every laptop broadcast script runs
 * it: pick candidates, rank them (saying so before the wait), sign once,
 * broadcast. Prints progress to stderr; returns the result for the script's
 * own success message.
 */
export async function broadcastCustomJsonOnce(
	opData: { required_auths: string[]; required_posting_auths: string[]; id: string; json: string },
	key: PrivateKey,
	opts: { readonly nodes: readonly string[] }
): Promise<BroadcastResult> {
	const nodes = opts.nodes;
	const hidden = nodes.filter(isHidden).length;
	const label =
		`Checking ${nodes.length} RPC node${nodes.length === 1 ? '' : 's'}` +
		(hidden > 0 ? ` (${nodes.length - hidden} clearnet, ${hidden} hidden)` : '') +
		` …`;
	process.stderr.write('\n');
	// Hidden nodes answer over Tor/I2P in seconds; a dead one would hold the
	// ranking for its full 20 s. Once one node has answered, the others get
	// eight more seconds.
	const ranked = await withSpinner(label, rankNodes(nodes, hidden > 0 ? { graceMs: 8_000 } : {}));
	for (const h of ranked) {
		process.stderr.write(
			`  ${h.ok ? '✓' : '✗'} ${h.url}  ${h.ok ? `block ${h.headBlock}, ${h.ms} ms` : (h.reason ?? 'no answer')}\n`
		);
	}
	return signOnceAndBroadcast([['custom_json', opData]] as never, key, ranked);
}

/**
 * Ask for a secret at the terminal without echoing it (the WIF never appears
 * on screen or in a terminal log). The prompt goes to stderr.
 *
 * The prompt always ENDS WITH A NEWLINE. On a terminal, readline moves the
 * cursor to column 1 and clears to the end of the screen right after the
 * prompt is written; a prompt the cursor still sat on was erased the moment it
 * appeared (indexer-snapshot-broadcast, 2026-10-07: "it never asked me for my
 * key", and what was typed next was read as the key). The key is then typed
 * on the line below it.
 *
 * `io` is for tests (a TTY-shaped stream pair); the default is the terminal.
 */
export function askHidden(
	query: string,
	io: {
		readonly input?: NodeJS.ReadableStream;
		readonly output?: NodeJS.WritableStream;
		readonly err?: NodeJS.WritableStream;
	} = {}
): Promise<string> {
	const err = io.err ?? process.stderr;
	err.write(query.endsWith('\n') ? query : `${query}\n`);
	return new Promise((resolve) => {
		const rl = createInterface({
			input: io.input ?? process.stdin,
			// readline's own cursor codes go where the prompt goes, never into
			// stdout (which a caller may redirect to a file).
			output: io.output ?? process.stderr,
			terminal: true
		});
		// Suppress all keystroke echo so the WIF never appears on screen.
		(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
		let answered = false;
		rl.question('', (ans) => {
			answered = true;
			rl.close();
			err.write('\n');
			resolve(ans.trim());
		});
		// Input closed before a line (stdin at EOF, e.g. `< /dev/null`): no key —
		// the caller's "no key" path runs, instead of the process just ending.
		rl.once('close', () => {
			if (!answered) resolve('');
		});
	});
}

/**
 * Read a posting WIF from a key file for an unattended run. Refuses a file
 * other users can read or write (the key would be exposed) and anything that
 * is not a WIF. (A key in an environment variable shows in /proc/<pid>/environ
 * and `ps e`; a key file does not.)
 */
export function readWifFile(path: string): string {
	const st = statSync(path);
	if ((st.mode & 0o077) !== 0) {
		throw new Error(
			`key file ${path} is readable or writable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`
		);
	}
	const wif = readFileSync(path, 'utf8').trim();
	if (!/^5[1-9A-HJ-NP-Za-km-z]{50}$/.test(wif))
		throw new Error(`key file ${path} does not hold a Blurt WIF`);
	return wif;
}
