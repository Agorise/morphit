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
 *   - category  : 'crypto' | 'in_person' | 'by_mail' | 'online'.
 *                 'by_mail' (cp120) covers asynchronous mail-based
 *                 payment methods; currently only `cash_by_mail`.
 *                 Trades using by_mail methods unlock the in-chat
 *                 mailing-address-share + shipment-tracking pills.
 *   - assetExclusion : for crypto entries that map to a Morphit
 *                 trading asset, the asset code that should hide
 *                 this method when picking ("buy BTC with BTC"
 *                 makes no sense).  Undefined for non-crypto.
 *
 * Description text for each entry lives in
 * `apps/web/src/lib/i18n/locales/<loc>.json` under
 * `payment_method.<key>.description` so it's localizable.
 */

export type PaymentCategory = 'crypto' | 'in_person' | 'by_mail' | 'online';

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
	// BLURT / BTC / XMR / USDT are the tradable assets Morphit
	// supports.  Each can also serve as a payment method when the
	// OTHER asset is being traded (e.g. "buy BTC, pay with USDT").
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
		// Part 122 cp21 + cp23 DD — Bitcoin Cash as a payment
		// method.  Same Category-B semantics as USDT: when the
		// trade's traded asset is BCH, "pay with BCH" is hidden
		// (assetExclusion); when the traded asset is something
		// else, BCH appears as a selectable payment-rail chip.
		// Single-network mainnet, so no per-network picker —
		// CashAddr URI handles both bare and prefixed forms via
		// `buildPaymentUri` in chat/payload.ts.
		key: 'pay_bch',
		name: 'Bitcoin Cash (BCH)',
		url: 'https://bitcoincash.org',
		category: 'crypto',
		assetExclusion: 'BCH'
	},
	{
		key: 'pay_blurt',
		name: 'BLURT',
		url: 'https://blurt.blog',
		category: 'crypto',
		assetExclusion: 'BLURT'
	},
	{
		// Part 122 cp31 — Dai as a payment method.  Same Category-B
		// semantics as USDT/USDC: when the trade's traded asset is
		// DAI, "pay with DAI" is hidden (assetExclusion); when the
		// traded asset is something else, DAI appears as a
		// selectable payment-rail chip.  The specific network
		// (ERC-20 / Polygon / Base / Arbitrum — all 4 EVM) is
		// pinned at chat-time via AddressShareModal's DAI tab; the
		// picker itself doesn't disambiguate network.
		//
		// Part 122 cp32 — this entry was MISSING from cp31 and
		// surfaced as CODE-1 (HIGH) finding in the cp32 deep-deep:
		// DAI was wired as a tradable asset but not as a payment
		// rail.  Without this entry, a seller posting a BTC order
		// who wanted to accept DAI as payment had no way to pick
		// DAI from the payment-methods picker.  Closed inline.
		key: 'pay_dai',
		name: 'Dai (DAI)',
		url: 'https://makerdao.com',
		category: 'crypto',
		assetExclusion: 'DAI'
	},
	{
		// Part 122 cp27 — Dash as a payment method.  Same
		// Category-B semantics as BCH/LTC: when the trade's
		// traded asset is DASH, "pay with DASH" is hidden
		// (assetExclusion); when the traded asset is something
		// else, DASH appears as a selectable payment-rail chip.
		// Single-network mainnet, so no per-network picker —
		// the `dash:` URI handles both X-prefix P2PKH and
		// 7-prefix P2SH via the BIP-21 derivative scheme.
		key: 'pay_dash',
		name: 'Dash (DASH)',
		url: 'https://dash.org',
		category: 'crypto',
		assetExclusion: 'DASH'
	},
	{
		// Part 122 cp43 — Decred as a payment method.  Same
		// Category-B semantics as BCH/LTC/DASH/DOGE/ZEC/ARRR:
		// when the trade's traded asset is DCR, "pay with DCR"
		// is hidden (assetExclusion); when the traded asset is
		// something else, DCR appears as a selectable payment-
		// rail chip.  Single-network mainnet.  The `decred:`
		// URI (BIP-21-style) handles both receive-address
		// formats (Ds P2PKH-Secp256k1 and Dc P2SH).
		//
		// CP32 LL #36 INVARIANT: every tradable asset MUST also
		// be wired as a payment rail.  Cp43 ships DCR with the
		// payment-rail axis as a same-turn deliverable per the
		// pattern established for DOGE at cp33, ZEC at cp39,
		// and ARRR at cp41.
		key: 'pay_dcr',
		name: 'Decred (DCR)',
		url: 'https://decred.org',
		category: 'crypto',
		assetExclusion: 'DCR'
	},
	{
		// Part 122 cp33 — Dogecoin as a payment method.  Same
		// Category-B semantics as BCH/LTC/DASH: when the trade's
		// traded asset is DOGE, "pay with DOGE" is hidden
		// (assetExclusion); when the traded asset is something
		// else, DOGE appears as a selectable payment-rail chip.
		// Single-network mainnet (no L2 support — Dogecoin has
		// not activated segwit, so no native bech32 or rollup
		// integrations).  The `dogecoin:` URI handles both
		// D-prefix P2PKH and 9/A-prefix P2SH via the BIP-21
		// derivative scheme.
		//
		// CP32 LL #36 INVARIANT: every tradable asset MUST also
		// be wired as a payment rail.  Cp31 missed this for DAI
		// (closed in cp32 CODE-1); cp33 ships DOGE with the
		// payment-rail axis as a same-turn deliverable.
		key: 'pay_doge',
		name: 'Dogecoin (DOGE)',
		url: 'https://dogecoin.com',
		category: 'crypto',
		assetExclusion: 'DOGE'
	},
	{
		// Part 122 cp47 — Ethereum as a payment method.  Same
		// Category-B semantics as the other trade-only assets:
		// when the trade's traded asset is ETH, "pay with ETH"
		// is hidden (assetExclusion); when the traded asset is
		// something else, ETH appears as a selectable payment-
		// rail chip.  Single-network mainnet.  The `ethereum:`
		// URI (BIP-21-compatible EIP-681 simplified form)
		// handles native ETH transfers.
		//
		// CP32 LL #36 INVARIANT: every tradable asset MUST also
		// be wired as a payment rail.  Cp47 ships ETH with the
		// payment-rail axis as a same-turn deliverable per the
		// pattern established for DOGE at cp33, ZEC at cp39,
		// ARRR at cp41, DCR at cp43, SOL at cp45.
		key: 'pay_eth',
		name: 'Ethereum (ETH)',
		url: 'https://ethereum.org',
		category: 'crypto',
		assetExclusion: 'ETH'
	},
	{
		// Part 122 cp24 — Litecoin as a payment method.  Same
		// Category-B semantics as BCH: when the trade's traded
		// asset is LTC, "pay with LTC" is hidden (assetExclusion);
		// when the traded asset is something else, LTC appears as
		// a selectable payment-rail chip.  Single-network mainnet,
		// so no per-network picker — litecoin: URI handles all
		// address forms (L.../M.../3.../ltc1...) via the BIP-21
		// derivative scheme.
		key: 'pay_ltc',
		name: 'Litecoin (LTC)',
		url: 'https://litecoin.org',
		category: 'crypto',
		assetExclusion: 'LTC'
	},
	{
		key: 'pay_xmr',
		name: 'Monero (XMR)',
		url: 'https://www.getmonero.org',
		category: 'crypto',
		assetExclusion: 'XMR'
	},
	{
		// Part 122 cp41 — Pirate Chain as a payment method.  Same
		// Category-B semantics as BCH/LTC/DASH/DOGE/ZEC: when the
		// trade's traded asset is ARRR, "pay with ARRR" is hidden
		// (assetExclusion); when the traded asset is something
		// else, ARRR appears as a selectable payment-rail chip.
		// Single-network mainnet.  The `arrr:` URI (BIP-21-style)
		// handles the single address format: zs1 Sapling shielded
		// (bech32) — Pirate Chain has no transparent option, every
		// transaction goes through the shielded pool by construction.
		//
		// CP32 LL #36 INVARIANT: every tradable asset MUST also
		// be wired as a payment rail.  Cp41 ships ARRR with the
		// payment-rail axis as a same-turn deliverable per the
		// pattern established for DOGE in cp33 and ZEC in cp39.
		key: 'pay_arrr',
		name: 'Pirate Chain (ARRR)',
		url: 'https://piratechain.com',
		category: 'crypto',
		assetExclusion: 'ARRR'
	},
	{
		// Part 122 cp49 — Ripple as a payment method.  Cp32 LL #36
		// invariant: every tradable asset MUST also be wired as a
		// payment rail.
		key: 'pay_xrp',
		name: 'Ripple (XRP)',
		url: 'https://xrpl.org',
		category: 'crypto',
		assetExclusion: 'XRP'
	},
	{
		// Part 122 cp45 — Solana as a payment method.  Same
		// Category-B semantics as the other trade-only assets:
		// when the trade's traded asset is SOL, "pay with SOL"
		// is hidden (assetExclusion); when the traded asset is
		// something else, SOL appears as a selectable payment-
		// rail chip.  Single-network mainnet.  The `solana:`
		// URI (Solana Pay specification) handles native SOL
		// transfers.
		//
		// CP32 LL #36 INVARIANT: every tradable asset MUST also
		// be wired as a payment rail.  Cp45 ships SOL with the
		// payment-rail axis as a same-turn deliverable per the
		// pattern established for DOGE at cp33, ZEC at cp39,
		// ARRR at cp41, and DCR at cp43.
		key: 'pay_sol',
		name: 'Solana (SOL)',
		url: 'https://solana.com',
		category: 'crypto',
		assetExclusion: 'SOL'
	},
	{
		key: 'pay_usdt',
		name: 'Tether (USDT)',
		url: 'https://tether.to',
		category: 'crypto',
		// Mirror BTC/XMR/BLURT semantics — when the trade's asset
		// is USDT, "pay with USDT" doesn't make sense, so hide
		// this option in the payment-methods picker.  When the
		// trade's asset is BTC, XMR, BLURT, USDC, DAI, BCH, LTC,
		// DASH, or DOGE, USDT is a valid payment rail and shows up as a
		// selectable chip.  The specific network (ERC-20 / TRC-20
		// / SPL / BEP-20) is pinned at chat-time via
		// AddressShareModal's USDT tab; the picker itself doesn't
		// disambiguate network.
		assetExclusion: 'USDT'
	},
	{
		// Part 122 cp30 — USD Coin as a payment method.  Same
		// Category-B semantics as USDT: when the trade's traded
		// asset is USDC, "pay with USDC" is hidden
		// (assetExclusion); when the traded asset is something
		// else, USDC appears as a selectable payment-rail chip.
		// The specific network (ERC-20 / SPL / Base / Polygon) is
		// pinned at chat-time via AddressShareModal's USDC tab;
		// the picker itself doesn't disambiguate network.
		key: 'pay_usdc',
		name: 'USD Coin (USDC)',
		url: 'https://www.circle.com/usdc',
		category: 'crypto',
		assetExclusion: 'USDC'
	},
	{
		// Part 122 cp39 — Zcash as a payment method.  Same
		// Category-B semantics as BCH/LTC/DASH/DOGE: when the trade's
		// traded asset is ZEC, "pay with ZEC" is hidden
		// (assetExclusion); when the traded asset is something
		// else, ZEC appears as a selectable payment-rail chip.
		// Single-network mainnet.  The `zcash:` URI (ZIP-321)
		// handles all four address types: t1/t3 transparent
		// (base58), zs1 Sapling shielded (bech32), u1 Unified
		// Address (bech32m) — recipients pick the address type
		// that matches their preferred privacy posture.
		//
		// CP32 LL #36 INVARIANT: every tradable asset MUST also
		// be wired as a payment rail.  Cp39 ships ZEC with the
		// payment-rail axis as a same-turn deliverable per the
		// pattern established for DOGE in cp33.
		key: 'pay_zec',
		name: 'Zcash (ZEC)',
		url: 'https://z.cash',
		category: 'crypto',
		assetExclusion: 'ZEC'
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
		key: 'cash_in_person',
		name: 'Cash (in person)',
		url: null,
		category: 'in_person'
	},
	{
		key: 'precious_metals',
		name: 'Precious metals (gold/silver)',
		url: null,
		category: 'in_person'
	},

	// ─── By mail (cp120) ────────────────────────────────────────
	// Asynchronous mail-based payments.  Trades using these
	// methods unlock the in-chat mailing-address-share + shipment-
	// tracking pills.  Currently one entry; future additions like
	// money orders or postal money orders fit here.
	{
		key: 'cash_by_mail',
		name: 'Cash by mail',
		url: null,
		category: 'by_mail'
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
		key: 'shaparak',
		name: 'Shaparak (شاپرک)',
		url: 'https://www.cbi.ir/page/16092.aspx',
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
	'by_mail',
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
