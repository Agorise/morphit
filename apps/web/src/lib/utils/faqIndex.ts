/**
 * Morphit — FAQ search index
 *
 * Builds a lightweight in-memory search index over FAQ entries in the
 * active locale. Tokenizes questions + answers, normalizes (case-fold,
 * diacritic-strip), and offers prefix + substring matching with a
 * scoring function that combines:
 *   - full-phrase substring matching (raw query vs question/answer)
 *   - per-token matching against question and answer
 *   - synonym expansion (common user-speak mapped to FAQ canon)
 *   - IDF-style rare-token weighting so specific terms beat generic ones
 *   - stopword filtering so "how/the/a/is" don't dominate
 *
 * No external search library, keeps the bundle tiny.
 */

import { derived, type Readable } from 'svelte/store';
import { _, locale } from 'svelte-i18n';

/** FAQ entry keys — must match the JSON structure in locales/*.json.
 *  Ordered for reader flow: intro → safety → discovery → onboarding
 *  → incentives → ecosystem → abuse-mitigation → ops. New entries
 *  go into a thematic cluster, not appended. */
export const FAQ_KEYS = [
	'what_is_morphit',
	'is_it_safe',
	'security_attack_vectors',
	'security_engineering_rigor',
	'how_morphit_protects_me',
	'vs_others',
	'video_tutorial',
	'signup_requirements',
	'signup_stuck',
	'kyc_requirement',
	'supported_countries',
	'supported_fiat_currencies',
	'how_to_buy',
	'how_to_sell',
	'how_to_trade_walkthrough',
	'how_to_leave_feedback',
	'mobile_desktop',
	'in_person_vs_online',
	'fees',
	'trade_goods_services',
	'trade_size_limits',
	'first_order_free',
	'welcome_bonus',
	'loyalty_milestones',
	'blurt_benefits',
	'where_to_buy_blurt',
	'what_is_blurt',
	'what_is_mana',
	'order_timeouts',
	'order_editing',
	'order_fee_rejected',
	'share_order_link',
	'counterparty_disappears',
	'what_is_reputation',
	'profile_pages',
	'profile_own_vs_others',
	'scam_patterns',
	'taxes',
	'chat_privacy',
	'monero_amount_jitter',
	'what_is_morphit_chat',
	'chat_key_loss',
	'chat_key_changed',
	'why_chat_on_chain',
	'chat_dispute_recourse',
	'chat_vs_feedback_visibility',
	'chat_inbox_features',
	'no_escrow_arbitration',
	'feedback_immutable',
	'feedback_reply',
	'feedback_suppressed',
	'reviews_given_visibility',
	'data_collection',
	'lost_keys',
	'backup_practices',
	'private_key_warning',
	'privacy_mode',
	'privacy_practices',
	'use_vpn',
	'activity_level',
	'new_trader_badge',
	'verified_chat_badge',
	'sybil_protection',
	'chat_anti_spam',
	'block_privacy',
	'why_self_trading_fails',
	'why_multi_accounts_fail',
	'no_js',
	'no_js_limits',
	'rss_feeds',
	'why_fresh_addresses',
	'who_runs_it',
	'switching_instances',
	'run_your_own',
	'how_to_run_node',
	'node_technical_skills',
	'node_hosting_costs',
	'node_minimum_requirements',
	'how_operators_earn',
	'how_to_find_good_operator',
	'help_make_unstoppable',
	'rogue_operator',
	'xmr_txid',
	'xmr_tx_proof',
	'block_explorer',
	'app_stores',
	'iphone_install',
	'android_sideload',
	'operator_registration',
	'operator_payouts_timing',
	'operator_moderation',
	'chat_identity_key',
	'forward_secrecy',
	'syndicate_trade_announcement',
	'offline_caching',
	'lock_vs_signout',
	'auto_lock_timeout',
	'push_notifications_privacy',
	'user_hide_accounts',
	'what_is_featured_slot',
	'featured_slot_displaced',
	'verify_peer_fingerprint',
	'public_api',
	'qr_login',
	'what_is_usdt',
	'why_usdt_warning',
	'which_usdt_network',
	'arbitrage_morphit_vs_exchanges'
] as const;

export type FaqKey = (typeof FAQ_KEYS)[number];

/**
 * Related-entry graph for cross-navigation. When the user expands
 * an FAQ entry that has a non-empty related list, a "Related" row
 * renders below the answer with clickable pill chips.
 *
 * Relatedness is structural, not copy — it lives here, not in the
 * i18n JSON, because the graph must not drift across locales. If a
 * key is missing from this map, it has no related entries (the UI
 * simply doesn't render the row).
 *
 * Curation principles:
 *  - 0-4 entries per key. More than 4 becomes noise.
 *  - Ordered by strength of relationship (strongest first).
 *  - Bidirectional where it makes sense — if A→B is strong, B→A
 *    is usually also listed (but not required by the code).
 *  - Every target must be a valid FaqKey. TypeScript enforces this.
 */
