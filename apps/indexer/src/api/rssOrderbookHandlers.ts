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
import { isAccountName, escapeLike } from '$api/shared';

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

/** Feed-format selector. `rss` = RSS 2.0 (.xml), `atom` =
 *  Atom 1.0 (.atom), `json` = JSON Feed 1.1 (.json). Every feed
 *  surface offers all three; the underlying order data is
 *  identical and only the serialization differs. */
export type FeedFormat = 'rss' | 'atom' | 'json';

/** URL/file extension for a format (rss → "xml"). */
export function feedExt(format: FeedFormat): string {
	return format === 'rss' ? 'xml' : format;
}

/** Structured, format-agnostic feed item. buildItem derives it
 *  once from an OrderRow; the three serializers each render it
 *  in their own syntax, so the human-readable strings (title,
 *  summary) can never drift between RSS / Atom / JSON. */
interface FeedItem {
	readonly title: string;
	readonly link: string;
	readonly summary: string;
	/** Stable, globally-unique id. Reused verbatim as the RSS
	 *  <guid isPermaLink="false">, the Atom <entry><id>, and the
	 *  JSON Feed item `id`. Never changes across rebuilds. */
	readonly id: string;
	readonly published: Date;
	readonly updated: Date;
}

function buildItem(row: OrderRow, frontendOrigin: string): FeedItem {
	const titleParts = [row.side === 'buy' ? 'Buy' : 'Sell', row.asset, 'for', row.fiat_currency];
	if (row.location_region) {
		titleParts.push('·', row.location_region);
	}
	const title = titleParts.join(' ');

	const amountLine =
		row.amount_min || row.amount_max
			? `${row.amount_min ?? '?'} – ${row.amount_max ?? '?'} ${row.fiat_currency}`
			: 'any amount';

	const summaryLines = [
		`${row.side === 'buy' ? 'Buying' : 'Selling'} ${row.asset} for ${row.fiat_currency}`,
		`Amount: ${amountLine}`,
		`Payment: ${row.payment_methods.join(', ')}`,
		`Fee paid in: ${row.fee_method}`,
		`Posted by @${row.account}`
	];
	if (row.location_region) {
		summaryLines.push(`Region: ${row.location_region}`);
	}

	return {
		title,
		link: `${frontendOrigin}/orderbook#@${encodeURIComponent(
			row.account
		)}/${encodeURIComponent(row.permlink)}`,
		summary: summaryLines.join('\n'),
		id: `morphit:order:${row.account}:${row.permlink}`,
		published: row.created_at,
		updated: row.updated_at
	};
}

/** Render one item as an RSS 2.0 <item> element. */
function renderRssItem(item: FeedItem): string {
	return [
		'    <item>',
		`      <title>${xmlEscape(item.title)}</title>`,
		`      <link>${xmlEscape(item.link)}</link>`,
		`      <description>${xmlEscape(item.summary)}</description>`,
		`      <guid isPermaLink="false">${xmlEscape(item.id)}</guid>`,
		`      <pubDate>${rfc822Date(item.updated)}</pubDate>`,
		'    </item>'
	].join('\n');
}

interface FeedMeta {
	readonly title: string;
	readonly description: string;
	readonly selfUrl: string;
	readonly humanLink: string;
}

/** RSS 2.0 feed. Wire format is unchanged from the original
 *  single-format implementation — feed readers and the
 *  rss-orderbook-xml-validate smoke depend on it byte-for-byte. */
