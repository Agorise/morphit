/**
 * Morphit indexer — RSS orderbook feed handlers.
 *
 * Pure async handler functions that take a Database + Config
 * and return a {status, headers, body} envelope. The Hono
 * adapter in rssOrderbook.ts wraps these for HTTP serving;
 * smoke tests exercise them directly.
 *
 * Splitting the Hono dependency out keeps the smoke runner
 * loadable in environments without node_modules (matches the
 * pattern used by every other handler in this repo).
 *
 * The three feeds and their privacy posture are documented
 * in detail in rssOrderbook.ts.
 */

import type { Database } from '$db/pool';
import type { Config } from '$config/index';
import { isAccountName } from '$api/shared';

import { ASSET_TICKERS, type AssetTicker } from '@morphit/asset-registry';

const FEED_LIMIT = 50;
const CACHE_TTL_SECONDS = 60;

// Local alias for backwards-compat with tests / call sites that
// imported `Asset` from this module before the asset-registry
// refactor.  Identical to AssetTicker.
type Asset = AssetTicker;
const VALID_ASSETS = ASSET_TICKERS;

interface OrderRow {
	account: string;
	permlink: string;
	side: 'buy' | 'sell';
	asset: Asset;
	fiat_currency: string;
	amount_min: string | null;
	amount_max: string | null;
	location_region: string | null;
	payment_methods: string[];
	fee_method: string;
	created_at: Date;
	updated_at: Date;
}

/**
 * Escape for XML text content. Five characters: `<`, `>`,
 * `&`, `"`, `'`. `&` first — doing it last would
 * double-escape the others.
 */
function xmlEscape(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * RFC 822 date format required by RSS 2.0. Date.toUTCString()
 * happens to produce this exact format. Don't change to
 * toISOString() — readers reject it.
 */
function rfc822Date(d: Date): string {
	return d.toUTCString();
}

/** Format a single order row as an <item> element. */
function renderItem(row: OrderRow, frontendOrigin: string): string {
	const titleParts = [row.side === 'buy' ? 'Buy' : 'Sell', row.asset, 'for', row.fiat_currency];
	if (row.location_region) {
		titleParts.push('·', row.location_region);
	}
	const title = titleParts.join(' ');

	const amountLine =
		row.amount_min || row.amount_max
			? `${row.amount_min ?? '?'} – ${row.amount_max ?? '?'} ${row.fiat_currency}`
			: 'any amount';

	const descriptionLines = [
		`${row.side === 'buy' ? 'Buying' : 'Selling'} ${row.asset} for ${row.fiat_currency}`,
		`Amount: ${amountLine}`,
		`Payment: ${row.payment_methods.join(', ')}`,
		`Fee paid in: ${row.fee_method}`,
		`Posted by @${row.account}`
	];
	if (row.location_region) {
		descriptionLines.push(`Region: ${row.location_region}`);
	}
	const description = descriptionLines.join('\n');

	const link = `${frontendOrigin}/orderbook#@${encodeURIComponent(
		row.account
	)}/${encodeURIComponent(row.permlink)}`;

	const guid = `morphit:order:${row.account}:${row.permlink}`;

	return [
		'    <item>',
		`      <title>${xmlEscape(title)}</title>`,
		`      <link>${xmlEscape(link)}</link>`,
		`      <description>${xmlEscape(description)}</description>`,
		`      <guid isPermaLink="false">${xmlEscape(guid)}</guid>`,
		`      <pubDate>${rfc822Date(row.updated_at)}</pubDate>`,
		'    </item>'
	].join('\n');
}

interface FeedMeta {
	readonly title: string;
	readonly description: string;
	readonly selfUrl: string;
	readonly humanLink: string;
}

/** Render a complete RSS feed. */
function renderFeed(rows: readonly OrderRow[], meta: FeedMeta, frontendOrigin: string): string {
	// Empty feed → "now" for lastBuildDate so feed readers
	// don't flag the channel as broken.
	const lastBuild = rows.length > 0 ? rows[0]!.updated_at : new Date();

	const itemsXml = rows.map((row) => renderItem(row, frontendOrigin)).join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(meta.title)}</title>
    <link>${xmlEscape(meta.humanLink)}</link>
    <atom:link href="${xmlEscape(meta.selfUrl)}" rel="self" type="application/rss+xml" />
    <description>${xmlEscape(meta.description)}</description>
    <language>en</language>
    <lastBuildDate>${rfc822Date(lastBuild)}</lastBuildDate>
    <ttl>${Math.max(1, Math.floor(CACHE_TTL_SECONDS / 60))}</ttl>
${itemsXml}
  </channel>
</rss>
`;
}

const PRIVACY_NOTE_GLOBAL =
	'Blurt is a public chain, so this feed does not reveal information that a chain indexer wouldn\'t — but it does make aggregation trivial. If you value privacy when posting, consider varying your timing and using Tor. See the FAQ entry "Can I follow Morphit with RSS?" for details.';

const PRIVACY_NOTE_PER_TRADER =
	"Blurt is a public chain, so this feed does not reveal information that a chain indexer wouldn't. However, polling a per-trader URL reveals to a network observer that you are watching this specific account — slightly more revealing than the global or per-asset feeds. If timing correlation matters in your threat model, poll over Tor.";

/** Strip the "indexer." subdomain from publicOrigin to derive
 *  the frontend origin. Operators on the same origin (dev) get
 *  that for free. */
function frontendOriginFrom(config: Config): string {
	return config.publicOrigin.replace(/\/\/indexer\./, '//');
}

export interface HandlerResult {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly body: string;
}

const RSS_HEADERS: Record<string, string> = {
	'content-type': 'application/rss+xml; charset=utf-8',
	'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`
};

