import type { AssetTicker } from '@morphit/asset-registry';
/**
 * Morphit — canonical payment-methods registry (Batch L).
 *
 * Single source of truth for the payment methods Morphit supports
 * across instances.  Code-defined, NOT instance-editable: the
 * canonical list is the same on every Morphit instance so
 * cross-instance filtering by payment method matches reliably.
 *
 * Why code-defined and not chain-broadcast:
 *
 *   • Adding a payment method is a deliberate project decision
 *     (does it support P2P?  does it have a documented website?
 *     is it region-locked?).  Letting any operator broadcast new
 *     ones would let the canonical-vs-non-canonical distinction
 *     erode.
 *   • The list changes infrequently — adding a payment method is
 *     normal release-cadence work, not real-time content.
 *   • Operators who need region-specific additions can extend via
 *     the per-instance additions mechanism (see ADR-0021); their
 *     additions render alongside canonical entries with a
 *     "(this instance only)" badge and use a namespaced key
 *     (`@instance:foo`) so cross-instance filtering still works.
 *
 * Migration: orders posted before Batch L use free-text payment-
 * method strings.  The orderbook filter is tolerant of both —
 * see `apps/web/src/lib/payments/match.ts`.
 *
 * Categories alphabetized (Crypto, In Person, Online) per user
 * preference.  Within each category, entries alphabetized by
 * canonical name.
 *
 * Each entry carries:
 *   - key       : machine-readable id ([a-z0-9_]+, ≤32 chars).  Stored
 *                 on chain in the order's `payment_methods` array.
 *                 NEVER changes once shipped.  Renaming would break
 *                 every order that referenced the old key.
 *   - name      : display name (typically a brand name; not
 *                 translated since brand names don't translate).
 *   - url       : optional canonical website (https only).  May be
 *                 null for entries without a single canonical URL
 *                 (e.g. "Cash").
 *   - category  : 'crypto' | 'in_person' | 'online'.
 *   - assetExclusion : for crypto entries that map to a Morphit
 *                 trading asset, the asset code that should hide
 *                 this method when picking ("buy BTC with BTC"
 *                 makes no sense).  Undefined for non-crypto.
 *
 * Description text for each entry lives in
 * `apps/web/src/lib/i18n/locales/<loc>.json` under
 * `payment_method.<key>.description` so it's localizable.
 */

export type PaymentCategory = 'crypto' | 'in_person' | 'online';

export interface PaymentMethodEntry {
	readonly key: string;
	readonly name: string;
	readonly url: string | null;
	readonly category: PaymentCategory;
	/** Hide this method when the order's traded asset matches.
	 *  Only meaningful for crypto entries. */
	readonly assetExclusion?: AssetTicker;
}

/** All canonical entries.  Adding an entry: insert in
 *  alphabetical position within its category, ship the
 *  description i18n key in all 10 locales, add a smoke if the
 *  entry has unusual matching characteristics.
 *
 *  Removing an entry: don't.  Once shipped, an entry's key is
 *  forever — orders on chain reference it.  If a method
 *  becomes irrelevant, mark it deprecated in a future revision
 *  but keep the key in this array so old orders still resolve
 *  to a name. */