function renderRss(items: readonly FeedItem[], meta: FeedMeta): string {
	// Empty feed → "now" for lastBuildDate so feed readers
	// don't flag the channel as broken.
	const lastBuild = items.length > 0 ? items[0]!.updated : new Date();

	const itemsXml = items.map(renderRssItem).join('\n');

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

/** Render one item as an Atom 1.0 <entry>. Dates are RFC 3339
 *  (toISOString), which Atom requires — do NOT swap for
 *  toUTCString() (that's RFC 822, an RSS-only format). */
function renderAtomEntry(item: FeedItem): string {
	return [
		'  <entry>',
		`    <title>${xmlEscape(item.title)}</title>`,
		`    <link rel="alternate" href="${xmlEscape(item.link)}" />`,
		`    <id>${xmlEscape(item.id)}</id>`,
		`    <published>${item.published.toISOString()}</published>`,
		`    <updated>${item.updated.toISOString()}</updated>`,
		`    <summary type="text">${xmlEscape(item.summary)}</summary>`,
		'  </entry>'
	].join('\n');
}

/** Atom 1.0 feed (RFC 4287). A single feed-level <author> is
 *  emitted so entries inherit it without repeating it per entry.
 *  The feed <id> is the self URL (a stable, unique https IRI). */
function renderAtom(items: readonly FeedItem[], meta: FeedMeta): string {
	const updated = (items.length > 0 ? items[0]!.updated : new Date()).toISOString();
	const entriesXml = items.map(renderAtomEntry).join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <title>${xmlEscape(meta.title)}</title>
  <subtitle>${xmlEscape(meta.description)}</subtitle>
  <link rel="self" href="${xmlEscape(meta.selfUrl)}" />
  <link rel="alternate" href="${xmlEscape(meta.humanLink)}" />
  <id>${xmlEscape(meta.selfUrl)}</id>
  <updated>${updated}</updated>
  <author><name>Morphit</name></author>
${entriesXml}
</feed>
`;
}

/** JSON Feed 1.1 (jsonfeed.org/version/1.1). Uses content_text
 *  (not content_html) because the summary is plain text. No
 *  manual escaping — JSON.stringify handles it. */
function renderJson(items: readonly FeedItem[], meta: FeedMeta): string {
	const feed = {
		version: 'https://jsonfeed.org/version/1.1',
		title: meta.title,
		home_page_url: meta.humanLink,
		feed_url: meta.selfUrl,
		description: meta.description,
		language: 'en',
		items: items.map((item) => ({
			id: item.id,
			url: item.link,
			title: item.title,
			content_text: item.summary,
			date_published: item.published.toISOString(),
			date_modified: item.updated.toISOString()
		}))
	};
	return `${JSON.stringify(feed, null, 2)}\n`;
}

/** Single entry point: build the feed body in the requested
 *  format. Keeps every handler format-agnostic — they fetch
 *  rows, build meta, and hand both to this. */
function serializeFeed(
	rows: readonly OrderRow[],
	meta: FeedMeta,
	frontendOrigin: string,
	format: FeedFormat
): string {
	const items = rows.map((row) => buildItem(row, frontendOrigin));
	if (format === 'atom') return renderAtom(items, meta);
	if (format === 'json') return renderJson(items, meta);
	return renderRss(items, meta);
}

const PRIVACY_NOTE_GLOBAL =
	'Blurt is a public chain, so this feed does not reveal information that a chain indexer wouldn\'t — but it does make aggregation trivial. If you value privacy when posting, consider varying your timing and using Tor. See the FAQ entry "Can I follow Morphit with RSS?" for details.';

const PRIVACY_NOTE_PER_TRADER =
	"Blurt is a public chain, so this feed does not reveal information that a chain indexer wouldn't. However, polling a per-trader URL reveals to a network observer that you are watching this specific account — slightly more revealing than the global or per-asset feeds. If timing correlation matters in your threat model, poll over Tor.";

const PRIVACY_NOTE_FILTERED =
	"This feed URL encodes your search filters, so anyone who sees the URL — or a passive observer watching your polling — learns more about what you're looking for than the plain per-asset feed does. For a less revealing subscription, drop the query string and filter inside your reader instead; poll over Tor if timing correlation matters in your threat model.";

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

const CONTENT_TYPE: Readonly<Record<FeedFormat, string>> = {
	rss: 'application/rss+xml; charset=utf-8',
	atom: 'application/atom+xml; charset=utf-8',
	json: 'application/feed+json; charset=utf-8'
};

/** Response headers for a given feed format. Cache-Control is
 *  identical across formats — the cap and TTL are format-agnostic. */
function headersFor(format: FeedFormat): Record<string, string> {
	return {
		'content-type': CONTENT_TYPE[format],
		'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`
	};
}