export const FAQ_RELATED: Partial<Record<FaqKey, readonly FaqKey[]>> = {
	// Intro + framing cluster — helps new readers orient between
	// "what is this" and the handful of pages they should read next.
	what_is_morphit: ['vs_others', 'is_it_safe', 'how_to_trade_walkthrough'],
	vs_others: ['what_is_morphit', 'is_it_safe', 'who_runs_it'],

	// Fees + incentives cluster
	fees: [
		'first_order_free',
		'blurt_benefits',
		'welcome_bonus',
		'order_fee_rejected',
		'trade_goods_services'
	],
	first_order_free: ['fees', 'welcome_bonus'],
	welcome_bonus: ['first_order_free', 'loyalty_milestones', 'blurt_benefits', 'signup_stuck'],
	trade_goods_services: ['fees', 'in_person_vs_online'],

	// Signup audit (Findings N1, N3, N6, N7, N14, N19, N22, N23,
	// N27, N28).  Catch-all explainer for relay-side errors a
	// user might hit during account creation: rate-limited,
	// daily-ceiling-reached, invite-IP-mismatch, signups-disabled,
	// relay-out-of-funds, name-validation, name-reserved, and
	// chain-broadcast-failed.  Wires into both the requirements
	// cluster (signup_requirements) and the post-signup cluster
	// (welcome_bonus).
	signup_stuck: [
		'signup_requirements',
		'welcome_bonus',
		'blurt_benefits',
		'how_morphit_protects_me'
	],
	loyalty_milestones: ['blurt_benefits', 'welcome_bonus'],
	blurt_benefits: [
		'fees',
		'loyalty_milestones',
		'where_to_buy_blurt',
		'what_is_blurt',
		'what_is_mana'
	],
	where_to_buy_blurt: ['blurt_benefits', 'first_order_free', 'fees'],
	what_is_blurt: ['blurt_benefits', 'where_to_buy_blurt', 'why_chat_on_chain', 'what_is_mana'],
	what_is_mana: ['what_is_blurt', 'blurt_benefits', 'welcome_bonus'],

	// Reputation + feedback cluster. The "chat_vs_feedback_visibility"
	// entry bridges to the chat cluster and belongs here from the
	// feedback side.
	what_is_reputation: [
		'how_to_leave_feedback',
		'feedback_immutable',
		'feedback_suppressed',
		'new_trader_badge',
		'chat_vs_feedback_visibility'
	],
	how_to_leave_feedback: [
		'what_is_reputation',
		'feedback_immutable',
		'chat_vs_feedback_visibility'
	],
	feedback_immutable: [
		'what_is_reputation',
		'feedback_reply',
		'feedback_suppressed',
		'verified_chat_badge',
		'chat_vs_feedback_visibility'
	],
	feedback_reply: ['feedback_immutable', 'reviews_given_visibility'],
	feedback_suppressed: [
		'what_is_reputation',
		'feedback_immutable',
		'sybil_protection',
		'chat_vs_feedback_visibility'
	],
	reviews_given_visibility: ['feedback_reply', 'what_is_reputation', 'chat_vs_feedback_visibility'],
	new_trader_badge: ['what_is_reputation', 'activity_level', 'verified_chat_badge'],
	verified_chat_badge: [
		'what_is_reputation',
		'feedback_immutable',
		'sybil_protection',
		'chat_anti_spam'
	],

	// Profile + order-detail cluster
	profile_pages: ['profile_own_vs_others', 'share_order_link'],
	profile_own_vs_others: ['profile_pages'],
	share_order_link: ['order_editing', 'profile_pages'],

	// Security + keys cluster
	private_key_warning: ['backup_practices', 'lost_keys'],
	backup_practices: ['lost_keys', 'private_key_warning', 'chat_key_loss'],
	lost_keys: ['backup_practices', 'private_key_warning'],

	// Chat cluster — all entries describe or link back to ADR-0015
	// ECIES-based crypto. Cross-links keep readers oriented whether
	// they enter from a crypto angle (chat_privacy, forward_secrecy),
	// a UX angle (what_is_morphit_chat, why_chat_on_chain), or a
	// dispute/permanence angle (chat_dispute_recourse,
	// chat_vs_feedback_visibility). The two "what's visible vs what's
	// private" entries also bridge to the feedback cluster.
	what_is_morphit_chat: [
		'chat_privacy',
		'chat_inbox_features',
		'chat_identity_key',
		'chat_vs_feedback_visibility'
	],
	chat_identity_key: [
		'what_is_morphit_chat',
		'chat_key_loss',
		'chat_key_changed',
		'forward_secrecy',
		'verify_peer_fingerprint'
	],
	chat_privacy: [
		'what_is_morphit_chat',
		'chat_inbox_features',
		'chat_vs_feedback_visibility',
		'forward_secrecy',
		'monero_amount_jitter'
	],
	monero_amount_jitter: ['chat_privacy', 'data_collection'],
	chat_key_loss: ['chat_identity_key', 'backup_practices'],

	// Chain-anchored TOFU pin (Option 5 / S2 mitigation, ADR-0015):
	// the user-facing explainer for the four "We couldn't safely
	// send" cases.  Wires into the chat-privacy + chat-identity
	// cluster on one side, and the broader security-narrative
	// cluster (how_morphit_protects_me) on the other.
	chat_key_changed: [
		'chat_privacy',
		'chat_identity_key',
		'what_is_morphit_chat',
		'how_morphit_protects_me'
	],
	why_chat_on_chain: ['chat_dispute_recourse', 'chat_privacy', 'what_is_morphit_chat'],
	forward_secrecy: ['chat_privacy', 'chat_identity_key', 'chat_key_loss'],
	chat_dispute_recourse: [
		'why_chat_on_chain',
		'no_escrow_arbitration',
		'chat_privacy',
		'counterparty_disappears'
	],
	chat_vs_feedback_visibility: [
		'chat_privacy',
		'feedback_immutable',
		'what_is_morphit_chat',
		'chat_dispute_recourse'
	],

	// Trading flow
	how_to_buy: ['how_to_sell', 'how_to_trade_walkthrough'],
	how_to_sell: ['how_to_buy', 'how_to_trade_walkthrough'],
	how_to_trade_walkthrough: [
		'how_to_buy',
		'how_to_sell',
		'how_to_leave_feedback',
		'in_person_vs_online'
	],
	in_person_vs_online: ['how_to_trade_walkthrough', 'scam_patterns'],
	trade_size_limits: ['fees', 'first_order_free'],
	order_timeouts: ['order_editing'],
	order_editing: ['order_timeouts', 'share_order_link', 'order_fee_rejected'],

	// Order-placement audit (Findings O8/O18/O19/O27/O28/O30):
	// the user-facing explainer for what each fee_status means
	// when an order isn't appearing in the orderbook.  Wires
	// into the order-management cluster (order_editing /
	// order_timeouts) and the fee-economy cluster (fees /
	// first_order_free).
	order_fee_rejected: ['fees', 'order_editing', 'first_order_free', 'order_timeouts'],

	// Abuse resistance. counterparty_disappears now points at
	// chat_dispute_recourse because its existing answer already
	// advises "use the encrypted chat to confirm every step so
	// there's a trail if things go wrong" — the new entry explains
	// exactly how that trail works. chat_anti_spam joins this
	// cluster as the in-depth article on the three-layer defense
	// against unsolicited messaging — sybil_protection is fee
	// abuse, chat_anti_spam is contact-channel abuse, both share
	// the same economic-deterrent design pattern.
	sybil_protection: [
		'why_self_trading_fails',
		'why_multi_accounts_fail',
		'chat_anti_spam',
		'feedback_suppressed'
	],
	why_self_trading_fails: ['why_multi_accounts_fail', 'sybil_protection'],
	why_multi_accounts_fail: ['why_self_trading_fails', 'sybil_protection'],
	scam_patterns: ['how_morphit_protects_me', 'counterparty_disappears', 'feedback_immutable'],
	counterparty_disappears: ['scam_patterns', 'no_escrow_arbitration', 'chat_dispute_recourse'],

	// Operator + decentralization. operator_moderation and
	// switching_instances get links so readers who land on those
	// concrete questions can navigate to the bigger "who runs this
	// / can it be taken down" framing.
	run_your_own: ['how_to_run_node', 'help_make_unstoppable', 'node_minimum_requirements'],
	how_to_run_node: [
		'run_your_own',
		'how_operators_earn',
		'node_technical_skills',
		'node_minimum_requirements'
	],
	node_minimum_requirements: ['node_hosting_costs', 'how_to_run_node', 'node_technical_skills'],
	how_operators_earn: ['operator_registration', 'operator_payouts_timing'],
	operator_registration: ['how_operators_earn', 'how_to_find_good_operator'],
	operator_payouts_timing: ['how_operators_earn'],
	how_to_find_good_operator: ['rogue_operator', 'who_runs_it'],
	rogue_operator: ['how_to_find_good_operator', 'who_runs_it'],
	who_runs_it: ['run_your_own', 'rogue_operator'],
	help_make_unstoppable: ['run_your_own', 'how_to_run_node'],
	switching_instances: ['who_runs_it', 'run_your_own', 'how_to_find_good_operator'],
	operator_moderation: ['rogue_operator', 'how_to_find_good_operator'],

	// Safety + privacy. no_escrow_arbitration now links to
	// chat_dispute_recourse — readers asking "why no arbitration"
	// benefit from seeing what the chat record does give them.
	// how_morphit_protects_me is the umbrella defenses-stack
	// article that pulls together architecture + scanner + chat
	// gates + block + no-data-collection into one read; both
	// is_it_safe and security_attack_vectors point at it as the
	// "more detail" landing.
	is_it_safe: [
		'how_morphit_protects_me',
		'security_attack_vectors',
		'security_engineering_rigor',
		'no_escrow_arbitration',
		'vs_others'
	],
	security_attack_vectors: ['how_morphit_protects_me', 'security_engineering_rigor', 'is_it_safe'],
	security_engineering_rigor: [
		'security_attack_vectors',
		'how_morphit_protects_me',
		'is_it_safe',
		'data_collection'
	],
	how_morphit_protects_me: [
		'security_attack_vectors',
		'security_engineering_rigor',
		'private_key_warning',
		'chat_anti_spam',
		'chat_key_changed',
		'data_collection'
	],
	no_escrow_arbitration: ['counterparty_disappears', 'chat_dispute_recourse', 'feedback_immutable'],
	privacy_mode: ['lock_vs_signout', 'auto_lock_timeout'],
	lock_vs_signout: ['privacy_mode', 'auto_lock_timeout'],
	auto_lock_timeout: ['privacy_mode', 'lock_vs_signout'],
	privacy_practices: ['use_vpn', 'why_fresh_addresses', 'rss_feeds'],
	use_vpn: ['privacy_practices'],
	why_fresh_addresses: ['privacy_practices', 'xmr_txid'],
	xmr_tx_proof: ['xmr_txid', 'privacy_practices', 'why_fresh_addresses'],
	push_notifications_privacy: ['chat_inbox_features', 'privacy_practices', 'lock_vs_signout'],

	// RSS — referenced by the global footer pill, per-asset
	// orderbook link, and per-trader profile link. Privacy
	// tradeoff (per-trader URL is slightly more revealing than
	// per-asset / global) documented in the entry itself; the
	// related cluster pulls in no_js (RSS as a browserless
	// surface), privacy_practices (the timing-correlation
	// story), and chat_inbox_features (RSS is the lightweight
	// alternative to in-app follow notifications).
	rss_feeds: ['no_js', 'privacy_practices', 'chat_inbox_features'],

	// Chat cluster — chat_inbox_features describes the inbox UX
	// (Messages/Requests tabs, unread counts, block/hide/unblock).
	// chat_anti_spam is paired here because the inbox surface is
	// where the anti-spam economics become visible to the user
	// (a "stranger paid to message you" tag, the Requests tab).
	// The original chat-cluster entries (chat_privacy,
	// what_is_morphit_chat) get chat_inbox_features merged in
	// at their existing definitions above.
	chat_inbox_features: [
		'chat_anti_spam',
		'chat_privacy',
		'user_hide_accounts',
		'push_notifications_privacy'
	],
	chat_anti_spam: [
		'chat_inbox_features',
		'sybil_protection',
		'how_morphit_protects_me',
		'fees',
		'block_privacy'
	],
	block_privacy: ['chat_anti_spam', 'chat_inbox_features', 'how_morphit_protects_me'],

	// KYC + access
	kyc_requirement: ['data_collection', 'supported_countries'],
	supported_countries: ['kyc_requirement'],
	data_collection: ['kyc_requirement', 'how_morphit_protects_me'],

	// Hide vs block. user_hide_accounts is orderbook-side
	// (per-browser, off-chain). chat_inbox_features covers the
	// chat-side counterpart (block is on-chain, dismiss is local
	// chat-side hide). Bridging the two clusters helps readers
	// who land on either understand both.
	user_hide_accounts: ['chat_inbox_features', 'privacy_practices'],

	// Device + offline cluster
	mobile_desktop: ['offline_caching', 'app_stores', 'no_js'],

	// Activity-level signal
	activity_level: ['sybil_protection', 'new_trader_badge', 'verified_chat_badge'],

	// Syndication — links both to the first-trade bonus and to sharing
	syndicate_trade_announcement: ['share_order_link', 'welcome_bonus'],

	// Featured-slot auction cluster
	what_is_featured_slot: ['featured_slot_displaced', 'fees', 'order_editing'],
	featured_slot_displaced: ['what_is_featured_slot', 'fees'],
	verify_peer_fingerprint: [
		'chat_identity_key',
		'chat_privacy',
		'chat_key_changed',
		'forward_secrecy',
		'how_morphit_protects_me'
	],
	public_api: ['run_your_own', 'how_to_run_node', 'rss_feeds', 'block_explorer'],
	qr_login: ['lost_keys', 'backup_practices', 'lock_vs_signout', 'how_morphit_protects_me'],
	what_is_usdt: ['why_usdt_warning', 'which_usdt_network', 'fees', 'how_to_buy'],
	why_usdt_warning: ['what_is_usdt', 'which_usdt_network', 'how_morphit_protects_me', 'privacy_practices'],
	which_usdt_network: ['what_is_usdt', 'why_usdt_warning', 'fees', 'how_to_buy'],
	arbitrage_morphit_vs_exchanges: ['fees', 'trade_size_limits', 'how_to_buy', 'how_to_sell']
};

