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
 * HIDDEN NODES ARE OPT-IN (`--include-hidden`). These scripts run on the maintainer's
 * LAPTOP (Block 5 of the release ceremony), which may have no Tor or i2pd; a
 * default that waited on fourteen hidden nodes would slow every run for
 * nothing. With the flag, the node's Tor SOCKS / i2pd proxy settings are read
 * from the usual env names and hidden nodes are ranked alongside clearnet.
 * `--node <url>` still pins exactly one node (backward compatible).
 */
import { readFileSync, statSync } from 'node:fs';
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
		readonly probe?: (url: string, timeoutMs: number) => Promise<NodeHealth>;
	} = {}
): Promise<NodeHealth[]> {
	const probe = opts.probe ?? probeNode;
	const all = await Promise.all(
		urls.map((u) =>
			probe(u, isHidden(u) ? (opts.hiddenTimeoutMs ?? 20_000) : (opts.clearnetTimeoutMs ?? 5_000))
		)
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
		readonly sleep?: (ms: number) => Promise<void>;
	} = {}
): Promise<BroadcastResult> {
	const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
	const now = opts.now ?? Date.now;
	const getBlock = opts.getBlock ?? getBlockOnce;
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
			const blockNum = conf.block_num ?? null;
			const confirmedBy =
				blockNum === null
					? null
					: await confirmIncluded(ranked, h.url, trxId, blockNum, getBlock, sleep);
			log(
				confirmedBy !== null
					? `Confirmed: ${confirmedBy} has transaction ${trxId} in block ${blockNum}.`
					: `NOT confirmed by a second node: ${h.url} said it accepted ${trxId}${blockNum !== null ? ` (block ${blockNum})` : ''}. Look the id up on a block explorer before announcing it.`
			);
			return { trxId, via: h.url, blockNum, duplicate: false, confirmedBy };
		} catch (e) {
			if (/duplicate/i.test(errMsg(e))) {
				log(
					`  ${h.url}: already has it — an earlier attempt was accepted. Look ${trxId} up on a block explorer to see its block.`
				);
				return { trxId, via: h.url, blockNum: null, duplicate: true, confirmedBy: null };
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

/** When hidden nodes are included, route .onion / .i2p through the local proxies. */
export async function enableHiddenTransport(): Promise<void> {
	const { hiddenServiceProxyConfigFromEnv } = await import('@morphit/hidden-transport');
	const { installHiddenServiceDispatcher } = await import('@morphit/hidden-transport/router');
	installHiddenServiceDispatcher(hiddenServiceProxyConfigFromEnv(process.env), 'allow');
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
	opts: { readonly nodeOverride: string | null; readonly includeHidden: boolean }
): Promise<BroadcastResult> {
	const nodes = candidateNodes(opts);
	if (opts.includeHidden || nodes.some(isHidden)) await enableHiddenTransport();
	process.stderr.write(
		`\nChecking ${nodes.length} RPC node${nodes.length === 1 ? '' : 's'} ` +
			`(up to ${nodes.some(isHidden) ? '20' : '5'} s) …\n`
	);
	const ranked = await rankNodes(nodes);
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
 */
export function askHidden(query: string): Promise<string> {
	process.stderr.write(query);
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
		rl.question('', (ans) => {
			rl.close();
			process.stderr.write('\n');
			resolve(ans.trim());
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