const errorJson = (code: string, status: number): HandlerResult => ({
	status,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ status: 'error', code, message: code })
});

/** /rss/orderbook.xml — global feed of all live, fee-verified
 *  orders, capped at 50, ordered by recency. */
export async function globalFeedHandler(
	db: Database,
	config: Config,
	format: FeedFormat = 'rss'
): Promise<HandlerResult> {
	const frontendOrigin = frontendOriginFrom(config);
	const sql = `
		SELECT o.account, o.permlink, o.side, o.asset, o.fiat_currency,
		       o.amount_min::text, o.amount_max::text,
		       o.location_region, o.payment_methods, o.fee_method,
		       o.created_at, o.updated_at
		  FROM orders o
		 WHERE o.status = 'live'
		   AND o.fee_status IN ('verified', 'verified_by_attestation')
		   AND NOT EXISTS (SELECT 1 FROM operator_blocks ob WHERE ob.operator = $2 AND ob.blocked = o.account AND ob.state = 'blocked')
		 ORDER BY o.updated_at DESC, o.account ASC, o.permlink ASC
		 LIMIT $1`;

	const result = await db.query<OrderRow>(sql, [FEED_LIMIT, config.officialAccountName]);

	const body = serializeFeed(
		result.rows,
		{
			title: 'Morphit — New orderbook entries',
			description: `The ${FEED_LIMIT} most recent live orders on Morphit with an established listing fee. ${PRIVACY_NOTE_GLOBAL}`,
			selfUrl: `${config.publicOrigin}/rss/orderbook.${feedExt(format)}`,
			humanLink: `${frontendOrigin}/orderbook`
		},
		frontendOrigin,
		format
	);

	return { status: 200, headers: headersFor(format), body };
}

/** Order-intrinsic + reputation filters a per-asset feed can carry as
 *  query params, mirroring the live orderbook's filter surface
 *  (apps/indexer/src/api/orderbook.ts) so a feed of "my current
 *  search" returns the same rows the orderbook page shows: side,
 *  fiat_currency, location_region, payment_methods, and min_trades.
 *
 *  min_trades rides the SAME sock-puppet-filtered, trade-bound
 *  feedback COUNT the orderbook uses (FEEDBACK_COUNT_SUBQUERY below,
 *  pinned table-for-table against orderbook.ts by
 *  rss-orderbook-filters-smoke), so a trader the orderbook hides under
 *  a min_trades threshold is hidden from the feed too — the two never
 *  disagree.
 *
 *  ONE orderbook control is intentionally NOT honored:
 *    - sort: a feed is inherently reverse-chronological (every
 *      RSS/Atom/JSON reader re-sorts by date, and a non-recency feed
 *      would silently drop new matching orders past the 50-cap), so
 *      the feed always returns the MOST-RECENT matching orders.  sort
 *      only changes the orderbook's DISPLAY order, not which orders
 *      match — the filters above are what define the feed's contents.
 */
interface FeedFilters {
	readonly side?: 'buy' | 'sell';
	readonly fiatCurrencies?: readonly string[];
	readonly locationRegion?: string;
	readonly paymentMethods?: readonly string[];
	readonly minTrades?: number;
}

/** Parse + validate raw query params into FeedFilters.  Fail-OPEN: an
 *  unparseable value for a given filter is dropped (the feed returns a
 *  broader — never empty — result) so a slightly-malformed
 *  subscription URL still yields a working feed instead of a 400. */
