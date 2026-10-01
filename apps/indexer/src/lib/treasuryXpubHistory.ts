/**
 * v1.20.2 — the treasury BTC key must be a FRESH account: no receive address
 * of it may ever have received anything.
 *
 * WHY. Each BTC-fee order gets the next receive address of the pinned key
 * (`<key>/0/n`, n = 0, 1, 2 … in order — btcFeeAddressIndex.ts), and an order
 * is paid when its address has received the fee: the explorers' all-time
 * received total (`chain_stats.funded_txo_sum`, bitcoinExplorerVerifier.ts).
 * An address that already received coins before the pin would make the order
 * that gets it look paid without a payment. The first real run (2026-10-01)
 * pasted the key of the account that holds the shared treasury address: that
 * address is its receive #15, and #0–#15 had all been used.
 *
 * WHAT. Ask the same public explorers the indexers use (Esplora:
 * `<base>/address/<addr>`) about receive #0 … #(gap − 1), the gap every wallet
 * scans before it decides an account is empty (20). The first address with any
 * transaction, confirmed or in the mempool, refuses the key. An address that no
 * explorer answers for leaves the key UNCHECKED, never "fresh".
 */

export const HISTORY_GAP = 20;
export const DEFAULT_HISTORY_EXPLORERS: readonly string[] = [
	'https://blockstream.info/api',
	'https://mempool.space/api'
];

export type XpubHistoryScan =
	| { readonly kind: 'fresh'; readonly checked: number }
	| {
			readonly kind: 'used';
			readonly index: number;
			readonly address: string;
			readonly txCount: number;
			readonly explorer: string;
	  }
	| { readonly kind: 'unchecked'; readonly index: number; readonly address: string };

interface EsploraStats {
	readonly tx_count?: unknown;
	readonly funded_txo_count?: unknown;
}

/** Transactions an Esplora `/address/<a>` answer reports, or null if it is not one. PURE. */
export function esploraTxCount(body: unknown, address: string): number | null {
	if (typeof body !== 'object' || body === null) return null;
	const b = body as { address?: unknown; chain_stats?: unknown; mempool_stats?: unknown };
	if (typeof b.address === 'string' && b.address !== address) return null;
	const count = (s: unknown): number | null => {
		if (typeof s !== 'object' || s === null) return null;
		const t = (s as EsploraStats).tx_count;
		const f = (s as EsploraStats).funded_txo_count;
		if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) return null;
		if (f !== undefined && (typeof f !== 'number' || !Number.isInteger(f) || f < 0)) return null;
		return Math.max(t, typeof f === 'number' ? f : 0);
	};
	const chain = count(b.chain_stats);
	const pool = count(b.mempool_stats);
	if (chain === null || pool === null) return null;
	return chain + pool;
}

export interface HistoryScanOptions {
	readonly explorers?: readonly string[];
	readonly gap?: number;
	readonly fetchImpl?: typeof fetch;
	readonly timeoutMs?: number;
	/** One line per address checked (progress). */
	readonly progress?: (index: number, address: string) => void;
}

/**
 * Check receive #0 … #(gap − 1). `addressAt(n)` derives receive #n. For each
 * address the explorers are asked in order until one gives a well-formed
 * answer.
 */
export async function scanXpubHistory(
	addressAt: (index: number) => string,
	opts: HistoryScanOptions = {}
): Promise<XpubHistoryScan> {
	const explorers = (opts.explorers ?? DEFAULT_HISTORY_EXPLORERS).map((e) => e.replace(/\/+$/, ''));
	const gap = opts.gap ?? HISTORY_GAP;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 15_000;
	for (let i = 0; i < gap; i++) {
		const address = addressAt(i);
		opts.progress?.(i, address);
		let answered = false;
		for (const base of explorers) {
			let n: number | null = null;
			try {
				const res = await fetchImpl(`${base}/address/${address}`, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(timeoutMs)
				});
				if (!res.ok) continue;
				n = esploraTxCount(await res.json(), address);
			} catch {
				continue;
			}
			if (n === null) continue;
			answered = true;
			if (n > 0) return { kind: 'used', index: i, address, txCount: n, explorer: base };
			break;
		}
		if (!answered) return { kind: 'unchecked', index: i, address };
	}
	return { kind: 'fresh', checked: gap };
}
