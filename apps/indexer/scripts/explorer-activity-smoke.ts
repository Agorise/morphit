/**
 * Morphit smoke — explorer activity helpers (Batch K).
 *
 *  Covers:
 *    - aggregateListingHistogram + totalListings.
 *    - decorateOp branches.
 */

import {
	aggregateListingHistogram,
	totalListings
} from '../../web/src/lib/explorer/listingsHistogram';
import { decorateOp } from '../../web/src/lib/explorer/decorate';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── explorer activity smoke ───────────────────────────────\n');

// ─── aggregateListingHistogram ──────────────────────────────────────

scenario('empty input → empty output', () => {
	const r = aggregateListingHistogram([]);
	if (r.length !== 0) throw new Error(`got ${r.length}`);
});

scenario('single buy → one row, buy=1', () => {
	const r = aggregateListingHistogram([{ side: 'buy', asset: 'BTC' }]);
	if (r.length !== 1) throw new Error(`got ${r.length}`);
	if (r[0]!.asset !== 'BTC') throw new Error('asset');
	if (r[0]!.buy_count !== 1) throw new Error('buy_count');
	if (r[0]!.sell_count !== 0) throw new Error('sell_count');
});

scenario('mixed buys and sells aggregate per asset', () => {
	const r = aggregateListingHistogram([
		{ side: 'buy', asset: 'BTC' },
		{ side: 'buy', asset: 'BTC' },
		{ side: 'sell', asset: 'BTC' },
		{ side: 'buy', asset: 'XMR' }
	]);
	if (r.length !== 2) throw new Error(`got ${r.length}`);
	const btc = r.find((x) => x.asset === 'BTC')!;
	if (btc.buy_count !== 2 || btc.sell_count !== 1) throw new Error('btc counts');
	const xmr = r.find((x) => x.asset === 'XMR')!;
	if (xmr.buy_count !== 1 || xmr.sell_count !== 0) throw new Error('xmr counts');
});

scenario('output sorted alphabetically by asset', () => {
	const r = aggregateListingHistogram([
		{ side: 'buy', asset: 'XMR' },
		{ side: 'buy', asset: 'BLURT' },
		{ side: 'buy', asset: 'BTC' }
	]);
	if (r.map((x) => x.asset).join(',') !== 'BLURT,BTC,XMR') {
		throw new Error(r.map((x) => x.asset).join(','));
	}
});

scenario('drops items with empty asset', () => {
	const r = aggregateListingHistogram([
		{ side: 'buy', asset: '' },
		{ side: 'buy', asset: 'BTC' }
	]);
	if (r.length !== 1) throw new Error(`got ${r.length}`);
});

scenario('drops items with bad side', () => {
	const r = aggregateListingHistogram([
		{ side: 'foo' as 'buy', asset: 'BTC' },
		{ side: 'buy', asset: 'BTC' }
	]);
	if (r[0]!.buy_count !== 1) throw new Error('count');
});

// ─── totalListings ──────────────────────────────────────────────────

scenario('totalListings counts only valid items', () => {
	const total = totalListings([
		{ side: 'buy', asset: 'BTC' },
		{ side: 'sell', asset: 'BTC' },
		{ side: 'buy', asset: '' }, // dropped
		{ side: 'foo' as 'buy', asset: 'XMR' } // dropped
	]);
	if (total !== 2) throw new Error(`got ${total}`);
});

// ─── decorateOp ─────────────────────────────────────────────────────

scenario('decorates transfer', () => {
	const d = decorateOp('transfer', { from: 'a', to: 'b', amount: '1.000 BLURT' });
	if (d.kind !== 'transfer') throw new Error(d.kind);
	if (d.isMorphitOp !== false) throw new Error('isMorphitOp');
});

scenario('decorates comment', () => {
	const d = decorateOp('comment', {});
	if (d.kind !== 'comment') throw new Error(d.kind);
});

scenario('decorates vote', () => {
	const d = decorateOp('vote', {});
	if (d.kind !== 'vote') throw new Error(d.kind);
});

scenario('decorates morphit_order_v1 custom_json', () => {
	const d = decorateOp('custom_json', { id: 'morphit_order_v1', json: '{}' });
	if (d.kind !== 'morphit_order') throw new Error(d.kind);
	if (d.isMorphitOp !== true) throw new Error('isMorphitOp');
});

scenario('decorates morphit_chat_v1 custom_json', () => {
	const d = decorateOp('custom_json', { id: 'morphit_chat_v1', json: '{}' });
	if (d.kind !== 'morphit_chat') throw new Error(d.kind);
});

scenario('decorates morphit_operator_block_v1 custom_json', () => {
	const d = decorateOp('custom_json', {
		id: 'morphit_operator_block_v1',
		json: '{}'
	});
	if (d.kind !== 'morphit_operator_block') throw new Error(d.kind);
});

scenario('unknown custom_json id → custom_json_unknown', () => {
	const d = decorateOp('custom_json', { id: 'unknown_app_v1', json: '{}' });
	if (d.kind !== 'custom_json_unknown') throw new Error(d.kind);
	if (d.isMorphitOp !== false) throw new Error('isMorphitOp');
});

scenario('custom_json with no id → custom_json_unknown', () => {
	const d = decorateOp('custom_json', { json: '{}' });
	if (d.kind !== 'custom_json_unknown') throw new Error(d.kind);
});

scenario('custom_json with non-string id → custom_json_unknown', () => {
	const d = decorateOp('custom_json', { id: 123, json: '{}' });
	if (d.kind !== 'custom_json_unknown') throw new Error(d.kind);
});

scenario('non-comment non-transfer non-custom_json native op → native_unknown', () => {
	const d = decorateOp('account_create', {});
	if (d.kind !== 'native_unknown') throw new Error(d.kind);
});

scenario('non-string opName → native_unknown', () => {
	const d = decorateOp(null as unknown as string, {});
	if (d.kind !== 'native_unknown') throw new Error(d.kind);
});

scenario('null opBody on custom_json → custom_json_unknown', () => {
	const d = decorateOp('custom_json', null);
	if (d.kind !== 'custom_json_unknown') throw new Error(d.kind);
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
