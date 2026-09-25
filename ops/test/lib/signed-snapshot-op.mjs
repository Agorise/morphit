/**
 * ops/test/lib/signed-snapshot-op.mjs — test fixture (v1.18.0 deep-deep, rv2-1)
 *
 * Since v1.18.0 fast-sync and the mirror accept an indexer_snapshot_v1 op only
 * when two RPC operators agree on it and on its block, and when its signature
 * recovers to the pinned MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY. A harness
 * that serves a bare history entry therefore (correctly) gets refused. This
 * builds what a real chain serves: the op signed with a fixed TEST key, the
 * block holding it, and the account-history entry pointing at that block.
 *
 * Usage (from the repo root, so @beblurt/dblurt resolves):
 *   node ops/test/lib/signed-snapshot-op.mjs <payload-json> [<extra-history-json>]
 * Prints JSON: { pubkey, blockNum, history, rpc } where `rpc` maps condenser
 * method names to results, as hidden-proxy-stubs.mjs MORPHIT_STUB_RPC expects.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const { PrivateKey, cryptoUtils } = require('@beblurt/dblurt');

const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
const key = PrivateKey.fromSeed('morphit-ops-test-harness-official-posting-key');
const payloadJson = process.argv[2];
const extraHistory = process.argv[3] ? JSON.parse(process.argv[3]) : [];
const blockNum = 63610700;

const op = [
	'custom_json',
	{ required_auths: [], required_posting_auths: ['morphit'], id: 'indexer_snapshot_v1', json: payloadJson }
];
const tx = cryptoUtils.signTransaction(
	{ ref_block_num: 1, ref_block_prefix: 2, expiration: '2026-09-13T00:01:00', operations: [op], extensions: [] },
	[key],
	Buffer.from(CHAIN_ID, 'hex')
);
const trxId = cryptoUtils.generateTrxId(tx);
const history = [
	...extraHistory,
	[282, { trx_id: trxId, block: blockNum, trx_in_block: 0, op_in_trx: 0, op, timestamp: '2026-09-13T00:00:00' }]
];
const block = {
	block_id: 'harness-block',
	previous: 'harness-prev',
	timestamp: '2026-09-13T00:00:00',
	witness: 'harness',
	transactions: [tx],
	transaction_ids: [trxId]
};
process.stdout.write(
	JSON.stringify({
		pubkey: key.createPublic().toString(),
		blockNum,
		history,
		rpc: { 'condenser_api.get_account_history': history, 'condenser_api.get_block': block }
	})
);