export interface FaqEntry {
	key: FaqKey;
	question: string;
	answer: string;
	/** Related entry keys, for cross-navigation. Empty when there are
	 *  none. Populated by `buildEntries` from `FAQ_RELATED`. */
	related: readonly FaqKey[];
}

export interface FaqHit {
	entry: FaqEntry;
	score: number; // 0–1, higher is better
}

/** Strip accents/diacritics and lowercase. */
function normalize(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();
}

/** Tokenize a string into word chunks (also preserves CJK characters). */
function tokenize(s: string): string[] {
	const n = normalize(s);
	// Latin words + single CJK characters (CJK treats each glyph as a token).
	return n.match(/[\p{L}\p{N}]+|[\u4e00-\u9fff]/gu) ?? [];
}

// ─── English stopwords + synonyms ─────────────────────────────────
//
// Deliberately small lists. Big stopword lists (like NLTK's 179
// words) over-strip queries — e.g. "is it safe" becomes just
// "safe", which then matches too many entries. The list here covers
// only the words that would otherwise dominate (because they appear
// in many question-leading positions: "how do i...", "what is...",
// "can i..."). Query-side only — never strip tokens from the index.

const STOPWORDS_EN = new Set([
	'a',
	'an',
	'the',
	'is',
	'are',
	'was',
	'were',
	'be',
	'been',
	'being',
	'do',
	'does',
	'did',
	'can',
	'could',
	'will',
	'would',
	'should',
	'how',
	'what',
	'why',
	'where',
	'when',
	'who',
	'i',
	'you',
	'we',
	'they',
	'it',
	'my',
	'your',
	'to',
	'of',
	'in',
	'on',
	'for',
	'with',
	'and',
	'or'
]);

