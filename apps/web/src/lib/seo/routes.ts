/**
 * Morphit — route registry.
 *
 * Single source of truth for every routable page in the app. Every
 * route needs:
 *   - a URL path
 *   - an i18n `key` that resolves to `seo.<key>.title` and
 *     `seo.<key>.description` (used by the <Head /> component and
 *     by the sitemap generator)
 *   - an `indexable` flag for whether it appears in sitemap.xml
 *   - sitemap metadata (`priority`, `changefreq`) for the subset
 *     that IS indexable (values are ignored for non-indexable
 *     routes but still required for schema uniformity)
 *
 * Consumers:
 *   - `scripts/build-sitemap.mjs` imports ROUTES and emits one
 *     <url> entry per indexable route × locale.
 *   - The <Head /> component resolves `seo.<key>.*` from the
 *     locale files to render <title>, <meta name="description">,
 *     and Open Graph tags. Head takes a `routeKey` prop directly
 *     rather than reading this registry — the registry's role is
 *     to enforce that every route HAS a matching seo.<key>.* key,
 *     tested below.
 *
 * When adding a new route, you must:
 *   1. Add its path + key to this file.
 *   2. Add seo.<key>.{title,description} to every locale in
 *      apps/web/src/lib/i18n/locales/*.json.
 *   3. Pass routeKey="<key>" to <Head /> from the route's page.
 *
 * Dynamic routes like /[account] and /[account]/[permlink] are
 * listed here too — with `indexable: false` — so Head tag
 * rendering works. They aren't emitted to the sitemap because
 * the URL space is unbounded.
 *
 * ADR-0003 governs this registry.
 */

export interface RouteDescriptor {
	/** URL path. For dynamic routes, the literal SvelteKit route
	 *  pattern (e.g. `/[x+40][account=account]`). For static routes,
	 *  the resolved path without a trailing slash (except `/`). */
	path: string;
	/** i18n key under `seo.<key>.title` / `seo.<key>.description`. */
	key: string;
	/** Whether this route appears in sitemap.xml. Dynamic routes and
	 *  user-specific pages are always false. */
	indexable: boolean;
	/** Sitemap priority hint, 0.0–1.0. Ignored when !indexable. */
	priority: number;
	/** Sitemap changefreq. Ignored when !indexable. */
	changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly';
}

