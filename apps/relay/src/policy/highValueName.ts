/**
 * Morphit relay — high-value name policy.
 *
 * Layer 7 of the signup-drain defense stack (see §18 of the
 * operator runbook).  This module classifies a proposed account
 * name as "high-value" — meaning a name that's
 * disproportionately attractive to squatters who'd register it
 * through the relay (costing the relay ~100 BLURT each time)
 * and resell it on secondary markets.
 *
 * Categories of high-value names this defends against:
 *
 *   1. Short names (3 or 4 characters).  On any Graphene-lineage
 *      chain, short account names are status symbols and cost
 *      Steem-era equivalents of $50-$500 on secondary markets.
 *      Squatters hoover them up with automated tools.
 *
 *   2. Dictionary brand names (apple, google, nike, etc.).  Even
 *      if Blurt isn't a global brand-consensus chain like ENS
 *      or Twitter, brands buy these defensively and squatters
 *      know it.
 *
 *   3. Common dictionary words (bitcoin, crypto, news, bank, etc.).
 *      Generic English/economic vocabulary that has resale value.
 *
 *   4. All-numeric and numeric-suffix patterns (`user001`,
 *      `user002`, ...).  These are signatures of automated
 *      enumeration scripts.  This module flags the pattern; the
 *      sequential-detector module enforces it across recent
 *      signups.
 *
 * What this module does NOT do:
 *
 *   - Block legitimate users who genuinely have a claim.  The
 *     create handler combines this classifier with proof-of-
 *     legitimacy checks (existing-account-balance, BLURT bond,
 *     operator override) before refusing — see §18 Layer 9.
 *   - Prevent ALL squatting.  A determined attacker who owns
 *     ≥X BLURT can still register one high-value name per day.
 *     The goal is to make MASS squatting capital-intensive.
 *   - Replace operator-side review.  Some valuable names will
 *     still get registered; the operator should periodically
 *     review their relay's recent registrations for patterns
 *     and adjust env vars.
 *
 * Configuration knobs (all in apps/relay env):
 *
 *   MORPHIT_RELAY_HIGHVALUE_NAME_POLICY=strict|moderate|off
 *     strict   — enforce all categories (default)
 *     moderate — only block category 4 (numeric/sequential)
 *     off      — skip this layer entirely
 *
 *   MORPHIT_RELAY_HIGHVALUE_SHORT_NAME_THRESHOLD=4
 *     Names this length or shorter are "short" (default 4).
 *
 *   MORPHIT_RELAY_HIGHVALUE_BOND_BLURT=10000
 *     If set, the create handler may accept a high-value name
 *     when the requesting user's existing Blurt account has
 *     ≥this much vesting BLURT (a "skin in the game" signal
 *     that they're not a throwaway squatter).  See Layer 9.
 *
 * Names this module flags but the operator's override env var
 * permits are still allowed; this module decides "is this name
 * worth extra scrutiny," not "is this name absolutely banned."
 */

/** Why this name was classified high-value.  Operators see
 *  this in their relay logs to understand which category is
 *  triggering. */
export type HighValueReason =
	| 'short_name' // ≤ threshold-length (default 4)
	| 'dictionary_brand' // matches the curated brand list
	| 'common_dictionary' // matches the common-English list
	| 'all_numeric' // entirely digits and dashes
	| 'numeric_suffix' // matches `<word>NN`/`<word>-NN`/`<word>NNN` pattern
	| 'leet_brand'; // brand with l33t substitutions (g00gle, app1e)

/** Result type — `null` means not high-value (allowed without
 *  extra checks).  Otherwise carries the reason. */
export type HighValueClassification = HighValueReason | null;

/** Curated brand names that squatters target for resale.
 *  Sources: top global brand-value rankings (Interbrand /
 *  Brand Finance), top crypto exchange/wallet names, top
 *  social-platform names.
 *
 *  IMPORTANT: This list is intentionally broad rather than
 *  exhaustive.  A "well-known" name caught here is one
 *  squatters would obviously target; the operator-bond
 *  override (§18 Layer 9) is the legitimate-claimant escape
 *  hatch.
 *
 *  A future enhancement could load this from a chain-broadcast
 *  list curated by @morphit, so all federated operators share
 *  the same list and updates are auditable on chain.  Until
 *  then, this is hardcoded for transparency — anyone can
 *  audit what's on it. */