/**
 * Synonym expansion map. User-side words → additional tokens to
 * search for. Applied to query tokens; not to index tokens (which
 * would pollute the rarity calculation).
 *
 * Source: the kinds of phrasing real support questions use instead
 * of our FAQ's canonical vocabulary. Kept short; grow it only when
 * real confusion shows up.
 */
const SYNONYMS_EN: Record<string, readonly string[]> = {
	// Safety/security
	safety: ['security', 'safe', 'attack'],
	secure: ['security', 'safe'],
	hacked: ['security', 'attack'],
	scam: ['security', 'safe', 'arbitration'],
	scammer: ['security', 'safe', 'scam', 'protect'],
	scammers: ['security', 'safe', 'scam', 'protect'],
	fraud: ['security', 'scam', 'protect'],
	phishing: ['security', 'scam', 'protect'],
	phish: ['security', 'scam', 'protect'],
	steal: ['security', 'scam', 'protect'],
	stolen: ['security', 'scam', 'protect'],
	protect: ['security', 'safe', 'protection'],
	protection: ['security', 'safe', 'protect'],
	defenses: ['security', 'protect', 'protection'],
	defense: ['security', 'protect', 'protection'],
	// Security engineering process — surfacing the new
	// `security_engineering_rigor` entry on rigor-flavored queries
	// Code review / audit
	audit: ['security', 'rigor', 'review'],
	audits: ['security', 'rigor', 'review'],
	rigor: ['security', 'audit', 'review'],
	review: ['audit', 'security', 'feedback', 'rating'],
	reviewed: ['audit', 'security'],
	pentest: ['security', 'audit'],
	pentested: ['security', 'audit'],
	threat: ['security', 'audit'],
	'red-team': ['security', 'audit'],
	stride: ['security', 'audit'],
	methodology: ['rigor', 'audit', 'security'],
	thorough: ['rigor', 'audit'],
	// Identity / privacy
	kyc: ['identity', 'verification'],
	anonymous: ['privacy', 'anonymity'],
	identity: ['kyc', 'verification'],
	// Pricing
	price: ['fee', 'fees', 'cost'],
	cost: ['fee', 'fees', 'pricing'],
	pricing: ['fee', 'fees'],
	cheap: ['fee', 'discount'],
	free: ['waived', 'waiver'],
	discount: ['waived', 'welcome'],
	// Acquiring BLURT (Q11 follow-up): users typically search for
	// "where to buy" / "exchange" rather than the FAQ's canonical
	// phrasing.  Map all these to terms that appear in
	// `where_to_buy_blurt`.  Morphit's own orderbook is the
	// recommended path; Klingex is positioned as last-resort, so
	// the synonym set leans toward orderbook discovery.
	acquire: ['buy', 'purchase', 'get'],
	purchase: ['buy', 'acquire'],
	exchange: ['klingex', 'cex', 'orderbook'],
	cex: ['exchange', 'klingex', 'orderbook'],
	klingex: ['exchange', 'buy', 'orderbook'],
	swap: ['exchange', 'trade'],
	// Operators
	operator: ['node', 'instance', 'run'],
	node: ['operator', 'instance'],
	instance: ['node', 'operator'],
	server: ['node', 'operator', 'run'],
	host: ['node', 'operator', 'run'],
	// Chat
	message: ['chat', 'messaging'],
	messaging: ['chat'],
	encrypted: ['e2ee', 'chat', 'privacy'],
	encryption: ['chat', 'e2ee'],
	signal: ['chat', 'forward', 'messenger'],
	matrix: ['chat', 'messenger'],
	element: ['chat', 'matrix', 'messenger'],
	session: ['chat', 'messenger'],
	keybase: ['chat', 'messenger'],
	pfs: ['forward', 'secrecy', 'chat'],
	forward: ['secrecy', 'pfs', 'chat'],
	secrecy: ['forward', 'pfs', 'chat'],
	// Chat anti-spam + inbox UX
	spam: ['unsolicited', 'stranger', 'spammer', 'flood'],
	spammer: ['spam', 'unsolicited', 'stranger'],
	spammers: ['spam', 'unsolicited', 'stranger'],
	stranger: ['spam', 'unsolicited', 'first-contact'],
	strangers: ['spam', 'unsolicited', 'first-contact'],
	harass: ['spam', 'block', 'unsolicited'],
	harassment: ['spam', 'block', 'unsolicited'],
	pester: ['spam', 'block', 'unsolicited'],
	solicit: ['spam', 'unsolicited', 'stranger'],
	soliciting: ['spam', 'unsolicited', 'stranger'],
	flood: ['spam', 'unsolicited', 'rate'],
	mute: ['block', 'hide', 'dismiss', 'ignore'],
	muting: ['block', 'hide', 'dismiss', 'ignore'],
	unmute: ['unblock', 'unhide', 'restore'],
	ignore: ['block', 'hide', 'mute'],
	block: ['mute', 'hide', 'dismiss', 'ignore'],
	blocking: ['mute', 'hide', 'dismiss'],
	unblock: ['unmute', 'unhide', 'restore'],
	unblocking: ['unmute', 'unhide'],
	dismiss: ['hide', 'block', 'mute'],
	inbox: ['chat', 'messages', 'notifications', 'requests'],
	notifications: ['inbox', 'chat', 'messages', 'alerts'],
	notification: ['inbox', 'chat', 'messages', 'alerts'],
	alerts: ['notifications', 'inbox'],
	requests: ['inbox', 'stranger', 'first-contact'],
	tabs: ['inbox', 'messages', 'requests'],
	// Crypto assets
	btc: ['bitcoin'],
	bitcoin: ['btc'],
	xmr: ['monero'],
	monero: ['xmr'],
	// Feedback / reputation
	rating: ['feedback', 'review'],
	// `review` already declared above with audit-related synonyms;
	// merge the feedback-related synonyms in by removing the
	// duplicate here.  The audit-related entry above wins; if a
	// user types "review" they get audit results, and entries that
	// list "rating" or "feedback" as synonyms still surface for
	// users searching feedback-flavored terms.
	reputation: ['feedback', 'rating'],
	// Losses / recovery
	lost: ['recover', 'recovery', 'loss'],
	recovery: ['lost', 'loss'],
	backup: ['recover', 'recovery', 'lost'],
	forgotten: ['lost', 'recovery'],
	// Common newcomer vocabulary
	account: ['signup', 'register', 'onboarding'],
	register: ['signup', 'account', 'onboarding'],
	signup: ['register', 'account', 'onboarding'],
	// Ecosystem
	uncensored: ['censorship', 'resistance'],
	tor: ['privacy', 'anonymity'],
	// RSS / syndication — covers the common variations of the
	// "how do I subscribe to updates" question.
	rss: ['feed', 'subscribe', 'follow', 'atom'],
	feed: ['rss', 'subscribe', 'follow'],
	feeds: ['rss', 'subscribe', 'follow'],
	atom: ['rss', 'feed', 'subscribe'],
	subscribe: ['rss', 'feed', 'follow'],
	subscription: ['rss', 'feed', 'follow'],
	subscribing: ['rss', 'feed', 'follow'],
	syndication: ['rss', 'feed'],
	// Chat-key-changed safeguard (Option 5 / S2).  Users hitting
	// the four "We couldn't safely send" cases search with a
	// variety of phrasings; route all of them to the explainer.
	tampered: ['key', 'security', 'compromised'],
	rotated: ['key', 'rotation', 'changed'],
	rotation: ['key', 'rotated', 'changed'],
	mitm: ['security', 'compromised', 'attack'],
	// Order-placement audit findings: route various phrasings of
	// "my order isn't showing up" / "the fee was rejected" to
	// the order_fee_rejected explainer.
	underpaid: ['fee', 'rejected', 'order'],
	reused: ['fee', 'rejected', 'order'],
	rejected: ['fee', 'order', 'underpaid'],
	// Signup audit findings: route signup-stuck phrasings to
	// the signup_stuck explainer.
	'rate-limited': ['signup', 'stuck', 'register'],
	captcha: ['altcha', 'signup', 'verify'],
	altcha: ['captcha', 'signup', 'verify'],
	invite: ['signup', 'register', 'token'],
	stuck: ['signup', 'register', 'error'],
	// Reputation/feedback audit (R15): route phrasings of
	// "why does this review show greyed out" to the
	// feedback_suppressed explainer.
	suppressed: ['feedback', 'review', 'rating'],
	flagged: ['feedback', 'review', 'related'],
	greyed: ['feedback', 'review', 'suppressed'],
	related: ['feedback', 'review', 'flagged'],
	// Anti-spam audit: block-privacy synonyms.  `harass` and
	// `stranger` already route via the chat_anti_spam cluster
	// (lines 540/542); these are the genuinely-new keys.
	blocked: ['block', 'privacy', 'spam'],
	stalker: ['block', 'privacy', 'spam']
};

