/**
 * Morphit indexer — the XMR fee explorers (v1.20.0, wave 4; v1.20.2; onion
 * sources since v1.21.0). The default list itself lives in ONE place,
 * @morphit/operator-config (feeSources.ts), and is re-exported here for the
 * config default (MORPHIT_INDEXER_XMR_EXPLORER_URLS), the verifier's own
 * default, the ops-cli wizard and the upgrade's list heal.
 *
 * Three kinds:
 *   `https://…` / `http://<onion>`
 *                       an onion-monero-blockchain-explorer instance with its
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
 *                       already public in the order op.
 * Each kind may also name a hidden service over plain `http://` (Tor and I2P
 * encrypt and authenticate end to end): the onion explorers are asked first,
 * over Tor, and the clearnet ones only when those cannot answer — never on a
 * zero-clearnet node (indexer/sourceFetch.ts).
 *
 * Default onion explorers: the two xmrblocks instances (runbtc,
 * suddenwhipvapor) that answered `/api/networkinfo` over Tor on 2026-10-02 —
 * the same software as xmrchain.net, so the same JSON API. Default clearnet
 * fallback (checked 2026-09-28 / 2026-10-01, docs/OPERATIONS.md §40.4):
 * xmrchain.net and moneroexplorer.org answer the explorer API;
 * moneroblocks.info serves raw transactions; Cake Wallet's, monero.fail's and
 * cryptostorm's public nodes. Dropped: localmonero.co/blocks (redirects to
 * moneroblocks.info, a different API), monerohash.com/explorer (explorer UI,
 * JSON API off: /api/* → 404), exploremonero.com (JavaScript front end:
 * /api/* returns its HTML shell). A source that stops answering only goes to
 * the pool's cooldown.
 */
import {
	DEFAULT_XMR_FEE_EXPLORERS,
	isAcceptableSourceUrl
} from '@morphit/operator-config/fee-sources';

export const DEFAULT_XMR_EXPLORERS: readonly string[] = DEFAULT_XMR_FEE_EXPLORERS;

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

/** `https://host[/path]` or `http://<hidden host>` → txprove;
 *  `raw-tx+…` → raw-tx; `node+…` → node. Null for anything else: the tx key
 *  must never travel in cleartext over the open internet, and a node's answer
 *  about depth must not be alterable on the way — so plain `http://` only to
 *  a Tor/I2P hidden service, which the network encrypts end to end. */
export function parseXmrExplorer(spec: string): { kind: XmrExplorerKind; base: string } | null {
	const s = spec.trim();
	const kind: XmrExplorerKind = s.startsWith('raw-tx+')
		? 'raw-tx'
		: s.startsWith('node+')
			? 'node'
			: 'txprove';
	const url =
		kind === 'raw-tx' ? s.slice('raw-tx+'.length) : kind === 'node' ? s.slice('node+'.length) : s;
	if (!isAcceptableSourceUrl(url)) return null;
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