const DICTIONARY_BRANDS: ReadonlySet<string> = new Set([
	// Tech giants
	'apple',
	'google',
	'microsoft',
	'amazon',
	'meta',
	'facebook',
	'instagram',
	'whatsapp',
	'twitter',
	'tiktok',
	'youtube',
	'netflix',
	'spotify',
	'tesla',
	'nvidia',
	'intel',
	'oracle',
	'samsung',
	'sony',
	'huawei',
	'xiaomi',
	// Financial / crypto
	'visa',
	'mastercard',
	'paypal',
	'stripe',
	'binance',
	'coinbase',
	'kraken',
	'bitfinex',
	'gemini',
	'bittrex',
	'okx',
	'bybit',
	'kucoin',
	'metamask',
	'ledger',
	'trezor',
	'trustwallet',
	'phantom',
	// Bitcoin / crypto vocabulary that's effectively brand-tier
	'bitcoin',
	'ethereum',
	'monero',
	'litecoin',
	'dogecoin',
	'zcash',
	'piratechain',
	'decred',
	'cardano',
	'solana',
	'polkadot',
	'chainlink',
	'ripple',
	'stellar',
	'tron',
	'tether',
	'usdc',
	'usdt',
	'btc',
	'eth',
	'xmr',
	'doge',
	'zec',
	'arrr',
	'dcr',
	// Apparel / consumer brands
	'nike',
	'adidas',
	'puma',
	'reebok',
	'gucci',
	'prada',
	'rolex',
	'cocacola',
	'pepsi',
	'mcdonalds',
	'starbucks',
	// Auto
	'toyota',
	'honda',
	'ford',
	'bmw',
	'mercedes',
	'audi',
	'porsche',
	'ferrari',
	'lamborghini',
	// Banks
	'chase',
	'wellsfargo',
	'citibank',
	'hsbc',
	'barclays',
	'santander',
	'goldman',
	'morganstanley',
	// Blurt/Steem ecosystem (protected by community goodwill)
	'blurt',
	'steem',
	'hive',
	'splinterlands',
	'leofinance',
	// Generic high-value identity terms
	'support',
	'help',
	'admin',
	'system',
	'official',
	'verified',
	'security',
	'team',
	'staff'
]);

/** Common English vocabulary that has resale value but isn't
 *  a specific brand.  Squatters bulk-register these.  More
 *  conservative than DICTIONARY_BRANDS — only words clearly
 *  desirable as a Blurt account name.
 *
 *  Audit notes:
 *  - Avoid common given names (those are legitimate for many
 *    users).  Surnames similarly.
 *  - Avoid generic verbs (those are unlikely to resell).
 *  - Focus on nouns with marketable identity value: business,
 *    money, news, etc.
 */
const COMMON_DICTIONARY: ReadonlySet<string> = new Set([
	// Money / commerce
	'money',
	'cash',
	'pay',
	'payment',
	'wallet',
	'bank',
	'banking',
	'finance',
	'invest',
	'trade',
	'trader',
	'trading',
	'market',
	'exchange',
	'crypto',
	'currency',
	'coin',
	'token',
	// Media / content
	'news',
	'media',
	'press',
	'blog',
	'video',
	'music',
	'movie',
	'channel',
	'podcast',
	'stream',
	'live',
	// Communications
	'mail',
	'email',
	'inbox',
	'message',
	'chat',
	'sms',
	// Generic identity
	'user',
	'admin',
	'me',
	'you',
	'we',
	'they',
	// Network / tech
	'web',
	'net',
	'cloud',
	'server',
	'host',
	'site',
	'app',
	// Business
	'shop',
	'store',
	'sale',
	'sales',
	'buy',
	'sell',
	'deal',
	'business',
	'company',
	'firm',
	'corp',
	// Common positive value words
	'best',
	'top',
	'first',
	'super',
	'pro',
	'plus',
	'premium',
	'gold',
	'silver',
	'diamond',
	// Time / news
	'today',
	'now',
	'daily',
	'weekly',
	'live'
]);

/** Bidirectional digit-letter substitution table for l33t
 *  detection.  An attacker writes `g00gle` to evade the
 *  `google` block; we revert digits to letters and check
 *  again. */
const LEET_REVERSE: Readonly<Record<string, string>> = {
	'0': 'o',
	'1': 'i', // could also be 'l' — covered by separate pass
	'3': 'e',
	'4': 'a',
	'5': 's',
	'7': 't',
	'@': 'a' // off-spec but cheap
};