/** Whether we apply English synonyms/stopwords for a given locale.
 *  Only latin-letter locales where the English word might match the
 *  English-dominant index content (brand terms, technical acronyms). */
function shouldApplyEnglishAids(rawQuery: string): boolean {
	// Heuristic: if the query contains mostly ASCII latin letters,
	// apply. This catches en/es/fr/de/it/pl (all latin-script) users
	// who type English-flavored terms like "kyc" or "fees", while
	// skipping ru/fa/zh/zh-HK where our English aids would never
	// apply anyway.
	const latinRatio = (rawQuery.match(/[a-zA-Z]/g) ?? []).length / Math.max(1, rawQuery.length);
	return latinRatio > 0.5;
}

/** Expand query tokens with synonyms. Skips tokens that aren't in
 *  the synonym map (so most tokens pass through unchanged). */
function expandWithSynonyms(tokens: readonly string[]): string[] {
	const out: string[] = [];
	for (const t of tokens) {
		out.push(t);
		const syns = SYNONYMS_EN[t];
		if (syns) {
			for (const s of syns) out.push(s);
		}
	}
	return out;
}

/** Filter query tokens by stripping stopwords. If removing stopwords
 *  would leave nothing, keep everything — the user's intent is
 *  probably just those words. */
function filterStopwords(tokens: readonly string[]): string[] {
	const filtered = tokens.filter((t) => !STOPWORDS_EN.has(t));
	return filtered.length > 0 ? filtered : [...tokens];
}