export const PAYMENT_METHODS: readonly PaymentMethodEntry[] = [
	// ─── Crypto ─────────────────────────────────────────────────
	// BLURT / BTC / XMR are the three assets Morphit supports.
	// Each can also serve as a payment method when the OTHER
	// asset is being traded (e.g. "buy BTC, pay with XMR").
	// `assetExclusion` hides the method when the order's traded
	// asset matches.  Alphabetized by display name.
	{
		key: 'pay_btc',
		name: 'Bitcoin (BTC)',
		url: 'https://bitcoin.org',
		category: 'crypto',
		assetExclusion: 'BTC'
	},
	{
		key: 'pay_blurt',
		name: 'BLURT',
		url: 'https://blurt.blog',
		category: 'crypto',
		assetExclusion: 'BLURT'
	},
	{
		key: 'pay_xmr',
		name: 'Monero (XMR)',
		url: 'https://www.getmonero.org',
		category: 'crypto',
		assetExclusion: 'XMR'
	},

	// ─── In Person ──────────────────────────────────────────────
	// Three options that cover the realistic spectrum of
	// face-to-face exchange.  "Barter (goods)" is intentionally
	// open-ended — the order's free-form `terms` field carries
	// what's actually being bartered ("orange trees," "used
	// bicycle," "raw garlic").
	{
		key: 'barter_goods',
		name: 'Barter (goods)',
		url: null,
		category: 'in_person'
	},
	{
		key: 'cash',
		name: 'Cash',
		url: null,
		category: 'in_person'
	},
	{
		key: 'precious_metals',
		name: 'Precious metals (gold/silver)',
		url: null,
		category: 'in_person'
	},

	// ─── Online ─────────────────────────────────────────────────
	// Alphabetized by display name.  Merchant-acquirer-only
	// services (Adyen, Braintree, Checkout.com, Mollie, Razorpay,
	// Stripe, Worldpay, Worldline, JPMorgan ChasePay, Shopify
	// Payments) deliberately excluded — they're not P2P-capable
	// from a regular user's perspective.
	{
		key: 'airwallex',
		name: 'Airwallex',
		url: 'https://www.airwallex.com',
		category: 'online'
	},
	{
		key: 'alipay',
		name: 'Alipay',
		url: 'https://www.alipay.com',
		category: 'online'
	},
	{
		key: 'amazon_pay',
		name: 'Amazon Pay',
		url: 'https://pay.amazon.com',
		category: 'online'
	},
	{
		key: 'apple_pay',
		name: 'Apple Pay',
		url: 'https://www.apple.com/apple-pay',
		category: 'online'
	},
	{
		key: 'bancontact',
		name: 'Bancontact',
		url: 'https://www.bancontact.com',
		category: 'online'
	},
	{
		key: 'bitso',
		name: 'Bitso',
		url: 'https://bitso.com',
		category: 'online'
	},
	{
		key: 'bizum',
		name: 'Bizum',
		url: 'https://bizum.es',
		category: 'online'
	},
	{
		key: 'blik',
		name: 'BLIK',
		url: 'https://blik.com',
		category: 'online'
	},
	{
		key: 'cash_app',
		name: 'Cash App',
		url: 'https://cash.app',
		category: 'online'
	},
	{
		key: 'gcash',
		name: 'GCash',
		url: 'https://www.gcash.com',
		category: 'online'
	},
	{
		key: 'google_pay',
		name: 'Google Pay',
		url: 'https://pay.google.com',
		category: 'online'
	},
	{
		key: 'ideal',
		name: 'iDEAL',
		url: 'https://www.ideal.nl',
		category: 'online'
	},
	{
		key: 'interac_etransfer',
		name: 'Interac e-Transfer',
		url: 'https://www.interac.ca/en/consumers/products/interac-e-transfer/',
		category: 'online'
	},
	{
		key: 'klarna',
		name: 'Klarna',
		url: 'https://www.klarna.com',
		category: 'online'
	},
	{
		key: 'mpesa',
		name: 'M-PESA',
		url: 'https://www.vodafone.com/about-vodafone/what-we-do/consumer-products-and-services/m-pesa',
		category: 'online'
	},
	{
		key: 'mercado_pago',
		name: 'Mercado Pago',
		url: 'https://www.mercadopago.com',
		category: 'online'
	},
	{
		key: 'mir',
		name: 'Mir',
		url: 'https://mironline.ru',
		category: 'online'
	},
	{
		key: 'mtn_momo',
		name: 'MTN MoMo',
		url: 'https://mtn.com/momo',
		category: 'online'
	},
	{
		key: 'oxxo_pay',
		name: 'Oxxo Pay',
		url: 'https://www.oxxo.com',
		category: 'online'
	},
	{
		key: 'payoneer',
		name: 'Payoneer',
		url: 'https://www.payoneer.com',
		category: 'online'
	},
	{
		key: 'paypal',
		name: 'PayPal',
		url: 'https://www.paypal.com',
		category: 'online'
	},
	{
		key: 'paytm',
		name: 'Paytm',
		url: 'https://paytm.com',
		category: 'online'
	},
	{
		key: 'payu',
		name: 'PayU',
		url: 'https://payu.com',
		category: 'online'
	},
	{
		key: 'pix',
		name: 'Pix',
		url: 'https://www.bcb.gov.br/en/financialstability/pix_en',
		category: 'online'
	},
	{
		key: 'przelewy24',
		name: 'Przelewy24',
		url: 'https://www.przelewy24.pl',
		category: 'online'
	},
	{
		key: 'revolut',
		name: 'Revolut',
		url: 'https://www.revolut.com',
		category: 'online'
	},
	{
		key: 'shebapay',
		name: 'ShebaPay',
		url: null,
		category: 'online'
	},
	{
		key: 'sofort',
		name: 'Sofort',
		url: 'https://www.sofort.com',
		category: 'online'
	},
	{
		key: 'spei',
		name: 'SPEI',
		url: 'https://www.banxico.org.mx/sistemas-de-pago/spei.html',
		category: 'online'
	},
	{
		key: 'square_cash',
		name: 'Square',
		url: 'https://squareup.com',
		category: 'online'
	},
	{
		key: 'unionpay',
		name: 'UnionPay',
		url: 'https://www.unionpay.com',
		category: 'online'
	},
	{
		key: 'venmo',
		name: 'Venmo',
		url: 'https://venmo.com',
		category: 'online'
	},
	{
		key: 'wechat_pay',
		name: 'WeChat Pay',
		url: 'https://pay.weixin.qq.com',
		category: 'online'
	},
	{
		key: 'wise',
		name: 'Wise',
		url: 'https://wise.com',
		category: 'online'
	},
	{
		key: 'zelle',
		name: 'Zelle',
		url: 'https://www.zellepay.com',
		category: 'online'
	}
];

