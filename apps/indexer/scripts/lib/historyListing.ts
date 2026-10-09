/**
 * After a release broadcast: wait until the nodes LIST the transaction in the
 * signer's account history, which is where every server's upgrade looks for
 * the release record.
 *
 * WHY. Block 4 confirmed the transaction was in a block, and the ceremony moved
 * on to Block 5. But a block is not yet the account history: a node lists an op
 * there a little later, and a node behind the chain lists it later still. The
 * upgrade on morphit.io read one node's history moments after the v1.21.3
 * broadcast, did not find the record, and refused; the same command a minute
 * later went through (2026-10-08). Upgrades from v1.21.4 on ask every node and
 * wait for it; this wait is what keeps the upgraders already installed (which
 * believe the first answer) from refusing.
 *
 * Every dependency is injectable (test/scripts/historyListing.test.ts).
 */

/** One condenser read against one node. */
export type NodeCall = (
	url: string,
	method: string,
	params: readonly unknown[]
) => Promise<unknown>;

export interface ListingResult {
	/** Nodes whose history lists the transaction. */
	readonly listed: string[];
	/** Nodes that answered but do not list it (yet). */
	readonly notListed: string[];
	/** Nodes that never answered. */
	readonly silent: string[];
	/** True when every node that answered lists it (and at least one answered). */
	readonly complete: boolean;
}

/** Does this history answer hold transaction `trxId`? */
export function historyLists(history: unknown, trxId: string): boolean {
	if (!Array.isArray(history)) return false;
	return history.some(
		(e) =>
			Array.isArray(e) &&
			e[1] !== null &&
			typeof e[1] === 'object' &&
			(e[1] as { trx_id?: unknown }).trx_id === trxId
	);
}

/** JSON-RPC over fetch, with its own timeout. */
export async function fetchNodeCall(
	url: string,
	method: string,
	params: readonly unknown[]
): Promise<unknown> {
	const r = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `condenser_api.${method}`, params }),
		signal: AbortSignal.timeout(10_000)
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const j = (await r.json()) as { result?: unknown; error?: unknown };
	if (j.error !== undefined && j.error !== null) throw new Error(JSON.stringify(j.error));
	return j.result;
}

/**
 * Ask every node for `account`'s newest history until each node that answers
 * lists `trxId`, or `waitMs` has passed. Never throws.
 */
export async function waitForHistoryListing(opts: {
	readonly nodes: readonly string[];
	readonly account: string;
	readonly trxId: string;
	readonly call?: NodeCall;
	readonly waitMs?: number;
	readonly intervalMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}): Promise<ListingResult> {
	const call = opts.call ?? fetchNodeCall;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
	const interval = opts.intervalMs ?? 5_000;
	const until = now() + (opts.waitMs ?? 300_000);
	const everAnswered = new Set<string>();
	// A node's history never un-lists an op: one that listed it once has it,
	// even if it stops answering afterwards.
	const everListed = new Set<string>();
	let last: ListingResult = { listed: [], notListed: [], silent: [...opts.nodes], complete: false };
	for (let round = 1; ; round++) {
		const answers = await Promise.all(
			opts.nodes.map(async (url) => {
				try {
					return {
						url,
						lists: historyLists(
							await call(url, 'get_account_history', [opts.account, -1, 100]),
							opts.trxId
						)
					};
				} catch {
					return { url, lists: null };
				}
			})
		);
		for (const a of answers) {
			if (a.lists !== null) everAnswered.add(a.url);
			if (a.lists === true) everListed.add(a.url);
		}
		const listed = opts.nodes.filter((u) => everListed.has(u));
		// A node that answered without it, and has not listed it since, is still
		// waited for even when it is quiet this round: it may be the one a
		// server's indexer reads from.
		const notListed = opts.nodes.filter((u) => everAnswered.has(u) && !everListed.has(u));
		const silent = opts.nodes.filter((u) => !everAnswered.has(u));
		last = { listed, notListed, silent, complete: listed.length > 0 && notListed.length === 0 };
		if (last.complete) return last;
		log(
			`  round ${round}: ${listed.length} of ${listed.length + notListed.length} node(s) list it in @${opts.account}'s history …`
		);
		if (now() + interval > until) return last;
		await sleep(interval);
	}
}
