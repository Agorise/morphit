#!/usr/bin/env tsx
/**
 * Smoke: featured order cards show the SAME trust signals as normal order
 * cards — 🌱 new-trader sprout, ⭐ reputation score, trade count, and the
 * truncated posting-key anchor (Ken, 2026-07-08).
 *
 * Featured cards already rendered through the shared `OrderCard`, so this was
 * never a rendering bug: `/v1/featured` simply never joined the reputation and
 * identity columns, so the card was handed an order with those fields absent
 * and quietly dropped every signal. On exactly the cards a stranger is most
 * likely to click.
 *
 * The dangerous fix would have been to paste the orderbook's aggregate into the
 * featured query. That aggregate excludes sock-puppet pairs, coordinated
 * pile-ons and review-concentration attackers; a copy that drifted would
 * publish inflated reputation on the featured strip only. So the SQL lives in
 * `$api/reputationJoin` once, and BOTH endpoints splice it in.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const REPO = join(WEB, '..', '..');

const shared = readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'reputationJoin.ts'), 'utf8');
const featuredApi = readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'featuredOrderbook.ts'), 'utf8');
const orderbookApi = readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'orderbook.ts'), 'utf8');
const clientTypes = readFileSync(join(REPO, 'packages', 'indexer-client', 'src', 'index.ts'), 'utf8');
const featuredUi = readFileSync(join(WEB, 'src', 'lib', 'components', 'FeaturedOrders.svelte'), 'utf8');
const orderCard = readFileSync(join(WEB, 'src', 'lib', 'components', 'OrderCard.svelte'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

// ─── ONE definition of the aggregate ─────────────────────────────────
check('shared reputationJoin module exists', /export function feedbackAggregateJoin/.test(shared));
// Strip `${...}` interpolations AND `--` SQL comments before looking for a
// bind placeholder: the aggregate's comments mention "$0.20 each", which is
// prose, not a parameter.
const sharedSql = shared
	.replace(/\$\{[^}]*\}/g, '')
	.split('\n')
	.map((l) => l.replace(/--.*$/, ''))
	.join('\n');
check('it is parameter-free (splices into any query safely)', !/\$\d/.test(sharedSql));
// Check the SQL, not the prose. The module's docblock NAMES all four tables, so
// `shared.includes('review_concentration')` passes even after someone deletes
// the clause from the query — proven by tamper-testing. Strip comments first.
const sqlOnly = shared
	.replace(/\/\*[\s\S]*?\*\//g, '') // JS block comments
	.split('\n')
	.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
	.map((l) => l.replace(/--.*$/, '')) // SQL line comments
	.join('\n');
for (const guard of ['suspicious_reciprocity', 'related_accounts', 'one_way_pile_on', 'review_concentration']) {
	check(`the shared aggregate SQL still excludes ${guard}`, new RegExp(`FROM ${guard}\\b`).test(sqlOnly));
}
check('untethered feedback (no order_permlink) is still excluded', /fb\.order_permlink IS NOT NULL/.test(sqlOnly));
check('the composite score is computed in ONE place', /computeReputationScore/.test(shared) && /export function reputationFieldsFromRow/.test(shared));

// ─── both endpoints consume it ───────────────────────────────────────
check('orderbook.ts consumes the shared fragment (no private copy)', /feedbackAggregateJoin\('o'\)/.test(orderbookApi) && /accountsJoin\('o', 'a'\)/.test(orderbookApi));
// Scoped to the <=3 winning bidders: /v1/featured is polled by every homepage
// visitor, so aggregating the whole feedback table for three rows is real cost.
// Scoping only ADDS `AND fb.subject IN (...)` — it cannot relax an exclusion.
check('featured endpoint joins the shared aggregate, scoped to the winning bidders', /feedbackAggregateJoin\('o', 'SELECT bidder FROM winning_bids'\)/.test(featuredApi));
check('featured endpoint joins accounts (posting key + first trade)', /accountsJoin\('o', 'a'\)/.test(featuredApi));
check('featured endpoint selects the reputation columns', /reputationSelectColumns\('o', 'a'\)/.test(featuredApi));
check('featured endpoint maps them onto the order (sprout/score/count/key)', /\.\.\.reputationFieldsFromRow\(r\)/.test(featuredApi));
check('featured row type carries the reputation columns', /interface FeaturedRow extends ReputationRow/.test(featuredApi));
check('neither endpoint re-derives the aggregate inline', (orderbookApi.match(/suspicious_reciprocity/g) ?? []).length === 0 && (featuredApi.match(/suspicious_reciprocity/g) ?? []).length === 0);

// ─── the card can render them ────────────────────────────────────────
check('FeaturedOrders hands the whole order to OrderCard', /<OrderCard[\s\S]{0,80}order=\{o\}/.test(featuredUi));
check('OrderCard always renders the identity row (featured only changes the frame)', /<OrderPosterIdentity \{order\}/.test(orderCard) && !/\{#if !featured\}[\s\S]{0,120}<OrderPosterIdentity/.test(orderCard));

// ─── the featured payload is a COMPLETE OrderRecord ──────────────────
// FeaturedSlot.order is TYPED as OrderRecord. Before cp442 the endpoint sent a
// subset, so the type was lying to every consumer (the web app, the MCP server,
// any third party reading indexer-client).
check('featured carries asset_network (a USDT order must name its chain)', /o\.asset_network/.test(featuredApi) && /asset_network: r\.asset_network/.test(featuredApi));
check('featured carries created_at', /created_at: r\.created_at\.toISOString\(\)/.test(featuredApi));
check('featured carries engagement_24h via the SHARED engagement join (scoped)', /engagementJoin\('o', 'SELECT bidder FROM winning_bids'\)/.test(featuredApi) && /engagement_24h: r\.engagement_24h/.test(featuredApi));
check('orderbook.ts consumes the shared engagement join too (UNscoped — it lists many accounts)', /engagementJoin\('o'\)/.test(orderbookApi) && !/engagementJoin\('o',/.test(orderbookApi));

// ─── the network chip reaches the featured cards ─────────────────────
const chip = readFileSync(join(WEB, 'src', 'lib', 'orders', 'networkChip.ts'), 'utf8');
check('network-chip derivation is a shared helper', /export function networkChipFor/.test(chip));
check('it refuses to guess an unrecognised network', /return null;\s*\n\}/.test(chip));
check('FeaturedOrders passes a networkChip to OrderCard', /\{@const networkChip = networkChipFor\(o, \$_\)\}/.test(featuredUi) && /\{networkChip\}/.test(featuredUi));
const orderbookPage = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'orderbook', '+page.svelte'), 'utf8');
check('the orderbook page uses the same helper (no inline ternary copy)', /networkChipFor\(o, \$_\)/.test(orderbookPage) && !/usdtRowNetwork/.test(orderbookPage));

// ─── slot-count comments no longer stale ─────────────────────────────
check('client types no longer claim "Currently 5" slots', !/Currently 5/.test(clientTypes));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} featured-card-reputation scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} featured-card-reputation checks FAILED`);
	process.exit(1);
}