// ─── IDF weighting ─────────────────────────────────────────────────
//
// Count how many FAQ entries contain each token. A token that appears
// in all entries (common brand/domain terms) scores ~0; a token that
// appears in only one entry (very specific) scores ~1. Computed once
// per entry set, memoized by entry-set identity so locale swaps don't
// spend work.

interface TokenStats {
	/** entry count for this token */
	df: number;
	/** inverse document frequency, 0..1 */
	idf: number;
}

const idfCache = new WeakMap<readonly FaqEntry[], Map<string, TokenStats>>();

function computeIdf(entries: readonly FaqEntry[]): Map<string, TokenStats> {
	const cached = idfCache.get(entries);
	if (cached) return cached;

	const dfMap = new Map<string, number>();
	const n = entries.length;
	for (const entry of entries) {
		const seen = new Set<string>();
		for (const tok of tokenize(entry.question)) seen.add(tok);
		for (const tok of tokenize(entry.answer)) seen.add(tok);
		for (const tok of seen) dfMap.set(tok, (dfMap.get(tok) ?? 0) + 1);
	}

	const stats = new Map<string, TokenStats>();
	for (const [tok, df] of dfMap) {
		// Classical smoothed IDF: ln((n+1) / (df+1)) + 1, normalized by
		// the theoretical max of ln((n+1)/1). Gives 0..1 where tokens
		// in every entry are ~0 and tokens in one entry are ~1.
		const raw = Math.log((n + 1) / (df + 1));
		const max = Math.log(n + 1);
		stats.set(tok, { df, idf: raw / max });
	}
	idfCache.set(entries, stats);
	return stats;
}