/** Lookup by key.  Returns null for unknown keys (which is
 *  expected for legacy orders with free-text methods, or for
 *  instance-namespaced keys — those are looked up via the
 *  instance-additions store separately). */
const PAYMENT_METHOD_BY_KEY: ReadonlyMap<string, PaymentMethodEntry> = new Map(
	PAYMENT_METHODS.map((e) => [e.key, e])
);

export function findPaymentMethod(key: string): PaymentMethodEntry | null {
	return PAYMENT_METHOD_BY_KEY.get(key) ?? null;
}

/** Categories in display order (alphabetized per user
 *  preference).  Used by the picker UI to render section
 *  headers. */
export const PAYMENT_CATEGORIES_ORDERED: readonly PaymentCategory[] = [
	'crypto',
	'in_person',
	'online'
];

/** Group canonical entries by category, preserving alphabetical
 *  order within each.  Pure; cheap (called once per picker
 *  mount). */
export function groupByCategory(): ReadonlyMap<PaymentCategory, readonly PaymentMethodEntry[]> {
	const out = new Map<PaymentCategory, PaymentMethodEntry[]>();
	for (const cat of PAYMENT_CATEGORIES_ORDERED) {
		out.set(cat, []);
	}
	for (const e of PAYMENT_METHODS) {
		out.get(e.category)!.push(e);
	}
	return out;
}

/** Instance-namespaced key prefix.  Methods added by an operator
 *  via the instance-additions mechanism use keys like
 *  `@instance:promptpay` so they don't collide with canonical
 *  keys and so cross-instance filtering can detect them. */
export const INSTANCE_KEY_PREFIX = '@instance:';

export function isInstanceKey(key: string): boolean {
	return typeof key === 'string' && key.startsWith(INSTANCE_KEY_PREFIX);
}
