/**
 * Morphit indexer — the XMR fee explorers (v1.20.0, wave 4; v1.20.2). One list
 * for the config default (MORPHIT_INDEXER_XMR_EXPLORER_URLS), the verifier's
 * own default, the ops-cli wizard and the upgrade's list heal.
 *
 * Three kinds:
 *   `https://…`         an onion-monero-blockchain-explorer instance with its
 *                       JSON API on (`/api/outputs?…&txprove=1`,
 *                       `/api/transaction/<txid>`);
 *   `raw-tx+https://…`  an explorer serving RAW transactions in the
 *                       moneroblocks.info API shape
 *                       (`/api/get_transaction_data/<txid>`,
 *                       `/api/get_block_data/<height>`, tx page `/tx/<txid>`);
 *                       the payment is verified locally (fee/xmrRawTx.ts);
 *   `node+https://…`    (v1.20.2) a public Monero NODE (monerod's restricted
 *                       RPC: `POST /get_transactions` with decode_as_json).
 *                       It returns the transaction exactly as raw-tx
 *                       explorers do (monerod's own JSON), plus its depth, and
 *                       the payment is verified locally the same way. The tx
 *                       key is never sent to a node: only the txid, which is
 *                       already public in the order op. There are hundreds of
 *                       public nodes run by independent people, so the
 *                       quorum no longer hangs on two websites.
 *
 * Checked live on 2026-09-28 (see docs/OPERATIONS.md §40.4 for the evidence):
 * xmrchain.net and moneroexplorer.org answer the onion-explorer API;
 * moneroblocks.info serves raw transactions. Dropped: localmonero.co/blocks
 * (redirects to moneroblocks.info, a different API), monerohash.com/explorer
 * (explorer UI, JSON API off: /api/* → 404), exploremonero.com (JavaScript
 * front end: /api/* returns its HTML shell).
 *
 * Nodes (v1.20.2, checked live 2026-10-01: each answered `/get_height` at the
 * chain tip, 3774747, `untrusted: false`): Cake Wallet's
 * (xmr-node.cakewallet.com:18081), monero.fail's (node.monero.fail) and
 * cryptostorm's (xmr.cryptostorm.is) — three long-running operators, all on
 * HTTPS. A node that stops answering only goes to the pool's cooldown.
 */
export const DEFAULT_XMR_EXPLORERS: readonly string[] = [
	'https://xmrchain.net',
	'https://moneroexplorer.org',
	'raw-tx+https://moneroblocks.info',
	'node+https://xmr-node.cakewallet.com:18081',
	'node+https://node.monero.fail',
	'node+https://xmr.cryptostorm.is'
];

/** Explorers that were once in the default list and no longer answer the API
 *  Morphit uses (v1.20.0 re-check, 2026-09-28). The upgrade's list heal takes
 *  them out of an indexer.env that still carries them. Compared without a
 *  trailing slash. */
export const RETIRED_XMR_EXPLORERS: readonly string[] = [
	'https://localmonero.co/blocks',
	'https://monerohash.com/explorer',
	'https://exploremonero.com'
];

export type XmrExplorerKind = 'txprove' | 'raw-tx' | 'node';

/** `https://host[/path]` → txprove; `raw-tx+https://host[/path]` → raw-tx;
 *  `node+https://host[:port][/path]` → node. Null for anything that is not
 *  HTTPS (the tx key must never travel in cleartext, and a node's answer
 *  about depth must not be alterable on the way). */
export function parseXmrExplorer(spec: string): { kind: XmrExplorerKind; base: string } | null {
	const s = spec.trim();
	const kind: XmrExplorerKind = s.startsWith('raw-tx+')
		? 'raw-tx'
		: s.startsWith('node+')
			? 'node'
			: 'txprove';
	const url =
		kind === 'raw-tx' ? s.slice('raw-tx+'.length) : kind === 'node' ? s.slice('node+'.length) : s;
	if (!url.startsWith('https://')) return null;
	try {
		const u = new URL(url);
		if (u.username !== '' || u.password !== '') return null;
	} catch {
		return null;
	}
	return { kind, base: url.replace(/\/+$/, '') };
}

/** The comma-separated env value, split; null if any entry is not valid. */
export function parseXmrExplorerList(raw: string): string[] | null {
	const list = raw
		.split(',')
		.map((u) => u.trim())
		.filter((u) => u.length > 0);
	return list.every((u) => parseXmrExplorer(u) !== null) ? list : null;
}