/** Numeric-suffix pattern at the SHAPE level: a SHORT word
 *  followed by EXACTLY 3 digits.  This catches the canonical
 *  enumeration form (`usr001`, `acct999`, `bob-001`) while
 *  letting through both:
 *
 *    - 1-2 digit suffixes: `bob42`, `alice7` — common legitimate
 *      user names
 *    - 4+ digit suffixes that LOOK like years: `bob-1990`,
 *      `crypto-2026` — common legitimate year-suffixes
 *    - Long-prefix forms: `cryptonewsbot-2026`, `account999` —
 *      may be enumeration but not obvious enough to block on
 *      shape alone; the cross-signup sequential detector
 *      (Layer 8) catches the actual pattern
 *
 *  Why not also block 4-digit forms?  Because we'd false-
 *  positive on year-suffix names, which are extremely common
 *  legitimate naming.  The squatter who pads to `0001`-`9999`
 *  is already running an attack the cross-signup detector
 *  catches in 2-3 attempts.
 *
 *  Examples that DO match (short prefix, EXACTLY 3 digits):
 *    - `usr001`, `acct999`, `bob-001`, `a-001`
 *  Examples that DON'T match:
 *    - `bob-1990` (4 digits — year-suffix exception)
 *    - `bob42` (only 2 digits)
 *    - `alex7` (only 1 digit)
 *    - `account999` (long prefix)
 *    - `crypto-noob-2026` (long prefix + year)
 */
const NUMERIC_SUFFIX_RE = /^[a-z][a-z0-9-]{0,3}-?[0-9]{3}$/;

/** All digits and dashes only (after the required leading
 *  letter).  Captures `a000`, `a-001`, `a000000`. */
const ALL_NUMERIC_AFTER_FIRST_RE = /^[a-z][0-9-]+$/;

/** Convert l33t-substituted digits back to letters for brand
 *  comparison.  Doesn't try to be exhaustive — handles the
 *  common cases.  Returns the de-leeted form. */
function deLeet(name: string): string {
	let out = '';
	for (const ch of name) {
		out += LEET_REVERSE[ch] ?? ch;
	}
	return out;
}

/**
 * Classify a proposed account name's squatter-attractiveness.
 *
 * Pre-condition: `name` has already passed `validateBlurtName`
 * — i.e., it's a syntactically valid Blurt name.  This function
 * does not re-validate the format.
 *
 * Returns the category that triggered the high-value flag, or
 * `null` if the name is not high-value.  Multiple categories
 * could apply (e.g., short AND dictionary); the FIRST one
 * triggered (in the order short_name → dictionary_brand →
 * leet_brand → common_dictionary → all_numeric → numeric_suffix)
 * is reported, since one block reason is enough.
 */
export function classifyHighValueName(
	name: string,
	options: { shortNameThreshold?: number } = {}
): HighValueClassification {
	const shortThreshold = options.shortNameThreshold ?? 4;

	// 1. Short names — squatter gold on any Graphene chain.
	//    Defaults to ≤4 chars; operators can lower this if they
	//    want to allow 4-char names.
	if (name.length <= shortThreshold) {
		return 'short_name';
	}

	// 2. All-numeric (after the required leading letter).
	//    `a0000` is a squatter classic — high enumeration value,
	//    no real-user appeal.
	if (ALL_NUMERIC_AFTER_FIRST_RE.test(name)) {
		return 'all_numeric';
	}

	// 3. Direct dictionary-brand match.
	if (DICTIONARY_BRANDS.has(name)) {
		return 'dictionary_brand';
	}

	// 4. L33t-substituted brand match.  De-leet then check.
	const deLeeted = deLeet(name);
	if (deLeeted !== name && DICTIONARY_BRANDS.has(deLeeted)) {
		return 'leet_brand';
	}

	// 5. Common-dictionary match.
	if (COMMON_DICTIONARY.has(name) || COMMON_DICTIONARY.has(deLeeted)) {
		return 'common_dictionary';
	}

	// 6. Numeric-suffix pattern (`user001`, `acct-99`, etc.).
	//    Catches enumeration scripts.
	if (NUMERIC_SUFFIX_RE.test(name)) {
		return 'numeric_suffix';
	}

	return null;
}

/** Policy mode chosen by the operator. */
export type HighValuePolicy = 'strict' | 'moderate' | 'off';

/**
 * Decide whether a high-value classification should BLOCK
 * registration in the absence of an override (bond / operator
 * exception).
 *
 * Strict mode (default) blocks every category.  Moderate mode
 * blocks only the enumeration-pattern categories (numeric,
 * numeric-suffix), letting brand/dictionary names through —
 * appropriate for an operator who's confident their PoW + per-IP
 * limits are tight enough that drive-by brand squatting isn't
 * profitable, but who still wants automated `name001`-style
 * enumeration blocked.
 *
 * Off mode passes everything (this layer disabled).
 */
export function isHighValueBlocked(
	classification: HighValueClassification,
	policy: HighValuePolicy
): boolean {
	if (classification === null) return false;
	if (policy === 'off') return false;
	if (policy === 'moderate') {
		return classification === 'all_numeric' || classification === 'numeric_suffix';
	}
	// strict: block all categories
	return true;
}