function parseFeedFilters(raw: Readonly<Record<string, string | undefined>>): FeedFilters {
	const out: {
		side?: 'buy' | 'sell';
		fiatCurrencies?: string[];
		locationRegion?: string;
		paymentMethods?: string[];
		minTrades?: number;
	} = {};

	const side = (raw.side ?? '').trim().toLowerCase();
	if (side === 'buy' || side === 'sell') out.side = side;

	const fiatRaw = (raw.fiat_currency ?? '').trim();
	if (fiatRaw) {
		const fiats = [
			...new Set(
				fiatRaw
					.split(',')
					.map((s) => s.trim().toUpperCase())
					.filter((s) => s.length >= 2 && s.length <= 8)
			)
		];
		if (fiats.length) out.fiatCurrencies = fiats;
	}

	const region = (raw.location_region ?? '').trim();
	if (region) {
		const normalized = region.normalize('NFC').slice(0, 128);
		if (normalized) out.locationRegion = normalized;
	}

	const payRaw = (raw.payment_methods ?? '').trim();
	if (payRaw) {
		const methods = [
			...new Set(
				payRaw
					.split(',')
					.map((s) => s.trim().normalize('NFC').toLowerCase())
					.filter((s) => s.length > 0 && s.length <= 32)
			)
		];
		if (methods.length) out.paymentMethods = methods;
	}

	// min_trades: integer 1..100 (matches orderbook.ts's
	// z.coerce.number().int().nonnegative().max(100); 0 = "Any" = no
	// filter, so only a positive value narrows the feed).
	const mt = (raw.min_trades ?? '').trim();
	if (mt) {
		const n = Number(mt);
		if (Number.isInteger(n) && n > 0 && n <= 100) out.minTrades = n;
	}

	return out;
}

/** True when any filter is active — drives the self-describing
 *  description + the self URL's query string. */
function hasAnyFilter(f: FeedFilters): boolean {
	return (
		f.side !== undefined ||
		f.fiatCurrencies !== undefined ||
		f.locationRegion !== undefined ||
		f.paymentMethods !== undefined ||
		f.minTrades !== undefined
	);
}

/** Append the filter WHERE-clause fragments, binding params via `p`.
 *  Clause shapes are kept byte-identical to orderbook.ts so the feed
 *  matches the orderbook exactly; rss-orderbook-filters-smoke pins
 *  the parity. */
function appendFilterClauses(f: FeedFilters, where: string[], p: (v: unknown) => string): void {
	if (f.side) where.push(`o.side = ${p(f.side)}`);
	if (f.fiatCurrencies) where.push(`o.fiat_currency = ANY(${p(f.fiatCurrencies)}::text[])`);
	if (f.locationRegion) {
		where.push(`o.location_region ILIKE ${p(escapeLike(f.locationRegion) + '%')} ESCAPE '\\'`);
	}
	if (f.paymentMethods) {
		where.push(
			`EXISTS (SELECT 1 FROM unnest(o.payment_methods) pm WHERE lower(pm) = ANY(${p(f.paymentMethods)}::text[]))`
		);
	}
}

/** The `?…` suffix reproducing the active filters for the feed's self
 *  URL.  Stable key order so the self URL is deterministic. */
function filterQueryString(f: FeedFilters): string {
	const parts: string[] = [];
	if (f.side) parts.push(`side=${encodeURIComponent(f.side)}`);
	if (f.fiatCurrencies)
		parts.push(`fiat_currency=${encodeURIComponent(f.fiatCurrencies.join(','))}`);
	if (f.locationRegion) parts.push(`location_region=${encodeURIComponent(f.locationRegion)}`);
	if (f.paymentMethods)
		parts.push(`payment_methods=${encodeURIComponent(f.paymentMethods.join(','))}`);
	if (f.minTrades !== undefined) parts.push(`min_trades=${f.minTrades}`);
	return parts.length ? `?${parts.join('&')}` : '';
}

/** Sock-puppet-filtered, trade-bound feedback COUNT per subject — the
 *  SAME row-eligibility predicate the live orderbook uses for its
 *  min_trades filter (apps/indexer/src/api/orderbook.ts, the `f` join),
 *  so a feed's min_trades and the orderbook's never disagree about who
 *  clears a threshold.  COUNT-only: the feed never sorts by rating, so
 *  the decay-weighted rating the orderbook also computes is omitted.
 *
 *  CANONICAL exclusion set lives in orderbook.ts; this is a deliberate
 *  count-only mirror (the codebase already keeps per-consumer copies of
 *  this aggregate — orders.ts, orderbookStream.ts, reputationReceipt.ts,
 *  the feedback API — rather than one shared CTE).  rss-orderbook-
 *  filters-smoke extracts the exclusion TABLES from both this constant
 *  and orderbook.ts's `f` subquery and fails if they ever differ, so
 *  the mirror can't silently drift. */