export const ROUTES: readonly RouteDescriptor[] = [
	// ─── Public landing pages (high SEO priority) ────────────────
	{ path: '/', key: 'home', indexable: true, priority: 1.0, changefreq: 'weekly' },
	{ path: '/orderbook', key: 'orderbook', indexable: true, priority: 0.9, changefreq: 'daily' },
	{ path: '/faq', key: 'faq', indexable: true, priority: 0.9, changefreq: 'weekly' },
	{ path: '/onboarding', key: 'onboarding', indexable: true, priority: 0.8, changefreq: 'monthly' },
	{ path: '/download', key: 'download', indexable: true, priority: 0.7, changefreq: 'weekly' },
	{ path: '/run-a-node', key: 'run_a_node', indexable: true, priority: 0.7, changefreq: 'monthly' },
	{ path: '/operators', key: 'operators', indexable: true, priority: 0.6, changefreq: 'weekly' },
	{ path: '/security', key: 'security', indexable: true, priority: 0.6, changefreq: 'monthly' },
	{ path: '/support', key: 'support', indexable: true, priority: 0.5, changefreq: 'monthly' },
	{
		path: '/about-this-instance',
		key: 'about_this_instance',
		indexable: true,
		priority: 0.5,
		changefreq: 'weekly'
	},
	{ path: '/instances', key: 'instances', indexable: true, priority: 0.5, changefreq: 'weekly' },
	{ path: '/compare', key: 'compare', indexable: true, priority: 0.5, changefreq: 'weekly' },
	{
		path: '/backup-keys',
		key: 'backup_keys',
		indexable: true,
		priority: 0.5,
		changefreq: 'monthly'
	},
	{
		path: '/privacy-terms',
		key: 'privacy_terms',
		indexable: true,
		priority: 0.4,
		changefreq: 'yearly'
	},
	{ path: '/plan', key: 'plan', indexable: true, priority: 0.4, changefreq: 'monthly' },
	// /glossary — added Part 89 (terminology reference page).  Closes
	// the seo.glossary in en.json that had no matching ROUTES entry
	// (Part 101 finding O-15).
	{ path: '/glossary', key: 'glossary', indexable: true, priority: 0.6, changefreq: 'monthly' },
	// /cheat-sheet — added Part 95 (printable one-page reference).
	// Same Part-101 reverse-drift fix.
	{ path: '/cheat-sheet', key: 'cheat_sheet', indexable: true, priority: 0.5, changefreq: 'monthly' },
	// /privacy — added Part 122 cp26 (per-asset privacy guide index).
	// The per-asset subpages (/privacy/btc, /privacy/xmr, /privacy/dash,
	// etc.) are dynamic via [asset] param; not enumerated in the static
	// sitemap to avoid coupling the SEO route registry to the asset
	// registry.  Search engines discover the per-asset pages via the
	// index page's internal links.
	{ path: '/privacy', key: 'privacy_index', indexable: true, priority: 0.6, changefreq: 'monthly' },

	// ─── Non-indexable: auth / mid-funnel / user-specific ────────
	// These pages get <Head /> tags (so they have decent titles if
	// someone opens DevTools or shares a link in chat), but they
	// don't belong in the sitemap — either because the URL requires
	// auth to be meaningful, or because the page is a transient
	// mid-funnel step.
	{
		path: '/onboarding/import',
		key: 'onboarding_import',
		indexable: false,
		priority: 0.3,
		changefreq: 'yearly'
	},
	{
		path: '/onboarding/register-name',
		key: 'register_name',
		indexable: false,
		priority: 0.3,
		changefreq: 'yearly'
	},
	{ path: '/login', key: 'login', indexable: false, priority: 0.2, changefreq: 'yearly' },
	{
		path: '/login/qr-pair',
		key: 'login_qr',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},
	{ path: '/scan-login', key: 'scan_login', indexable: false, priority: 0.2, changefreq: 'yearly' },
	{ path: '/settings', key: 'settings', indexable: false, priority: 0.2, changefreq: 'yearly' },
	{ path: '/my/orders', key: 'my_orders', indexable: false, priority: 0.2, changefreq: 'yearly' },
	{ path: '/post', key: 'post_order', indexable: false, priority: 0.2, changefreq: 'yearly' },
	{
		path: '/post/edit/[permlink]',
		key: 'edit_order',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},
	{ path: '/chat', key: 'chat_inbox', indexable: false, priority: 0.2, changefreq: 'yearly' },

	// ─── Non-indexable: operator-only admin surfaces ──────────────
	// Operator-facing config-generators.  Never useful in search
	// results — operators arrive here from RUN-A-MORPHIT-NODE
	// docs, not via Google.  Indexable: false keeps them out of
	// sitemap.xml.
	{
		path: '/admin/setup-wizard',
		key: 'admin_setup_wizard',
		indexable: false,
		priority: 0.1,
		changefreq: 'yearly'
	},

	// ─── Non-indexable: explorer (data lookups, dynamic + index) ─
	// The explorer surface is reachable via direct URL but its
	// pages don't add indexable content (every block / tx / account
	// is per-instance state, not canonical web content).
	{
		path: '/explorer',
		key: 'explorer_search',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},
	{
		path: '/explorer/activity',
		key: 'explorer_activity',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},
	{
		path: '/explorer/block/[block=blocknum]',
		key: 'explorer_block',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},
	{
		path: '/explorer/tx/[trx=trxid]',
		key: 'explorer_tx',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},
	{
		path: '/explorer/account/[name=account]',
		key: 'explorer_account',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},

	// ─── Non-indexable: dynamic routes (unbounded URL space) ─────
	// Profile and order-detail pages exist per-account (and per-
	// permlink). Head tags are still useful for share previews,
	// but we can't enumerate them for a sitemap.
	{
		path: '/[x+40][account=account]',
		key: 'profile',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},
	{
		path: '/[x+40][account=account]/[permlink=permlink]',
		key: 'order_detail',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},
	{
		path: '/chat/[peer=account]',
		key: 'chat_conversation',
		indexable: false,
		priority: 0.2,
		changefreq: 'yearly'
	},
	// cp112: per-asset privacy guide page (`/privacy/{ticker}`).  Pages
	// exist for every tradable ticker; not indexable in the sitemap to
	// avoid coupling the SEO registry to the asset registry, but they
	// MUST emit a full <Head /> (canonical, hreflang, OG, BreadcrumbList
	// JSON-LD) for share previews and per-asset rich-result eligibility.
	// The seo.privacy_asset.title key uses {asset} interpolation; the
	// caller passes titleValues={{ asset: ticker }}.
	{
		path: '/privacy/[asset]',
		key: 'privacy_asset',
		indexable: false,
		priority: 0.5,
		changefreq: 'monthly'
	}
] as const;

/** Look up a route by its resolved URL path. Returns undefined for
 *  unknown paths. For dynamic SvelteKit route patterns, this
 *  function doesn't attempt parameter matching — callers that need
 *  that should use $page.route.id instead. */
export function routeFor(path: string): RouteDescriptor | undefined {
	return (
		ROUTES.find((r) => r.path === path) ?? ROUTES.find((r) => r.path === path.replace(/\/$/, ''))
	);
}

/** The subset of ROUTES that appear in sitemap.xml. Exposed for the
 *  sitemap builder + any test that wants to assert the set. */
export const INDEXABLE_ROUTES: readonly RouteDescriptor[] = ROUTES.filter((r) => r.indexable);