const errorJson = (code: string, status: number): HandlerResult => ({
	status,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ status: 'error', code, message: code })
});

/** /rss/orderbook.xml — global feed of all live, fee-verified
 *  orders, capped at 50, ordered by recency. */
export async function globalFeedHandler(db: Database, config: Config): Promise<HandlerResult> {
	const frontendOrigin = frontendOriginFrom(config);
	const sql = `
		SELECT o.account, o.permlink, o.side, o.asset, o.fiat_currency,
		       o.amount_min::text, o.amount_max::text,
		       o.location_region, o.payment_methods, o.fee_method,
		       o.created_at, o.updated_at
		  FROM orders o
		 WHERE o.status = 'live'
		   AND o.fee_status IN ('verified', 'verified_by_attestation')
		 ORDER BY o.updated_at DESC, o.account ASC, o.permlink ASC
		 LIMIT $1`;

	const result = await db.query<OrderRow>(sql, [FEED_LIMIT]);

	const xml = renderFeed(
		result.rows,
		{
			title: 'Morphit — New orderbook entries',
			description: `The ${FEED_LIMIT} most recent live orders on Morphit with an established listing fee. ${PRIVACY_NOTE_GLOBAL}`,
			selfUrl: `${config.publicOrigin}/rss/orderbook.xml`,
			humanLink: `${frontendOrigin}/orderbook`
		},
		frontendOrigin
	);

	return { status: 200, headers: RSS_HEADERS, body: xml };
}

/** /rss/orderbook/by-asset/<asset>.xml — `rawSegment` is the
 *  URL path parameter (e.g., "btc.xml"). Validates the asset
 *  is one of the three the site supports; rejects others
 *  with 400 to keep the URL space small and enumerable. */
export async function perAssetFeedHandler(
	rawSegment: string,
	db: Database,
	config: Config
): Promise<HandlerResult> {
	const m = rawSegment.match(/^(btc|xmr|blurt)\.xml$/);
	if (m === null) {
		return errorJson('invalid_asset', 400);
	}
	const asset = m[1]!.toUpperCase() as Asset;
	const frontendOrigin = frontendOriginFrom(config);

	const sql = `
		SELECT o.account, o.permlink, o.side, o.asset, o.fiat_currency,
		       o.amount_min::text, o.amount_max::text,
		       o.location_region, o.payment_methods, o.fee_method,
		       o.created_at, o.updated_at
		  FROM orders o
		 WHERE o.status = 'live'
		   AND o.fee_status IN ('verified', 'verified_by_attestation')
		   AND o.asset = $1
		 ORDER BY o.updated_at DESC, o.account ASC, o.permlink ASC
		 LIMIT $2`;

	const result = await db.query<OrderRow>(sql, [asset, FEED_LIMIT]);

	const xml = renderFeed(
		result.rows,
		{
			title: `Morphit — New ${asset} orderbook entries`,
			description: `The ${FEED_LIMIT} most recent live ${asset} orders on Morphit. ${PRIVACY_NOTE_GLOBAL}`,
			selfUrl: `${config.publicOrigin}/rss/orderbook/by-asset/${m[1]!}.xml`,
			humanLink: `${frontendOrigin}/orderbook?asset=${asset}`
		},
		frontendOrigin
	);

	return { status: 200, headers: RSS_HEADERS, body: xml };
}

/** /rss/orderbook/by-account/@<acct>.xml — `rawSegment` is
 *  the URL path parameter ("@alice.xml" or "alice.xml"). The
 *  handler:
 *    - strips an optional @-prefix,
 *    - lowercases (Blurt accounts are always lowercase),
 *    - validates with the standard regex,
 *    - returns 400 for malformed input,
 *    - returns 200 with an empty feed for an unknown account
 *      (privacy: not an existence oracle). */
export async function perAccountFeedHandler(
	rawSegment: string,
	db: Database,
	config: Config
): Promise<HandlerResult> {
	const m = rawSegment.match(/^@?([a-z0-9.-]+)\.xml$/i);
	if (m === null) {
		return errorJson('invalid_account', 400);
	}
	const account = m[1]!.toLowerCase();
	if (!isAccountName(account)) {
		return errorJson('invalid_account', 400);
	}
	const frontendOrigin = frontendOriginFrom(config);

	const sql = `
		SELECT o.account, o.permlink, o.side, o.asset, o.fiat_currency,
		       o.amount_min::text, o.amount_max::text,
		       o.location_region, o.payment_methods, o.fee_method,
		       o.created_at, o.updated_at
		  FROM orders o
		 WHERE o.status = 'live'
		   AND o.fee_status IN ('verified', 'verified_by_attestation')
		   AND o.account = $1
		 ORDER BY o.updated_at DESC, o.permlink ASC
		 LIMIT $2`;

	const result = await db.query<OrderRow>(sql, [account, FEED_LIMIT]);

	const xml = renderFeed(
		result.rows,
		{
			title: `Morphit — Orders by @${account}`,
			description: `The ${FEED_LIMIT} most recent live orders posted by @${account}. ${PRIVACY_NOTE_PER_TRADER}`,
			selfUrl: `${config.publicOrigin}/rss/orderbook/by-account/@${account}.xml`,
			humanLink: `${frontendOrigin}/u/${account}`
		},
		frontendOrigin
	);

	return { status: 200, headers: RSS_HEADERS, body: xml };
}
