/**
 * Morphit indexer — the XMR fee explorers (v1.20.0, wave 4). One list for the
 * config default (MORPHIT_INDEXER_XMR_EXPLORER_URLS), the verifier's own
 * default and the ops-cli wizard.
 *
 * Two kinds:
 *   `https://…`         an onion-monero-blockchain-explorer instance with its
 *                       JSON API on (`/api/outputs?…&txprove=1`,
 *                       `/api/transaction/<txid>`);
 *   `raw-tx+https://…`  an explorer serving RAW transactions in the
 *                       moneroblocks.info API shape
 *                       (`/api/get_transaction_data/<txid>`,
 *                       `/api/get_block_data/<height>`, tx page `/tx/<txid>`);
 *                       the payment is verified locally (fee/xmrRawTx.ts).
 *
 * Checked live on 2026-09-28 (see docs/OPERATIONS.md §40.4 for the evidence):
 * xmrchain.net and moneroexplorer.org answer the onion-explorer API;
 * moneroblocks.info serves raw transactions. Dropped: localmonero.co/blocks
 * (redirects to moneroblocks.info, a different API), monerohash.com/explorer
 * (explorer UI, JSON API off: /api/* → 404), exploremonero.com (JavaScript
 * front end: /api/* returns its HTML shell).
 */
export const DEFAULT_XMR_EXPLORERS: readonly string[] = [
	'https://xmrchain.net',
	'https://moneroexplorer.org',
	'raw-tx+https://moneroblocks.info'
];

export type XmrExplorerKind = 'txprove' | 'raw-tx';

/** `https://host[/path]` → txprove; `raw-tx+https://host[/path]` → raw-tx.
 *  Null for anything that is not HTTPS (the tx key must never travel in
 *  cleartext). */
export function parseXmrExplorer(spec: string): { kind: XmrExplorerKind; base: string } | null {
	const s = spec.trim();
	const raw = s.startsWith('raw-tx+');
	const url = raw ? s.slice('raw-tx+'.length) : s;
	if (!url.startsWith('https://')) return null;
	try {
		new URL(url);
	} catch {
		return null;
	}
	return { kind: raw ? 'raw-tx' : 'txprove', base: url.replace(/\/+$/, '') };
}

/** The comma-separated env value, split; null if any entry is not valid. */
export function parseXmrExplorerList(raw: string): string[] | null {
	const list = raw
		.split(',')
		.map((u) => u.trim())
		.filter((u) => u.length > 0);
	return list.every((u) => parseXmrExplorer(u) !== null) ? list : null;
}
