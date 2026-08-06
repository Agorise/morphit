/**
 * featured-bid-history-modal-smoke — cp453 (t.txt #2)
 *
 * The grey inline "Your recent featured bids" section became a small "View prior
 * Featured orders" LINK in the feature-form header that opens an ELI5 modal
 * listing every prior featured order (newest first): each row = the order's human
 * summary line + its order id in parens + the bid detail + a status pill. The
 * summary needs the order fields, which the read route now surfaces (its JOIN was
 * already there). Source-level invariants, tamper-tested.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8');

const hist = read('apps/web/src/lib/components/FeaturedBidHistory.svelte');
const form = read('apps/web/src/lib/components/FeatureBidForm.svelte');
const route = read('apps/indexer/src/api/featuredBids.ts');
const clientType = read('packages/indexer-client/src/index.ts');
const en = JSON.parse(read('apps/web/src/lib/i18n/locales/en.json')) as {
	feature_bid: Record<string, string>;
};

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// 1. Backend surfaces the order summary fields (JOIN already existed).
check(
	'the read route SELECTs the order summary fields',
	/o\.side AS order_side/.test(route) &&
		/o\.asset AS order_asset/.test(route) &&
		/o\.fiat_currency AS order_fiat_currency/.test(route) &&
		/o\.amount_min::text AS order_amount_min/.test(route) &&
		/o\.amount_max::text AS order_amount_max/.test(route)
);
check(
	'FeaturedBidHistoryEntry type carries the order summary fields',
	/order_side: string \| null/.test(clientType) &&
		/order_amount_min: number \| null/.test(clientType)
);

// 2. It's a LINK + native <dialog> modal, NOT an inline grey section.
check(
	'renders a "View prior Featured orders" link that opens the modal',
	/feature_bid\.history_link/.test(hist) && /open = true/.test(hist) && Boolean(en.feature_bid.history_link)
);
check(
	'the list lives in a native <dialog> (focus trap + backdrop)',
	/<dialog/.test(hist) && /dialogEl\.showModal\(\)/.test(hist)
);
check(
	'the old inline grey section is gone (no <section class="card ...> history block)',
	!/<section[^>]*class="card[^"]*"[\s\S]*?history_heading/.test(hist)
);

// 3. Each row: order SUMMARY line + order id in parens + bid detail + status pill.
check(
	'each row builds the order summary via orderTitleParts + shows the order id in parens',
	/orderTitleParts/.test(hist) && /\(\{b\.order_permlink\}\)/.test(hist)
);
check(
	'each row keeps the bid detail (history_row) and a status pill',
	/feature_bid\.history_row/.test(hist) && /history_state_visible/.test(hist)
);

// 4. The link sits in the form header (top-right), not as an inline block above.
check(
	'the feature form puts the title + link in one header row (top-right)',
	/flex items-start justify-between[\s\S]*?feature_bid\.title[\s\S]*?<FeaturedBidHistory/.test(form)
);

if (failures === 0) {
	console.log('✓ all 8 featured-bid-history-modal scenarios passed');
} else {
	console.log(`\n✗ ${failures}/8 featured-bid-history-modal scenarios failed`);
	process.exit(1);
}