const FEEDBACK_COUNT_SUBQUERY = `
		SELECT subject, COUNT(*)::int AS c
		  FROM feedback fb
		 WHERE fb.order_permlink IS NOT NULL
		   AND NOT EXISTS (
		     SELECT 1 FROM suspicious_reciprocity sr
		      WHERE sr.account_a = LEAST(fb.reviewer, fb.subject)
		        AND sr.account_b = GREATEST(fb.reviewer, fb.subject)
		   )
		   AND NOT EXISTS (
		     SELECT 1 FROM related_accounts ra
		      WHERE ra.account_a = LEAST(fb.reviewer, fb.subject)
		        AND ra.account_b = GREATEST(fb.reviewer, fb.subject)
		   )
		   AND NOT EXISTS (
		     SELECT 1 FROM one_way_pile_on owpo,
		                  jsonb_array_elements(owpo.attacking_reviewers) attacker
		      WHERE owpo.subject = fb.subject
		        AND attacker->>'reviewer' = fb.reviewer
		   )
		   AND NOT EXISTS (
		     SELECT 1 FROM review_concentration rc
		      WHERE rc.reviewer = fb.reviewer
		        AND rc.dominant_subject = fb.subject
		   )
		 GROUP BY subject`;

/** /rss/orderbook/by-asset/<asset>.xml — `rawSegment` is the
 *  URL path parameter (e.g., "btc.xml"). Validates the asset
 *  is one of the canonical ASSET_TICKERS supported (16 at
 *  cp49); rejects others with 400 to keep the URL space small
 *  and enumerable.
 *
 *  Cp50 deep-deep D-1 HIGH fix: the regex used to be hardcoded
 *  `/^(btc|xmr|blurt)\.xml$/` and silently stayed frozen at 3
 *  assets across 13 subsequent asset additions (cp21 BCH, cp24
 *  LTC, cp27 DASH, cp30 USDC, cp30 USDT, cp31 DAI, cp33 DOGE,
 *  cp39 ZEC, cp41 ARRR, cp43 DCR, cp45 SOL, cp47 ETH, cp49 XRP)
 *  — every per-asset RSS feed except BTC/XMR/BLURT 400'd silently
 *  for ~14 checkpoints.  Fix derives the allow-set from
 *  ASSET_TICKERS so future asset additions cannot drift this
 *  again.  Cp50 NEW per-asset-rss-feed-smoke pins the derivation. */