/** Build the entry list for the current locale. */
export function buildEntries(t: (key: string) => string): FaqEntry[] {
	return FAQ_KEYS.map((key) => ({
		key,
		question: t(`faq.entries.${key}.q`),
		answer: t(`faq.entries.${key}.a`),
		related: FAQ_RELATED[key] ?? []
	}));
}

/**
 * Score an entry against a query. Formula:
 *   +3.0  full query substring in question
 *   +2.0  full query substring in answer
 *   +0.5  question starts with the query
 *   per query token:
 *     +1.0 * (1 + idf)   matched in question
 *     +0.5 * (1 + idf)   matched in answer
 *
 * The IDF multiplier shifts weight toward rare, specific terms.
 * Exact-phrase and prefix bonuses are unchanged from the v1 scorer
 * — those are strong signals of user intent that shouldn't be
 * reweighted by token frequency.
 *
 * The second argument is rawQuery for backward compatibility; the
 * optional third argument carries the precomputed IDF table. When
 * called directly (without the table), we compute a one-entry
 * "table" where every token has idf=1 — so scoring a single entry
 * in isolation still works, just without rare-token weighting.
 */
export function scoreEntry(
	entry: FaqEntry,
	rawQuery: string,
	idf?: ReadonlyMap<string, TokenStats>
): number {
	if (!rawQuery.trim()) return 0;
	const q = normalize(rawQuery.trim());
	const nq = normalize(entry.question);
	const na = normalize(entry.answer);

	let score = 0;
	if (nq.includes(q)) score += 3;
	if (na.includes(q)) score += 2;
	if (nq.startsWith(q)) score += 0.5;

	let qTokens = tokenize(rawQuery);
	if (shouldApplyEnglishAids(rawQuery)) {
		qTokens = filterStopwords(qTokens);
		qTokens = expandWithSynonyms(qTokens);
	}

	const nqTokens = new Set(tokenize(entry.question));
	const naTokens = new Set(tokenize(entry.answer));
	const seen = new Set<string>();

	for (const token of qTokens) {
		// Dedupe within the query — if "free" was synonym-expanded
		// into the query twice, don't double-score.
		if (seen.has(token)) continue;
		seen.add(token);

		const tokIdf = idf?.get(token)?.idf ?? 0.5;
		const weight = 1 + tokIdf; // 1.0..2.0
		if (nqTokens.has(token)) score += 1 * weight;
		else if (naTokens.has(token)) score += 0.5 * weight;
	}

	// Length normalization. A very long answer is more likely to
	// contain any given word by coincidence, which lets catch-all
	// entries (comparisons, how-things-work pages) dominate queries
	// they're not actually the best answer to. Penalty is log-scaled
	// against a reference length of ~900 chars (median entry size);
	// entries at that size are unaffected, shorter entries get a
	// modest bonus, longer entries get a modest penalty.
	//
	// The cap of ±0.85 prevents the penalty from ever going below
	// zero for reasonable inputs and stops it from obliterating
	// genuinely-relevant long entries.
	const LENGTH_REFERENCE = 900;
	const lengthRatio = Math.max(1, entry.answer.length) / LENGTH_REFERENCE;
	const lengthPenalty = Math.max(0.25, Math.min(1.6, 1 / Math.sqrt(lengthRatio)));
	score *= lengthPenalty;

	return score;
}

export function searchEntries(entries: FaqEntry[], query: string, limit = 10): FaqHit[] {
	if (!query.trim()) {
		return entries.map((entry) => ({ entry, score: 0 }));
	}

	const idf = computeIdf(entries);

	const hits = entries
		.map((entry) => ({ entry, score: scoreEntry(entry, query, idf) }))
		.filter((h) => h.score > 0);

	hits.sort((a, b) => b.score - a.score);

	// Normalize to 0–1 scale for display.
	const max = hits[0]?.score ?? 1;
	return hits.slice(0, limit).map((h) => ({ entry: h.entry, score: h.score / max }));
}

/**
 * Reactive FAQ entries — rebuilds when the active locale changes, without
 * any network fetch (translations are already loaded by svelte-i18n).
 */
export const faqEntries: Readable<FaqEntry[]> = derived(
	[_, locale],
	([$t, $locale]: [(key: string) => string, string | null | undefined]) => {
		// Touch $locale so the derivation re-runs on language switch.
		void $locale;
		return buildEntries((key) => $t(key));
	}
);