export async function perAssetFeedHandler(
	rawSegment: string,
	db: Database,
	config: Config,
	rawFilters: Readonly<Record<string, string | undefined>> = {}
): Promise<HandlerResult> {
	// Derive allow-set from canonical ASSET_TICKERS (lowercased).
	// LL #38 sibling-file pattern: any future asset addition to
	// ASSET_TICKERS automatically unlocks its per-asset feed.
	const m = rawSegment.match(/^([a-z]+)\.(xml|atom|json)$/);
	if (m === null) {
		return errorJson('invalid_asset', 400);
	}
	const lower = m[1]!;
	const ext = m[2]!;
	const format: FeedFormat = ext === 'xml' ? 'rss' : (ext as FeedFormat);
	const upper = lower.toUpperCase();
	if (!(ASSET_TICKERS as readonly string[]).includes(upper)) {
		return errorJson('invalid_asset', 400);
	}
	const asset = upper as Asset;
	const frontendOrigin = frontendOriginFrom(config);

	const filters = parseFeedFilters(rawFilters);

	// Dynamic param binder (mirrors orderbook.ts).  Asset binds FIRST
	// so params[0] is always the asset (rss-orderbook-smoke relies on
	// that); optional order-property filters splice in after the fixed
	// predicates and FEED_LIMIT binds last.
	const params: unknown[] = [];
	const p = (v: unknown): string => {
		params.push(v);
		return `$${params.length}`;
	};
	const where: string[] = [
		`o.status = 'live'`,
		`o.fee_status IN ('verified', 'verified_by_attestation')`,
		`o.asset = ${p(asset)}`,
		`NOT EXISTS (SELECT 1 FROM operator_blocks ob WHERE ob.operator = ${p(config.officialAccountName)} AND ob.blocked = o.account AND ob.state = 'blocked')`
	];
	appendFilterClauses(filters, where, p);

	// min_trades rides the feedback-count aggregate (same sock-puppet
	// exclusion set as the orderbook) — joined ONLY when the filter is
	// active so the bare / order-property feed never pays for it.  A
	// LEFT JOIN never drops rows on its own; the COALESCE clause is what
	// enforces the threshold.
	let joinSql = '';
	if (filters.minTrades !== undefined) {
		joinSql = `
		  LEFT JOIN (${FEEDBACK_COUNT_SUBQUERY}
		  ) f ON f.subject = o.account`;
		where.push(`COALESCE(f.c, 0) >= ${p(filters.minTrades)}`);
	}

	const sql = `
		SELECT o.account, o.permlink, o.side, o.asset, o.fiat_currency,
		       o.amount_min::text, o.amount_max::text,
		       o.location_region, o.payment_methods, o.fee_method,
		       o.created_at, o.updated_at
		  FROM orders o${joinSql}
		 WHERE ${where.join(' AND ')}
		 ORDER BY o.updated_at DESC, o.account ASC, o.permlink ASC
		 LIMIT ${p(FEED_LIMIT)}`;

	const result = await db.query<OrderRow>(sql, params);

	const filtered = hasAnyFilter(filters);

	// Optional human-readable feed title built by the FRONTEND from the
	// orderbook form's own labels (single source of truth — see
	// RssFeedPicker / orderbook +page.svelte).  When present we echo it as
	// the feed <title>: the labels live in the web app's i18n + registries,
	// so the indexer never reconstructs them here.  serializeFeed applies the
	// format's escaping (XML/JSON), so we only strip control chars (keep the
	// title one clean line + valid XML) and length-cap so a hand-crafted URL
	// can't bloat the feed head.  Absent (a manual / bare feed URL) → the
	// static per-asset title.
	const customTitle = (rawFilters.feed_title ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.trim()
		.slice(0, 300);
	const feedTitle =
		customTitle.length > 0 ? customTitle : `Morphit — New ${asset} orderbook entries`;

	const body = serializeFeed(
		result.rows,
		{
			title: feedTitle,
			description: `The ${FEED_LIMIT} most recent live ${asset} orders on Morphit${filtered ? ' matching your selected filters' : ''}. ${filtered ? PRIVACY_NOTE_FILTERED : PRIVACY_NOTE_GLOBAL}`,
			selfUrl: `${config.publicOrigin}/rss/orderbook/by-asset/${lower}.${ext}${filterQueryString(filters)}`,
			humanLink: `${frontendOrigin}/orderbook?asset=${asset}`
		},
		frontendOrigin,
		format
	);

	return { status: 200, headers: headersFor(format), body };
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
	const m = rawSegment.match(/^@?([a-z0-9.-]+)\.(xml|atom|json)$/i);
	if (m === null) {
		return errorJson('invalid_account', 400);
	}
	const account = m[1]!.toLowerCase();
	const ext = m[2]!.toLowerCase();
	const format: FeedFormat = ext === 'xml' ? 'rss' : (ext as FeedFormat);
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
		   AND NOT EXISTS (SELECT 1 FROM operator_blocks ob WHERE ob.operator = $3 AND ob.blocked = o.account AND ob.state = 'blocked')
		 ORDER BY o.updated_at DESC, o.permlink ASC
		 LIMIT $2`;

	const result = await db.query<OrderRow>(sql, [account, FEED_LIMIT, config.officialAccountName]);

	const body = serializeFeed(
		result.rows,
		{
			title: `Morphit — Orders by @${account}`,
			description: `The ${FEED_LIMIT} most recent live orders posted by @${account}. ${PRIVACY_NOTE_PER_TRADER}`,
			selfUrl: `${config.publicOrigin}/rss/orderbook/by-account/@${account}.${ext}`,
			humanLink: `${frontendOrigin}/@${account}`
		},
		frontendOrigin,
		format
	);

	return { status: 200, headers: headersFor(format), body };
}
