#!/usr/bin/env tsx
/**
 * i18n translation completeness smoke.
 *
 * Locale-parity (sister smoke i18n-locale-parity-smoke) checks
 * STRUCTURAL parity: every key in en.json exists in every other
 * locale.  But it does NOT check that the values are actually
 * translated — a locale can pass parity by simply copying the
 * English value.  That's what missed our 9 Part-104 fixes.
 *
 * This smoke catches the specific high-signal drift class:
 * **a key translated by 7+ non-EN locales is still
 * byte-identical to English in 1-2 locales.**  When most of the
 * world translated something but a couple didn't, those couple
 * are almost certainly genuine misses, not legitimate loanwords.
 *
 * (Lower-coverage cases — 3+ locales not translating — are
 * usually legitimate loanwords adopted into multiple locales'
 * tech-speak, e.g. "Live", "Filter", "Region", "Privacy" in
 * German/Italian.  Those go into the explicit allow-list.)
 *
 * The allow-list is the project's translation policy: each
 * entry says "this English-spelled value is the correct
 * rendering in locale X because the locale's word happens to
 * be identical (e.g. Region in German, Transaction in French)
 * OR because the term is a universally-adopted loanword
 * (e.g. permlink, custom_json)."
 */

// Import SUPPORTED_LOCALES so the "expected count" assertion below
// auto-tracks the registry instead of pinning a literal "10".  When a
// PLANNED locale graduates to SUPPORTED, this assertion updates with
// no code change.
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const LOC_DIR = join(REPO, 'src/lib/i18n/locales');

type JsonObj = { [k: string]: unknown };

function flattenStrings(d: unknown, prefix = ''): Map<string, string> {
	const out = new Map<string, string>();
	if (typeof d === 'string') {
		out.set(prefix, d);
		return out;
	}
	if (typeof d !== 'object' || d === null) return out;
	for (const [k, v] of Object.entries(d as JsonObj)) {
		const path = prefix ? `${prefix}.${k}` : k;
		for (const [sk, sv] of flattenStrings(v, path)) out.set(sk, sv);
	}
	return out;
}

const locales = readdirSync(LOC_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace(/\.json$/, ''))
	.sort();

const data = new Map<string, Map<string, string>>();
for (const loc of locales) {
	const obj = JSON.parse(readFileSync(join(LOC_DIR, `${loc}.json`), 'utf-8')) as JsonObj;
	data.set(loc, flattenStrings(obj));
}

const en = data.get('en')!;
const nonEn = locales.filter((l) => l !== 'en');

// ─── Allow-list ────────────────────────────────────────────
//
// Each entry: a (key, locale) pair where the locale's value
// being byte-identical to English is the CORRECT rendering.
// Three reasons admitted:
//   (a) "same-word": the locale's word for this concept is
//       spelled identically to English (e.g. "Region" in
//       German is also "Region", "Transaction" in French is
//       also "Transaction").
//   (b) "loanword": the locale has adopted the English term
//       as the standard usage in this domain, even though a
//       native term exists (e.g. "Live" in German tech UIs,
//       "Privacy" in Italian privacy-policy contexts).
//   (c) "invariant": the value is a brand name, technical
//       identifier, code-string, or universal acronym.
//
// New entries MUST cite which (a/b/c) applies.

interface AllowEntry { key: string; locale: string; reason: string }
const ALLOW_LIST: AllowEntry[] = [
	// ─── post-order amount hint: the value "{amount} {fiat} (≈ {usd})" is
	//     ENTIRELY interpolation placeholders + a math symbol (≈) + ASCII
	//     parens — there is no translatable word, so byte-identity with EN
	//     is correct for the native-translation locales (de/es/fr). zh-CN/HK
	//     legitimately differ (full-width parens （）); it/pl/ru/fa are
	//     policy-fallback (skipped above). The smoke's "pure format" skip
	//     (no [a-zA-Z]) misses this because the placeholder NAMES contain
	//     letters. (b) invariant.
	{ key: 'post_order.form.amount_entered_usd_hint', locale: 'de', reason: '(b) pure interpolation placeholders + math symbol (≈) — no translatable text' },
	{ key: 'post_order.form.amount_entered_usd_hint', locale: 'es', reason: '(b) pure interpolation placeholders + math symbol (≈) — no translatable text' },
	{ key: 'post_order.form.amount_entered_usd_hint', locale: 'fr', reason: '(b) pure interpolation placeholders + math symbol (≈) — no translatable text' },
	// ─── cp321 explorer-account Public Keys card: the four Blurt key-role
	//     names (Owner / Active / Posting / Memo) are technical identifiers
	//     kept in English in EVERY locale by project convention — exactly as
	//     backup_keys_panel.role.* does ("Owner-Schlüssel" / "Clave Owner" /
	//     etc. keep the role word English and translate only "key"). Here the
	//     label IS just the bare role word (under a translated "Public Keys"
	//     heading), so it is byte-identical to English by design, not a miss.
	{ key: 'explorer.account.key_owner', locale: 'de', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_owner', locale: 'es', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_owner', locale: 'fr', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_active', locale: 'de', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_active', locale: 'es', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_active', locale: 'fr', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_posting', locale: 'de', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_posting', locale: 'es', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_posting', locale: 'fr', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_memo', locale: 'de', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_memo', locale: 'es', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	{ key: 'explorer.account.key_memo', locale: 'fr', reason: '(c) Blurt key-role identifier kept in English by project convention (mirrors backup_keys_panel.role.*)' },
	// cp305 — the sign-out-before-switch modal's confirm button is "OK"
	// per Ken's explicit two-button [Cancel / OK] spec for this dialog.
	// "OK" is an internationally-recognized affirmation rendered
	// identically in these locales (it/pl already pass the heuristic);
	// it is the intended text, not an untranslated miss.
	{ key: 'login.signout_before_switch_modal.confirm', locale: 'de', reason: '(b) "OK" is a universal affirmation loanword; intentional per the modal\'s Cancel/OK spec' },
	{ key: 'login.signout_before_switch_modal.confirm', locale: 'fr', reason: '(b) "OK" is a universal affirmation loanword; intentional per the modal\'s Cancel/OK spec' },
	// ─── cp229 RSS feed-format names: "RSS 2.0", "Atom", "JSON" are
	//     proper-noun / technical format identifiers, byte-identical in
	//     every locale by design (the 3-format RSS feature). The
	//     surrounding copied-to-clipboard sentences ARE translated;
	//     only the bare format names are invariant. ──────────────────
	{ key: 'rss.format_rss2', locale: 'de', reason: '(c) "RSS 2.0" is a feed-format name (proper noun); identical in every locale' },
	{ key: 'rss.format_rss2', locale: 'es', reason: '(c) "RSS 2.0" is a feed-format name (proper noun); identical in every locale' },
	{ key: 'rss.format_rss2', locale: 'fr', reason: '(c) "RSS 2.0" is a feed-format name (proper noun); identical in every locale' },
	{ key: 'rss.format_atom', locale: 'de', reason: '(c) "Atom" is a feed-format name (proper noun); identical in every locale' },
	{ key: 'rss.format_atom', locale: 'es', reason: '(c) "Atom" is a feed-format name (proper noun); identical in every locale' },
	{ key: 'rss.format_atom', locale: 'fr', reason: '(c) "Atom" is a feed-format name (proper noun); identical in every locale' },
	{ key: 'rss.format_json', locale: 'de', reason: '(c) "JSON" is a feed-format name (technical identifier); identical in every locale' },
	{ key: 'rss.format_json', locale: 'es', reason: '(c) "JSON" is a feed-format name (technical identifier); identical in every locale' },
	{ key: 'rss.format_json', locale: 'fr', reason: '(c) "JSON" is a feed-format name (technical identifier); identical in every locale' },
	// cp295 — the footer link was shortened from "PGP keys" to the bare
	// acronym "PGP" (Ken's batch item D). "PGP" is a universal
	// cryptography acronym, written the same in every locale, so being
	// byte-identical to English here is the CORRECT rendering, not a miss.
	{ key: 'footer.pgp_keys', locale: 'de', reason: '(c) "PGP" is a universal cryptography acronym; identical in every locale' },
	{ key: 'footer.pgp_keys', locale: 'es', reason: '(c) "PGP" is a universal cryptography acronym; identical in every locale' },
	{ key: 'footer.pgp_keys', locale: 'fr', reason: '(c) "PGP" is a universal cryptography acronym; identical in every locale' },
	// post-beta.28 — the footer "API" link (developer-API FAQ deep-link).
	// "API" is a universal programming acronym, written the same in every
	// locale, so being byte-identical to English is the CORRECT rendering.
	// (Tooltip footer.api_title IS translated; only the bare label is invariant.)
	{ key: 'footer.api', locale: 'de', reason: '(c) "API" is a universal programming acronym; identical in every locale' },
	{ key: 'footer.api', locale: 'es', reason: '(c) "API" is a universal programming acronym; identical in every locale' },
	{ key: 'footer.api', locale: 'fr', reason: '(c) "API" is a universal programming acronym; identical in every locale' },
	{ key: 'footer.contact', locale: 'fr', reason: '(a) "Contact" is also French (same spelling, same meaning)' },
	// cp423 — the chat-inbox "RE:" prefix on the "RE: <order title>" subline.
	// "RE:" (from Latin "in re" = "regarding") is an internationally-recognized
	// convention rendered identically in email clients across languages; it is
	// Ken's literal wording and the intended text, not an untranslated miss.
	// (The order title that follows IS fully translated via order_title.*.)
	{ key: 'chat.inbox.re_prefix', locale: 'de', reason: '(b) "RE:" is a universal "regarding" convention (Latin in re); identical in every locale' },
	{ key: 'chat.inbox.re_prefix', locale: 'es', reason: '(b) "RE:" is a universal "regarding" convention (Latin in re); identical in every locale' },
	{ key: 'chat.inbox.re_prefix', locale: 'fr', reason: '(b) "RE:" is a universal "regarding" convention (Latin in re); identical in every locale' },
	// post-beta.28 — the RPC endpoint-health error label "Error: {code}".
	// "Error" is spelled identically in Spanish (cognate); only the
	// interpolated HTTP status code follows, so es is legitimately
	// byte-identical to EN here. (fr/de/it/pl/ru/fa/zh all differ.)
	{ key: 'settings.endpoints.http_error', locale: 'es', reason: '(b) "Error" is identical in Spanish (cognate); the rest is the interpolated HTTP {code}' },
	// ─── cp115 network product names: Latin-script brand names that
	//     legitimately do NOT translate.  Arbitrum, Base, Polygon are
	//     Layer-2 network product names (registered marks).  BEP-20
	//     and TRC-20 are technical token-standard identifiers (binance
	//     / tron equivalents of ERC-20).  All five render identical
	//     across all 10 locales by design; the screen-reader form
	//     ("Arbitrum network" / "Red de Arbitrum" / etc.) carries
	//     the translation. ─────────────────────────────────────────
	{ key: 'home.coin_carousel.networks.arbitrum', locale: 'de', reason: '(c) Arbitrum is a registered Layer-2 product name; does not translate' },
	{ key: 'home.coin_carousel.networks.arbitrum', locale: 'es', reason: '(c) Arbitrum is a registered Layer-2 product name; does not translate' },
	{ key: 'home.coin_carousel.networks.arbitrum', locale: 'fr', reason: '(c) Arbitrum is a registered Layer-2 product name; does not translate' },
	{ key: 'home.coin_carousel.networks.base', locale: 'de', reason: '(c) Base is the Coinbase L2 product name; does not translate' },
	{ key: 'home.coin_carousel.networks.base', locale: 'es', reason: '(c) Base is the Coinbase L2 product name; does not translate' },
	{ key: 'home.coin_carousel.networks.base', locale: 'fr', reason: '(c) Base is the Coinbase L2 product name; does not translate' },
	{ key: 'home.coin_carousel.networks.bep20', locale: 'de', reason: '(c) BEP-20 is a technical token-standard identifier; does not translate' },
	{ key: 'home.coin_carousel.networks.bep20', locale: 'es', reason: '(c) BEP-20 is a technical token-standard identifier; does not translate' },
	{ key: 'home.coin_carousel.networks.bep20', locale: 'fr', reason: '(c) BEP-20 is a technical token-standard identifier; does not translate' },
	{ key: 'home.coin_carousel.networks.polygon', locale: 'de', reason: '(c) Polygon is a registered L2 network product name; does not translate' },
	{ key: 'home.coin_carousel.networks.polygon', locale: 'es', reason: '(c) Polygon is a registered L2 network product name; does not translate' },
	{ key: 'home.coin_carousel.networks.polygon', locale: 'fr', reason: '(c) Polygon is a registered L2 network product name; does not translate' },
	{ key: 'home.coin_carousel.networks.trc20', locale: 'de', reason: '(c) TRC-20 is a technical token-standard identifier; does not translate' },
	{ key: 'home.coin_carousel.networks.trc20', locale: 'es', reason: '(c) TRC-20 is a technical token-standard identifier; does not translate' },
	{ key: 'home.coin_carousel.networks.trc20', locale: 'fr', reason: '(c) TRC-20 is a technical token-standard identifier; does not translate' },
	// ─── (a) same-word: spelling matches in target locale ───
	{ key: 'feature_bid.history_state_visible', locale: 'es', reason: '(a) "Visible" is also Spanish (same spelling, same meaning)' },
	{ key: 'feature_bid.history_state_visible', locale: 'fr', reason: '(a) "Visible" is also French (same spelling, same meaning)' },
	{ key: 'profile.reputation_heading', locale: 'de', reason: '(a) "Reputation" is also German' },
	{ key: 'post_order.form.region_label', locale: 'de', reason: '(a) "Region (optional)" is German verbatim' },
	{ key: 'chat.funds_sent.pill_txid_label', locale: 'fr', reason: '(a) "Transaction" is also French' },
	{ key: 'explorer.block.page_title', locale: 'de', reason: '(a) "Block" is also German' },
	{ key: 'explorer.block.heading', locale: 'de', reason: '(a) "Block" is also German' },
	{ key: 'explorer.block.tx_count_label', locale: 'fr', reason: '(a) "Transactions" is also French' },
	{ key: 'explorer.block.tx_index', locale: 'fr', reason: '(a) "Transaction" is also French' },
	{ key: 'explorer.tx.page_title', locale: 'fr', reason: '(a) "Transaction" is also French' },
	{ key: 'explorer.tx.heading', locale: 'fr', reason: '(a) "Transaction" is also French' },
	{ key: 'explorer.tx.signatures_label', locale: 'fr', reason: '(a) "Signatures" is also French' },
	{ key: 'explorer.tx.block_label', locale: 'de', reason: '(a) "Block" is also German' },
	{ key: 'explorer.activity.col_asset', locale: 'de', reason: '(a/b) "Asset" adopted as German tech loanword' },
	{ key: 'explorer.activity.col_asset', locale: 'it', reason: '(a/b) "Asset" adopted as Italian tech loanword' },
	{ key: 'explorer.activity.col_trades', locale: 'de', reason: '(a/b) "Trades" adopted as German tech loanword' },
	{ key: 'explorer.nav.home_title', locale: 'it', reason: '(b) "Home" is universal Italian tech loanword' },
	{ key: 'explorer.op.label.transfer', locale: 'pl', reason: '(a) "Transfer" is also Polish' },
	{ key: 'explorer.op.label.vote', locale: 'fr', reason: '(a) "Vote" is also French' },
	{ key: 'explorer.op.label.comment', locale: 'it', reason: '(b) "Post" adopted as Italian tech loanword' },
	{ key: 'explorer.op.label.comment', locale: 'pl', reason: '(b) "Post" adopted as Polish tech loanword' },
	{ key: 'explorer.op.label.morphit_feedback', locale: 'de', reason: '(b) "Feedback" adopted as German tech loanword' },
	{ key: 'explorer.block.timestamp_label', locale: 'it', reason: '(b) "Timestamp" adopted as Italian tech loanword' },
	{ key: 'glossary.delegation.title', locale: 'de', reason: '(a) "Delegation" is also German' },
	{ key: 'glossary.feedback.title', locale: 'de', reason: '(b) "Feedback" adopted as German loanword' },
	{ key: 'glossary.feedback.title', locale: 'it', reason: '(b) "Feedback" adopted as Italian loanword' },
	{ key: 'glossary.indexer.title', locale: 'de', reason: '(b) "Indexer" adopted as German tech loanword' },
	{ key: 'glossary.indexer.title', locale: 'it', reason: '(b) "Indexer" adopted as Italian tech loanword' },
	{ key: 'glossary.indexer.title', locale: 'pl', reason: '(b) "Indexer" adopted as Polish tech loanword' },
	{ key: 'glossary.instance.title', locale: 'fr', reason: '(a) "Instance" is also French' },
	{ key: 'glossary.operator.title', locale: 'pl', reason: '(a) "Operator" is also Polish' },
	{ key: 'glossary.password.title', locale: 'it', reason: '(b) "Password" adopted as Italian tech loanword' },
	{ key: 'glossary.relay.title', locale: 'de', reason: '(b) "Relay" adopted as German tech loanword' },
	{ key: 'glossary.relay.title', locale: 'it', reason: '(b) "Relay" adopted as Italian tech loanword' },
	{ key: 'glossary.release_op.title', locale: 'ru', reason: '(c) "Release op" is technical Blurt op-name' },
	{ key: 'glossary.seed_phrase.title', locale: 'it', reason: '(b) "Seed phrase" adopted as Italian crypto loanword' },
	{ key: 'onboarding.import.keyfile_tab_label', locale: 'fa', reason: '(b) "Keyfile" + ".json" are both tech loanwords / file extension literal in Persian' },
	{ key: 'onboarding.import.keyfile_tab_label', locale: 'it', reason: '(b) "Keyfile" + ".json" — keyfile is widely-adopted Italian crypto loanword; .json is a literal file extension' },
	{ key: 'onboarding.import.keyfile_tab_label', locale: 'ru', reason: '(b) "Keyfile" + ".json" — keyfile is widely-adopted Russian tech loanword; .json is a literal file extension' },
	{ key: 'cheat_sheet.section_identity.password', locale: 'it', reason: '(b) "Password" adopted as Italian loanword' },
	{ key: 'login.welcome_back.password_label', locale: 'it', reason: '(b) "Password" adopted as Italian loanword' },
	{ key: 'onboarding.backup.print_card.account_label', locale: 'it', reason: '(b) "Account" adopted as Italian tech loanword' },
	{ key: 'avatar_menu.category.order', locale: 'de', reason: '(b) "Orders" adopted as German tech loanword (matches "Meine Orders" pattern)' },
	{ key: 'order_detail.details_heading', locale: 'de', reason: '(a) "Details" is also German' },
	{ key: 'instances.live', locale: 'de', reason: '(b) "Live" adopted as German tech loanword' },
	{ key: 'instances.live', locale: 'it', reason: '(b) "Live" adopted as Italian tech loanword' },
	{ key: 'instances.operator_label', locale: 'pl', reason: '(a) "Operator" is also Polish' },
	{ key: 'orderbook.live', locale: 'de', reason: '(b) "Live" adopted as German tech loanword' },
	{ key: 'orderbook.live', locale: 'it', reason: '(b) "Live" adopted as Italian tech loanword' },
	{ key: 'orderbook.filters.heading', locale: 'de', reason: '(a) "Filter" is also German' },
	{ key: 'orderbook.filters.asset_label', locale: 'de', reason: '(b) "Asset" loanword' },
	{ key: 'orderbook.filters.asset_label', locale: 'it', reason: '(b) "Asset" loanword' },
	{ key: 'orderbook.filters.region_label', locale: 'de', reason: '(a) "Region" is also German' },
	{ key: 'orderbook.filters.region_label', locale: 'pl', reason: '(a) "Region" is also Polish' },
	{ key: 'orderbook.order.region_label', locale: 'de', reason: '(a) "Region" is also German' },
	{ key: 'orderbook.order.region_label', locale: 'pl', reason: '(a) "Region" is also Polish' },
	{ key: 'settings.preferences.region_label', locale: 'de', reason: '(a) "Region" is also German' },
	{ key: 'settings.preferences.region_label', locale: 'pl', reason: '(a) "Region" is also Polish' },
	{ key: 'settings.privacy.heading', locale: 'it', reason: '(b) "Privacy" adopted as Italian loanword' },
	{ key: 'privacy_terms.privacy_heading', locale: 'it', reason: '(b) "Privacy" adopted as Italian loanword' },
	{ key: 'settings.session.heading', locale: 'fr', reason: '(a) "Session" is also French' },
	{ key: 'settings.session.autolock_15min', locale: 'fr', reason: '(a) "15 minutes" is also French' },
	{ key: 'settings.session.autolock_30min', locale: 'fr', reason: '(a) "30 minutes" is also French' },
	{ key: 'settings.notifications.heading', locale: 'fr', reason: '(a) "Notifications" is also French' },
	{ key: 'settings.notifications.category_feedback_label', locale: 'es', reason: '(b) "Feedback" loanword' },
	{ key: 'settings.notifications.category_feedback_label', locale: 'de', reason: '(b) "Feedback" loanword' },
	{ key: 'settings.notifications.category_feedback_label', locale: 'it', reason: '(b) "Feedback" loanword' },
	{ key: 'settings.syndication.heading', locale: 'fr', reason: '(a) "Syndication" is also French' },
	{ key: 'settings.avatar.heading', locale: 'es', reason: '(b) "Avatar" universal loanword' },
	{ key: 'settings.avatar.heading', locale: 'fr', reason: '(b) "Avatar" universal loanword' },
	{ key: 'settings.avatar.heading', locale: 'de', reason: '(b) "Avatar" universal loanword' },
	{ key: 'settings.avatar.heading', locale: 'it', reason: '(b) "Avatar" universal loanword' },
	{ key: 'settings.hardware_key.slot_1', locale: 'de', reason: '(b) "Slot 1" universal tech loanword' },
	{ key: 'settings.hardware_key.slot_1', locale: 'it', reason: '(b) "Slot 1" universal tech loanword' },
	{ key: 'settings.hardware_key.slot_1', locale: 'pl', reason: '(b) "Slot 1" universal tech loanword' },
	{ key: 'settings.hardware_key.slot_label', locale: 'de', reason: '(b) "Slot" universal tech loanword' },
	{ key: 'settings.hardware_key.slot_label', locale: 'it', reason: '(b) "Slot" universal tech loanword' },
	{ key: 'settings.hardware_key.slot_label', locale: 'pl', reason: '(b) "Slot" universal tech loanword' },
	{ key: 'scan_login.confirm_website_label', locale: 'de', reason: '(b) "Website" adopted as German loanword' },
	{ key: 'avatar_menu.notifications', locale: 'fr', reason: '(a) "Notifications" is also French' },
	{ key: 'avatar_menu.notifications_heading', locale: 'fr', reason: '(a) "Notifications" is also French' },
	{ key: 'avatar_menu.category.chat', locale: 'es', reason: '(b) "Chat" universal loanword' },
	{ key: 'avatar_menu.category.chat', locale: 'fr', reason: '(b) "Chat" universal loanword' },
	{ key: 'avatar_menu.category.chat', locale: 'de', reason: '(b) "Chat" universal loanword' },
	{ key: 'avatar_menu.category.chat', locale: 'it', reason: '(b) "Chat" universal loanword' },
	{ key: 'avatar_menu.category.feedback', locale: 'es', reason: '(b) "Feedback" loanword' },
	{ key: 'avatar_menu.category.feedback', locale: 'de', reason: '(b) "Feedback" loanword' },
	{ key: 'avatar_menu.category.feedback', locale: 'it', reason: '(b) "Feedback" loanword' },
	{ key: 'chat.composer.acct_reminder.heading', locale: 'fr', reason: '(a) "Permanent." is also French' },
	{ key: 'chat.live', locale: 'de', reason: '(b) "Live" adopted as German tech loanword' },
	{ key: 'chat.message_button_label', locale: 'fr', reason: '(a) "Message" is also French' },
	{ key: 'chat.inbox.tab_messages', locale: 'fr', reason: '(a) "Messages" is also French' },
	{ key: 'chat.pay_blurt.memo_label', locale: 'es', reason: '(b) "Memo" universal loanword' },
	{ key: 'chat.pay_blurt.memo_label', locale: 'de', reason: '(b) "Memo" universal loanword' },
	{ key: 'chat.pay_blurt.memo_label', locale: 'it', reason: '(b) "Memo" universal loanword' },
	{ key: 'chat.pay_blurt.memo_label', locale: 'ru', reason: '(b) "Memo" universal loanword (Latin script intentional)' },
	{ key: 'profile.pnl.csv_header.memo', locale: 'es', reason: '(b) "Memo" + CSV-cross-tool convention' },
	{ key: 'profile.pnl.csv_header.memo', locale: 'fr', reason: '(b) "Memo" + CSV-cross-tool convention' },
	{ key: 'profile.pnl.csv_header.memo', locale: 'de', reason: '(b) "Memo" + CSV-cross-tool convention' },
	{ key: 'profile.pnl.csv_header.memo', locale: 'it', reason: '(b) "Memo" + CSV-cross-tool convention' },
	{ key: 'profile.pnl.csv_header.memo', locale: 'pl', reason: '(b) "Memo" + CSV-cross-tool convention' },
	{ key: 'profile.pnl.csv_header.memo', locale: 'ru', reason: '(b) "Memo" + CSV-cross-tool convention' },
	{ key: 'profile.pnl.csv_header.block', locale: 'de', reason: '(a) "Block" is also German' },
	{ key: 'nav.messages', locale: 'fr', reason: '(a) "Messages" is also French' },
	{ key: 'operators.contact', locale: 'fr', reason: '(a) "Contact" is also French' },
	{ key: 'footer.source', locale: 'fr', reason: '(a) "Source" is also French' },
	{ key: 'footer.plan', locale: 'es', reason: '(a) "Plan" is also Spanish' },
	{ key: 'footer.plan', locale: 'fr', reason: '(a) "Plan" is also French' },
	{ key: 'footer.plan', locale: 'de', reason: '(a) "Plan" is also German' },
	{ key: 'footer.plan', locale: 'pl', reason: '(a) "Plan" is also Polish' },
	{ key: 'footer.rss', locale: 'es', reason: '(c) "RSS" is universal acronym' },
	{ key: 'footer.rss', locale: 'fr', reason: '(c) "RSS" is universal acronym' },
	{ key: 'footer.rss', locale: 'de', reason: '(c) "RSS" is universal acronym' },
	{ key: 'footer.rss', locale: 'it', reason: '(c) "RSS" is universal acronym' },
	{ key: 'footer.rss', locale: 'pl', reason: '(c) "RSS" is universal acronym' },
	{ key: 'footer.rss', locale: 'ru', reason: '(c) "RSS" is universal acronym' },
	{ key: 'footer.rss', locale: 'fa', reason: '(c) "RSS" is universal acronym' },
	{ key: 'footer.rss', locale: 'zh-CN', reason: '(c) "RSS" is universal acronym' },
	{ key: 'footer.rss', locale: 'zh-HK', reason: '(c) "RSS" is universal acronym' },
	{ key: 'footer.i2p_b32', locale: 'es', reason: '(c) "B32 I2P" technical protocol' },
	{ key: 'footer.i2p_b32', locale: 'fr', reason: '(c) technical protocol' },
	{ key: 'footer.i2p_b32', locale: 'de', reason: '(c) technical protocol' },
	{ key: 'footer.i2p_b32', locale: 'it', reason: '(c) technical protocol' },
	{ key: 'footer.i2p_b32', locale: 'pl', reason: '(c) technical protocol' },
	{ key: 'footer.i2p_b32', locale: 'ru', reason: '(c) technical protocol' },
	{ key: 'footer.i2p_b32', locale: 'fa', reason: '(c) technical protocol' },
	{ key: 'footer.i2p_b32', locale: 'zh-CN', reason: '(c) technical protocol' },
	{ key: 'footer.i2p_b32', locale: 'zh-HK', reason: '(c) technical protocol' },
	{ key: 'glossary.permlink.title', locale: 'es', reason: '(c) Blurt-chain technical term, universal' },
	{ key: 'glossary.permlink.title', locale: 'fr', reason: '(c) Blurt-chain technical term, universal' },
	{ key: 'glossary.permlink.title', locale: 'de', reason: '(c) Blurt-chain technical term, universal' },
	{ key: 'glossary.permlink.title', locale: 'it', reason: '(c) Blurt-chain technical term, universal' },
	{ key: 'glossary.permlink.title', locale: 'pl', reason: '(c) Blurt-chain technical term, universal' },
	{ key: 'glossary.permlink.title', locale: 'ru', reason: '(c) Blurt-chain technical term, universal' },
	{ key: 'glossary.permlink.title', locale: 'fa', reason: '(c) Blurt-chain technical term, universal' },
	{ key: 'glossary.custom_json.title', locale: 'es', reason: '(c) JSON op-type literal identifier' },
	{ key: 'glossary.custom_json.title', locale: 'fr', reason: '(c) JSON op-type literal identifier' },
	{ key: 'glossary.custom_json.title', locale: 'de', reason: '(c) JSON op-type literal identifier' },
	{ key: 'glossary.custom_json.title', locale: 'it', reason: '(c) JSON op-type literal identifier' },
	{ key: 'glossary.custom_json.title', locale: 'pl', reason: '(c) JSON op-type literal identifier' },
	{ key: 'glossary.custom_json.title', locale: 'ru', reason: '(c) JSON op-type literal identifier' },
	{ key: 'glossary.custom_json.title', locale: 'fa', reason: '(c) JSON op-type literal identifier' },
	{ key: 'glossary.custom_json.title', locale: 'zh-CN', reason: '(c) JSON op-type literal identifier' },
	{ key: 'glossary.custom_json.title', locale: 'zh-HK', reason: '(c) JSON op-type literal identifier' },
	{ key: 'glossary.fiat.title', locale: 'es', reason: '(b) "Fiat" universal crypto loanword' },
	{ key: 'glossary.fiat.title', locale: 'fr', reason: '(b) "Fiat" universal crypto loanword' },
	{ key: 'glossary.fiat.title', locale: 'de', reason: '(b) "Fiat" universal crypto loanword' },
	{ key: 'glossary.fiat.title', locale: 'it', reason: '(b) "Fiat" universal crypto loanword' },
	{ key: 'glossary.fiat.title', locale: 'pl', reason: '(b) "Fiat" universal crypto loanword' },
	{ key: 'glossary.blurt_power.title', locale: 'es', reason: '(c) Blurt-chain proper-name term' },
	{ key: 'glossary.blurt_power.title', locale: 'fr', reason: '(c) Blurt-chain proper-name term' },
	{ key: 'glossary.blurt_power.title', locale: 'de', reason: '(c) Blurt-chain proper-name term' },
	{ key: 'glossary.blurt_power.title', locale: 'it', reason: '(c) Blurt-chain proper-name term' },
	{ key: 'glossary.blurt_power.title', locale: 'pl', reason: '(c) Blurt-chain proper-name term' },
	{ key: 'glossary.blurt_power.title', locale: 'ru', reason: '(c) Blurt-chain proper-name term' },
	{ key: 'glossary.blurt_power.title', locale: 'fa', reason: '(c) Blurt-chain proper-name term' },
	{ key: 'glossary.blurt_power.title', locale: 'zh-CN', reason: '(c) Blurt-chain proper-name term' },
	{ key: 'glossary.blurt_power.title', locale: 'zh-HK', reason: '(c) Blurt-chain proper-name term' },
	{ key: 'cheat_sheet.section_assets.heading', locale: 'es', reason: '(c) all 3 are brand names; "vs" is loanword' },
	{ key: 'cheat_sheet.section_assets.heading', locale: 'fr', reason: '(c) all 3 are brand names; "vs" is loanword' },
	{ key: 'cheat_sheet.section_assets.heading', locale: 'de', reason: '(c) all 3 are brand names; "vs" is loanword' },
	{ key: 'cheat_sheet.section_assets.heading', locale: 'it', reason: '(c) all 3 are brand names; "vs" is loanword' },
	{ key: 'cheat_sheet.section_assets.heading', locale: 'pl', reason: '(c) all 3 are brand names; "vs" is loanword' },
	{ key: 'cheat_sheet.section_assets.heading', locale: 'ru', reason: '(c) all 3 are brand names; "vs" is loanword' },
	{ key: 'cheat_sheet.section_assets.heading', locale: 'zh-CN', reason: '(c) all 3 are brand names; "vs" is loanword' },
	{ key: 'cheat_sheet.section_assets.heading', locale: 'zh-HK', reason: '(c) all 3 are brand names; "vs" is loanword' },
	{ key: 'explorer.block.witness_label', locale: 'de', reason: '(c) Blurt-chain technical term universal' },
	{ key: 'explorer.block.witness_label', locale: 'it', reason: '(c) Blurt-chain technical term universal' },
	{ key: 'explorer.block.witness_label', locale: 'pl', reason: '(c) Blurt-chain technical term universal' },
	{ key: 'explorer.block.witness_label', locale: 'ru', reason: '(c) Blurt-chain technical term universal' },
	{ key: 'explorer.block.witness_label', locale: 'fa', reason: '(c) Blurt-chain technical term universal' },
	{ key: 'explorer.nav.fallback_title', locale: 'es', reason: '(c) literal domain name' },
	{ key: 'explorer.nav.fallback_title', locale: 'fr', reason: '(c) literal domain name' },
	{ key: 'explorer.nav.fallback_title', locale: 'de', reason: '(c) literal domain name' },
	{ key: 'explorer.nav.fallback_title', locale: 'it', reason: '(c) literal domain name' },
	{ key: 'explorer.nav.fallback_title', locale: 'pl', reason: '(c) literal domain name' },
	{ key: 'explorer.nav.fallback_title', locale: 'ru', reason: '(c) literal domain name' },
	{ key: 'explorer.nav.fallback_title', locale: 'fa', reason: '(c) literal domain name' },
	{ key: 'explorer.nav.fallback_title', locale: 'zh-CN', reason: '(c) literal domain name' },
	{ key: 'explorer.nav.fallback_title', locale: 'zh-HK', reason: '(c) literal domain name' },
	{ key: 'my_orders.order.range_both', locale: 'es', reason: '(c) pure format string' },
	{ key: 'my_orders.order.range_both', locale: 'fr', reason: '(c) pure format string' },
	{ key: 'my_orders.order.range_both', locale: 'de', reason: '(c) pure format string' },
	{ key: 'my_orders.order.range_both', locale: 'it', reason: '(c) pure format string' },
	{ key: 'my_orders.order.range_both', locale: 'pl', reason: '(c) pure format string' },
	{ key: 'my_orders.order.range_both', locale: 'ru', reason: '(c) pure format string' },
	{ key: 'my_orders.order.range_both', locale: 'fa', reason: '(c) pure format string' },
	{ key: 'my_orders.order.range_both', locale: 'zh-CN', reason: '(c) pure format string' },
	{ key: 'my_orders.order.range_both', locale: 'zh-HK', reason: '(c) pure format string' },
	{ key: 'orderbook.order.range_both', locale: 'es', reason: '(c) pure format string' },
	{ key: 'orderbook.order.range_both', locale: 'fr', reason: '(c) pure format string' },
	{ key: 'orderbook.order.range_both', locale: 'de', reason: '(c) pure format string' },
	{ key: 'orderbook.order.range_both', locale: 'it', reason: '(c) pure format string' },
	{ key: 'orderbook.order.range_both', locale: 'pl', reason: '(c) pure format string' },
	{ key: 'orderbook.order.range_both', locale: 'ru', reason: '(c) pure format string' },
	{ key: 'orderbook.order.range_both', locale: 'fa', reason: '(c) pure format string' },
	{ key: 'orderbook.order.range_both', locale: 'zh-CN', reason: '(c) pure format string' },
	{ key: 'orderbook.order.range_both', locale: 'zh-HK', reason: '(c) pure format string' },
	// Placeholder examples (latin-script: keep — example formats matter)
	{ key: 'onboarding.import.posting_only.account_placeholder', locale: 'es', reason: '(c) example placeholder name' },
	{ key: 'onboarding.import.posting_only.account_placeholder', locale: 'fr', reason: '(c) example placeholder name' },
	{ key: 'onboarding.import.posting_only.account_placeholder', locale: 'de', reason: '(c) example placeholder name' },
	{ key: 'onboarding.import.posting_only.account_placeholder', locale: 'it', reason: '(c) example placeholder name' },
	{ key: 'onboarding.import.posting_only.account_placeholder', locale: 'pl', reason: '(c) example placeholder name' },
	{ key: 'onboarding.import.posting_only.account_placeholder', locale: 'ru', reason: '(c) example placeholder name' },
	{ key: 'onboarding.import.posting_only.account_placeholder', locale: 'fa', reason: '(c) example placeholder name' },
	{ key: 'onboarding.import.posting_only.account_placeholder', locale: 'zh-CN', reason: '(c) example placeholder name' },
	{ key: 'onboarding.import.posting_only.account_placeholder', locale: 'zh-HK', reason: '(c) example placeholder name' },
	{ key: 'settings.account_name.input_placeholder', locale: 'es', reason: '(c) example placeholder name' },
	{ key: 'settings.account_name.input_placeholder', locale: 'fr', reason: '(c) example placeholder name' },
	{ key: 'settings.account_name.input_placeholder', locale: 'de', reason: '(c) example placeholder name' },
	{ key: 'settings.account_name.input_placeholder', locale: 'it', reason: '(c) example placeholder name' },
	{ key: 'settings.account_name.input_placeholder', locale: 'pl', reason: '(c) example placeholder name' },
	{ key: 'settings.account_name.input_placeholder', locale: 'ru', reason: '(c) example placeholder name' },
	{ key: 'settings.account_name.input_placeholder', locale: 'fa', reason: '(c) example placeholder name' },
	{ key: 'settings.account_name.input_placeholder', locale: 'zh-CN', reason: '(c) example placeholder name' },
	{ key: 'settings.account_name.input_placeholder', locale: 'zh-HK', reason: '(c) example placeholder name' },
	// Latin-script locales legitimately keep "your-new-name" placeholder
	{ key: 'onboarding.register_name.field_placeholder', locale: 'es', reason: '(c) tu-nuevo-nombre is the localized form (already done) — wait check' },
	// footer.instances — French "Instances" is byte-identical to English (coincidence, not a fallback).
	{ key: 'footer.instances', locale: 'fr', reason: '(b) French "Instances" equals English "Instances" — coincidental same-spelling, not an EN fallback' },
	// post_order placeholder
	{ key: 'post_order.form.price_model_fiat_placeholder', locale: 'es', reason: '(b) "fiat" loanword' },
	{ key: 'post_order.form.price_model_fiat_placeholder', locale: 'fr', reason: '(b) "fiat" loanword' },
	{ key: 'post_order.form.price_model_fiat_placeholder', locale: 'it', reason: '(b) "fiat" loanword' },
	{ key: 'post_order.form.price_model_fiat_placeholder', locale: 'pl', reason: '(b) "fiat" loanword' },
	// run_a_node terms
	{ key: 'run_a_node.key_terms.term_indexer', locale: 'it', reason: '(b) "indexer" Italian tech loanword' },
	{ key: 'run_a_node.key_terms.term_indexer', locale: 'pl', reason: '(b) "indexer" Polish tech loanword' },
	{ key: 'run_a_node.key_terms.term_relay', locale: 'es', reason: '(b) "relay" Spanish tech loanword' },
	{ key: 'run_a_node.key_terms.term_relay', locale: 'it', reason: '(b) "relay" Italian tech loanword' },
	{ key: 'run_a_node.key_terms.term_relay', locale: 'pl', reason: '(b) "relay" Polish tech loanword' },
	{ key: 'run_a_node.key_terms.term_relay', locale: 'ru', reason: '(b) Russian uses "relay" loanword for chain context' },
	// Hardware loanword
	{ key: 'run_a_node.req_hw_label', locale: 'es', reason: '(b) "Hardware" universal loanword' },
	{ key: 'run_a_node.req_hw_label', locale: 'de', reason: '(b) "Hardware" universal loanword' },
	{ key: 'run_a_node.req_hw_label', locale: 'it', reason: '(b) "Hardware" universal loanword' },
	// Online category
	{ key: 'payment_method.category.online', locale: 'de', reason: '(b) "Online" loanword' },
	{ key: 'payment_method.category.online', locale: 'it', reason: '(b) "Online" loanword' },
	{ key: 'payment_method.category.online', locale: 'pl', reason: '(b) "Online" loanword' },
	{ key: 'payment_method.category.crypto', locale: 'fr', reason: '(a) "Crypto" is also French' },
	// SEO chat-related — Chat is universal loanword
	{ key: 'seo.chat_inbox.title', locale: 'es', reason: '(b) "Chat" universal loanword' },
	{ key: 'seo.chat_inbox.title', locale: 'fr', reason: '(b) "Chat" universal loanword' },
	{ key: 'seo.chat_inbox.title', locale: 'de', reason: '(b) "Chat" universal loanword' },
	{ key: 'seo.chat_inbox.title', locale: 'it', reason: '(b) "Chat" universal loanword' },
	{ key: 'seo.chat_conversation.title', locale: 'fr', reason: '(a) "Conversation" is also French' },
	{ key: 'seo.order_detail.title', locale: 'de', reason: '(b) "Order" adopted as German tech loanword' },
	{ key: 'download.iphone_heading', locale: 'es', reason: '(c) brand names' },
	// iPad downloads — Spanish "iPhone y iPad" is the established translation, German uses "und"

	// ─── (c) brand/protocol invariants for footer + chain assets ───
	{ key: 'footer.i2p', locale: 'es', reason: '(c) protocol name' },
	{ key: 'footer.i2p', locale: 'fr', reason: '(c) protocol name' },
	{ key: 'footer.i2p', locale: 'de', reason: '(c) protocol name' },
	{ key: 'footer.i2p', locale: 'it', reason: '(c) protocol name' },
	{ key: 'footer.i2p', locale: 'pl', reason: '(c) protocol name' },
	{ key: 'footer.i2p', locale: 'ru', reason: '(c) protocol name' },
	{ key: 'footer.i2p', locale: 'fa', reason: '(c) protocol name' },
	{ key: 'footer.i2p', locale: 'zh-CN', reason: '(c) protocol name' },
	{ key: 'footer.i2p', locale: 'zh-HK', reason: '(c) protocol name' },
	{ key: 'footer.i2p_name', locale: 'es', reason: '(c) protocol name' },
	{ key: 'footer.i2p_name', locale: 'fr', reason: '(c) protocol name' },
	{ key: 'footer.i2p_name', locale: 'de', reason: '(c) protocol name' },
	{ key: 'footer.i2p_name', locale: 'it', reason: '(c) protocol name' },
	{ key: 'footer.i2p_name', locale: 'pl', reason: '(c) protocol name' },
	{ key: 'footer.i2p_name', locale: 'ru', reason: '(c) protocol name' },
	{ key: 'footer.i2p_name', locale: 'fa', reason: '(c) protocol name' },
	{ key: 'footer.i2p_name', locale: 'zh-CN', reason: '(c) protocol name' },
	{ key: 'footer.i2p_name', locale: 'zh-HK', reason: '(c) protocol name' },
	{ key: 'footer.ens', locale: 'es', reason: '(c) protocol name' },
	{ key: 'footer.ens', locale: 'fr', reason: '(c) protocol name' },
	{ key: 'footer.ens', locale: 'de', reason: '(c) protocol name' },
	{ key: 'footer.ens', locale: 'it', reason: '(c) protocol name' },
	{ key: 'footer.ens', locale: 'pl', reason: '(c) protocol name' },
	{ key: 'footer.ens', locale: 'ru', reason: '(c) protocol name' },
	{ key: 'footer.ens', locale: 'fa', reason: '(c) protocol name' },
	{ key: 'footer.ens', locale: 'zh-CN', reason: '(c) protocol name' },
	{ key: 'footer.ens', locale: 'zh-HK', reason: '(c) protocol name' },
	{ key: 'footer.lokinet', locale: 'es', reason: '(c) brand/protocol name' },
	{ key: 'footer.lokinet', locale: 'fr', reason: '(c) brand/protocol name' },
	{ key: 'footer.lokinet', locale: 'de', reason: '(c) brand/protocol name' },
	{ key: 'footer.lokinet', locale: 'it', reason: '(c) brand/protocol name' },
	{ key: 'footer.lokinet', locale: 'pl', reason: '(c) brand/protocol name' },
	{ key: 'footer.lokinet', locale: 'ru', reason: '(c) brand/protocol name' },
	{ key: 'footer.lokinet', locale: 'fa', reason: '(c) brand/protocol name' },
	{ key: 'footer.lokinet', locale: 'zh-CN', reason: '(c) brand/protocol name' },
	{ key: 'footer.lokinet', locale: 'zh-HK', reason: '(c) brand/protocol name' },
	{ key: 'footer.nostr', locale: 'es', reason: '(c) protocol name' },
	{ key: 'footer.nostr', locale: 'fr', reason: '(c) protocol name' },
	{ key: 'footer.nostr', locale: 'de', reason: '(c) protocol name' },
	{ key: 'footer.nostr', locale: 'it', reason: '(c) protocol name' },
	{ key: 'footer.nostr', locale: 'pl', reason: '(c) protocol name' },
	{ key: 'footer.nostr', locale: 'ru', reason: '(c) protocol name' },
	{ key: 'footer.nostr', locale: 'fa', reason: '(c) protocol name' },
	{ key: 'footer.nostr', locale: 'zh-CN', reason: '(c) protocol name' },
	{ key: 'footer.nostr', locale: 'zh-HK', reason: '(c) protocol name' },
	{ key: 'footer.contact_operator_matrix_label', locale: 'es', reason: '(c) brand/protocol name' },
	{ key: 'footer.contact_operator_matrix_label', locale: 'fr', reason: '(c) brand/protocol name' },
	{ key: 'footer.contact_operator_matrix_label', locale: 'de', reason: '(c) brand/protocol name' },
	{ key: 'footer.contact_operator_matrix_label', locale: 'it', reason: '(c) brand/protocol name' },
	{ key: 'footer.contact_operator_matrix_label', locale: 'pl', reason: '(c) brand/protocol name' },
	{ key: 'footer.contact_operator_matrix_label', locale: 'ru', reason: '(c) brand/protocol name' },
	{ key: 'footer.contact_operator_matrix_label', locale: 'zh-CN', reason: '(c) brand/protocol name' },
	{ key: 'footer.contact_operator_matrix_label', locale: 'zh-HK', reason: '(c) brand/protocol name' },
	{ key: 'footer.tor', locale: 'es', reason: '(c) protocol name' },
	{ key: 'footer.tor', locale: 'fr', reason: '(c) protocol name' },
	{ key: 'footer.tor', locale: 'de', reason: '(c) protocol name' },
	{ key: 'footer.tor', locale: 'it', reason: '(c) protocol name' },
	{ key: 'footer.tor', locale: 'pl', reason: '(c) protocol name' },
	{ key: 'footer.tor', locale: 'ru', reason: '(c) protocol name' },
	{ key: 'footer.tor', locale: 'fa', reason: '(c) protocol name' },
	{ key: 'footer.tor', locale: 'zh-CN', reason: '(c) protocol name' },
	{ key: 'footer.tor', locale: 'zh-HK', reason: '(c) protocol name' },
	{ key: 'glossary.blurt.title', locale: 'es', reason: '(c) chain brand name' },
	{ key: 'glossary.blurt.title', locale: 'fr', reason: '(c) chain brand name' },
	{ key: 'glossary.blurt.title', locale: 'de', reason: '(c) chain brand name' },
	{ key: 'glossary.blurt.title', locale: 'it', reason: '(c) chain brand name' },
	{ key: 'glossary.blurt.title', locale: 'pl', reason: '(c) chain brand name' },
	{ key: 'glossary.blurt.title', locale: 'ru', reason: '(c) chain brand name' },
	{ key: 'glossary.blurt.title', locale: 'fa', reason: '(c) chain brand name' },
	{ key: 'glossary.blurt.title', locale: 'zh-CN', reason: '(c) chain brand name' },
	{ key: 'glossary.blurt.title', locale: 'zh-HK', reason: '(c) chain brand name' },
	{ key: 'profile.my_balance.blurt_label', locale: 'es', reason: '(c) chain asset symbol' },
	{ key: 'profile.my_balance.blurt_label', locale: 'fr', reason: '(c) chain asset symbol' },
	{ key: 'profile.my_balance.blurt_label', locale: 'de', reason: '(c) chain asset symbol' },
	{ key: 'profile.my_balance.blurt_label', locale: 'it', reason: '(c) chain asset symbol' },
	{ key: 'profile.my_balance.blurt_label', locale: 'pl', reason: '(c) chain asset symbol' },
	{ key: 'profile.my_balance.blurt_label', locale: 'ru', reason: '(c) chain asset symbol' },
	{ key: 'profile.my_balance.blurt_label', locale: 'fa', reason: '(c) chain asset symbol' },
	{ key: 'profile.my_balance.blurt_label', locale: 'zh-CN', reason: '(c) chain asset symbol' },
	{ key: 'profile.my_balance.blurt_label', locale: 'zh-HK', reason: '(c) chain asset symbol' },

	// ─── (c) Cryptocurrency brand names in chat-address method labels ───
	// "Blurt" is the chain brand name in all locales.  "Bitcoin" and "Monero" are kept
	// as universal English in Latin-script locales; fa/zh-CN/zh-HK have script versions.
	{ key: 'chat.address.method_blurt', locale: 'es', reason: '(c) Blurt chain brand name' },
	{ key: 'chat.address.method_blurt', locale: 'fr', reason: '(c) Blurt chain brand name' },
	{ key: 'chat.address.method_blurt', locale: 'de', reason: '(c) Blurt chain brand name' },
	{ key: 'chat.address.method_blurt', locale: 'it', reason: '(c) Blurt chain brand name' },
	{ key: 'chat.address.method_blurt', locale: 'pl', reason: '(c) Blurt chain brand name' },
	{ key: 'chat.address.method_blurt', locale: 'ru', reason: '(c) Blurt chain brand name' },
	{ key: 'chat.address.method_blurt', locale: 'fa', reason: '(c) Blurt chain brand name' },
	{ key: 'chat.address.method_blurt', locale: 'zh-CN', reason: '(c) Blurt chain brand name' },
	{ key: 'chat.address.method_blurt', locale: 'zh-HK', reason: '(c) Blurt chain brand name' },
	{ key: 'chat.address.method_btc', locale: 'es', reason: '(c) Bitcoin universal brand' },
	{ key: 'chat.address.method_btc', locale: 'fr', reason: '(c) Bitcoin universal brand' },
	{ key: 'chat.address.method_btc', locale: 'de', reason: '(c) Bitcoin universal brand' },
	{ key: 'chat.address.method_btc', locale: 'it', reason: '(c) Bitcoin universal brand' },
	{ key: 'chat.address.method_btc', locale: 'pl', reason: '(c) Bitcoin universal brand' },
	{ key: 'chat.address.method_btc', locale: 'ru', reason: '(c) Bitcoin universal brand (Latin-script intentional)' },
	{ key: 'chat.address.method_xmr', locale: 'es', reason: '(c) Monero universal brand' },
	{ key: 'chat.address.method_xmr', locale: 'fr', reason: '(c) Monero universal brand' },
	{ key: 'chat.address.method_xmr', locale: 'de', reason: '(c) Monero universal brand' },
	{ key: 'chat.address.method_xmr', locale: 'it', reason: '(c) Monero universal brand' },
	{ key: 'chat.address.method_xmr', locale: 'pl', reason: '(c) Monero universal brand' },
	{ key: 'chat.address.method_xmr', locale: 'ru', reason: '(c) Monero universal brand (Latin-script intentional)' },
	{ key: 'seo.site_name', locale: 'es', reason: '(c) Morphit brand name' },
	{ key: 'seo.site_name', locale: 'fr', reason: '(c) Morphit brand name' },
	{ key: 'seo.site_name', locale: 'de', reason: '(c) Morphit brand name' },
	{ key: 'seo.site_name', locale: 'it', reason: '(c) Morphit brand name' },
	{ key: 'seo.site_name', locale: 'pl', reason: '(c) Morphit brand name' },
	{ key: 'seo.site_name', locale: 'ru', reason: '(c) Morphit brand name' },
	{ key: 'seo.site_name', locale: 'fa', reason: '(c) Morphit brand name' },
	{ key: 'seo.site_name', locale: 'zh-CN', reason: '(c) Morphit brand name' },
	{ key: 'seo.site_name', locale: 'zh-HK', reason: '(c) Morphit brand name' },

	// ─── (c) URL/example placeholders that should NOT be localized ───
	{ key: 'compare.input.placeholder', locale: 'es', reason: '(c) URL example placeholder' },
	{ key: 'compare.input.placeholder', locale: 'fr', reason: '(c) URL example placeholder' },
	{ key: 'compare.input.placeholder', locale: 'de', reason: '(c) URL example placeholder' },
	{ key: 'compare.input.placeholder', locale: 'it', reason: '(c) URL example placeholder' },
	{ key: 'compare.input.placeholder', locale: 'pl', reason: '(c) URL example placeholder' },
	{ key: 'compare.input.placeholder', locale: 'ru', reason: '(c) URL example placeholder' },
	{ key: 'compare.input.placeholder', locale: 'fa', reason: '(c) URL example placeholder' },
	{ key: 'compare.input.placeholder', locale: 'zh-CN', reason: '(c) URL example placeholder' },
	{ key: 'compare.input.placeholder', locale: 'zh-HK', reason: '(c) URL example placeholder' },
	{ key: 'explorer.block.previous_link', locale: 'es', reason: '(c) pure format/anchor' },
	{ key: 'explorer.block.previous_link', locale: 'fr', reason: '(c) pure format/anchor' },
	{ key: 'explorer.block.previous_link', locale: 'de', reason: '(c) pure format/anchor' },
	{ key: 'explorer.block.previous_link', locale: 'it', reason: '(c) pure format/anchor' },
	{ key: 'explorer.block.previous_link', locale: 'pl', reason: '(c) pure format/anchor' },
	{ key: 'explorer.block.previous_link', locale: 'ru', reason: '(c) pure format/anchor' },
	{ key: 'explorer.block.previous_link', locale: 'fa', reason: '(c) pure format/anchor' },
	{ key: 'explorer.block.previous_link', locale: 'zh-CN', reason: '(c) pure format/anchor' },
	{ key: 'explorer.block.previous_link', locale: 'zh-HK', reason: '(c) pure format/anchor' },
	{ key: 'explorer.search.placeholder', locale: 'es', reason: '(c) example identifier formats' },
	{ key: 'explorer.search.placeholder', locale: 'fr', reason: '(c) example identifier formats' },
	{ key: 'explorer.search.placeholder', locale: 'de', reason: '(c) example identifier formats' },
	{ key: 'explorer.search.placeholder', locale: 'it', reason: '(c) example identifier formats' },
	{ key: 'explorer.search.placeholder', locale: 'pl', reason: '(c) example identifier formats' },
	{ key: 'explorer.search.placeholder', locale: 'ru', reason: '(c) example identifier formats' },
	{ key: 'explorer.search.placeholder', locale: 'fa', reason: '(c) example identifier formats' },
	{ key: 'explorer.search.placeholder', locale: 'zh-CN', reason: '(c) example identifier formats' },
	{ key: 'explorer.search.placeholder', locale: 'zh-HK', reason: '(c) example identifier formats' },
	{ key: 'settings.endpoints.add_placeholder', locale: 'fa', reason: '(c) URL example placeholder' },
	{ key: 'settings.endpoints.add_placeholder', locale: 'ru', reason: '(c) URL example placeholder' },
	{ key: 'settings.endpoints.add_placeholder', locale: 'zh-CN', reason: '(c) URL example placeholder' },
	{ key: 'settings.endpoints.add_placeholder', locale: 'zh-HK', reason: '(c) URL example placeholder' },

	// ─── Witness in zh-CN/zh-HK (already allow-listed for the others) ───
	{ key: 'explorer.block.witness_label', locale: 'zh-CN', reason: '(c) Blurt-chain technical term universal' },
	{ key: 'explorer.block.witness_label', locale: 'zh-HK', reason: '(c) Blurt-chain technical term universal' },

	// ─── Latin-script duration abbreviations: m/h/d/mo widely shared ───
	{ key: 'feature_bid.hours_option', locale: 'es', reason: '(b) "h" universal Latin-script duration shorthand' },
	{ key: 'feature_bid.hours_option', locale: 'fr', reason: '(b) "h" universal Latin-script duration shorthand' },
	{ key: 'feature_bid.hours_option', locale: 'de', reason: '(b) "h" universal Latin-script duration shorthand' },
	{ key: 'feature_bid.hours_option', locale: 'it', reason: '(b) "h" universal Latin-script duration shorthand' },
	{ key: 'feature_bid.hours_option', locale: 'pl', reason: '(b) "h" universal Latin-script duration shorthand' },
	{ key: 'relative_time.terse.days', locale: 'es', reason: '(b) "d" = "días" abbreviation' },
	{ key: 'relative_time.terse.days', locale: 'pl', reason: '(b) "d" = "dni" abbreviation' },
	{ key: 'relative_time.terse.hours', locale: 'es', reason: '(b) "h" = "horas" abbreviation' },
	{ key: 'relative_time.terse.hours', locale: 'fr', reason: '(b) "h" = "heures" abbreviation' },
	{ key: 'relative_time.terse.hours', locale: 'de', reason: '(b) "h" = "Stunden" abbreviation' },
	{ key: 'relative_time.terse.hours', locale: 'it', reason: '(b) "h" = "ore" abbreviation' },
	{ key: 'relative_time.terse.hours', locale: 'pl', reason: '(b) "h" = "godziny" abbreviation' },
	{ key: 'relative_time.terse.lt1m', locale: 'es', reason: '(b) "<1m" universal Latin-script duration shorthand' },
	{ key: 'relative_time.terse.lt1m', locale: 'fr', reason: '(b) "<1m" universal Latin-script duration shorthand' },
	{ key: 'relative_time.terse.lt1m', locale: 'de', reason: '(b) "<1m" universal Latin-script duration shorthand' },
	{ key: 'relative_time.terse.lt1m', locale: 'it', reason: '(b) "<1m" universal Latin-script duration shorthand' },
	{ key: 'relative_time.terse.lt1m', locale: 'pl', reason: '(b) "<1m" universal Latin-script duration shorthand' },
	{ key: 'relative_time.terse.lt1m', locale: 'ru', reason: '(b) "<1m" used as Latin-script time shorthand even in Cyrillic UI' },
	{ key: 'relative_time.terse.minutes', locale: 'es', reason: '(b) "m" = "minutos" abbreviation' },
	{ key: 'relative_time.terse.minutes', locale: 'fr', reason: '(b) "m" = "minutes" abbreviation' },
	{ key: 'relative_time.terse.minutes', locale: 'de', reason: '(b) "m" = "Minuten" abbreviation' },
	{ key: 'relative_time.terse.minutes', locale: 'it', reason: '(b) "m" = "minuti" abbreviation' },
	{ key: 'relative_time.terse.minutes', locale: 'pl', reason: '(b) "m" = "minuty" abbreviation' },
	{ key: 'relative_time.terse.months', locale: 'fr', reason: '(b) "mo" = "mois" — unusual but used' },
	{ key: 'clearing_price.window_label', locale: 'es', reason: '(b) "{days}d" duration shorthand' },
	{ key: 'clearing_price.window_label', locale: 'pl', reason: '(b) "{days}d" duration shorthand' },
	// Part 108++ — wallet brand/product names: invariant across all locales
	{ key: 'post_order.fee_method.tx_proof_how_to_cli_heading', locale: 'es', reason: '(c) "Monero CLI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cli_heading', locale: 'fr', reason: '(c) "Monero CLI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cli_heading', locale: 'de', reason: '(c) "Monero CLI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cli_heading', locale: 'it', reason: '(c) "Monero CLI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cli_heading', locale: 'pl', reason: '(c) "Monero CLI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cli_heading', locale: 'ru', reason: '(c) "Monero CLI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cli_heading', locale: 'fa', reason: '(c) "Monero CLI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cli_heading', locale: 'zh-CN', reason: '(c) "Monero CLI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cli_heading', locale: 'zh-HK', reason: '(c) "Monero CLI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_gui_heading', locale: 'es', reason: '(c) "Monero GUI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_gui_heading', locale: 'fr', reason: '(c) "Monero GUI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_gui_heading', locale: 'de', reason: '(c) "Monero GUI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_gui_heading', locale: 'it', reason: '(c) "Monero GUI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_gui_heading', locale: 'pl', reason: '(c) "Monero GUI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_gui_heading', locale: 'ru', reason: '(c) "Monero GUI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_gui_heading', locale: 'fa', reason: '(c) "Monero GUI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_gui_heading', locale: 'zh-CN', reason: '(c) "Monero GUI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_gui_heading', locale: 'zh-HK', reason: '(c) "Monero GUI" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cake_heading', locale: 'es', reason: '(c) "Cake Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cake_heading', locale: 'fr', reason: '(c) "Cake Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cake_heading', locale: 'de', reason: '(c) "Cake Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cake_heading', locale: 'it', reason: '(c) "Cake Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cake_heading', locale: 'pl', reason: '(c) "Cake Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cake_heading', locale: 'ru', reason: '(c) "Cake Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cake_heading', locale: 'fa', reason: '(c) "Cake Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cake_heading', locale: 'zh-CN', reason: '(c) "Cake Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_cake_heading', locale: 'zh-HK', reason: '(c) "Cake Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_feather_heading', locale: 'es', reason: '(c) "Feather Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_feather_heading', locale: 'fr', reason: '(c) "Feather Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_feather_heading', locale: 'de', reason: '(c) "Feather Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_feather_heading', locale: 'it', reason: '(c) "Feather Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_feather_heading', locale: 'pl', reason: '(c) "Feather Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_feather_heading', locale: 'ru', reason: '(c) "Feather Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_feather_heading', locale: 'fa', reason: '(c) "Feather Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_feather_heading', locale: 'zh-CN', reason: '(c) "Feather Wallet" is a brand/product name' },
	{ key: 'post_order.fee_method.tx_proof_how_to_feather_heading', locale: 'zh-HK', reason: '(c) "Feather Wallet" is a brand/product name' },

	// ─── Part 121 — USDT proper nouns ───
	// "Tether" is a brand name; same spelling in all Latin-script
	// locales.  fa/zh-CN/zh-HK get native transliterations (تتر,
	// 泰达币, 泰達幣) so they're not in the allow-list.
	{ key: 'assets.usdt.displayName', locale: 'de', reason: '(c) "Tether" is a brand name' },
	{ key: 'assets.usdt.displayName', locale: 'es', reason: '(c) "Tether" is a brand name' },
	{ key: 'assets.usdt.displayName', locale: 'fr', reason: '(c) "Tether" is a brand name' },
	{ key: 'assets.usdt.displayName', locale: 'it', reason: '(c) "Tether" is a brand name' },
	{ key: 'assets.usdt.displayName', locale: 'pl', reason: '(c) "Tether" is a brand name' },
	{ key: 'assets.usdt.displayName', locale: 'ru', reason: '(c) "Tether" is a brand name' },
	// Network display names: chain-name + ERC/TRC/SPL/BEP standard
	// suffix are technical identifiers that don't translate.  fa
	// transliterates the chain name to Persian script for most;
	// for BNB Smart Chain even fa keeps it untranslated because
	// BNB is an acronym + "Smart Chain" is a brand-product name.
	{ key: 'assets.usdt.network.erc20.displayName', locale: 'de', reason: '(c) "Ethereum (ERC-20)" — brand + ERC-20 standard suffix' },
	{ key: 'assets.usdt.network.erc20.displayName', locale: 'es', reason: '(c) "Ethereum (ERC-20)" — brand + ERC-20 standard suffix' },
	{ key: 'assets.usdt.network.erc20.displayName', locale: 'fr', reason: '(c) "Ethereum (ERC-20)" — brand + ERC-20 standard suffix' },
	{ key: 'assets.usdt.network.erc20.displayName', locale: 'it', reason: '(c) "Ethereum (ERC-20)" — brand + ERC-20 standard suffix' },
	{ key: 'assets.usdt.network.erc20.displayName', locale: 'pl', reason: '(c) "Ethereum (ERC-20)" — brand + ERC-20 standard suffix' },
	{ key: 'assets.usdt.network.erc20.displayName', locale: 'ru', reason: '(c) "Ethereum (ERC-20)" — brand + ERC-20 standard suffix' },
	{ key: 'assets.usdt.network.trc20.displayName', locale: 'de', reason: '(c) "Tron (TRC-20)" — brand + TRC-20 standard suffix' },
	{ key: 'assets.usdt.network.trc20.displayName', locale: 'es', reason: '(c) "Tron (TRC-20)" — brand + TRC-20 standard suffix' },
	{ key: 'assets.usdt.network.trc20.displayName', locale: 'fr', reason: '(c) "Tron (TRC-20)" — brand + TRC-20 standard suffix' },
	{ key: 'assets.usdt.network.trc20.displayName', locale: 'it', reason: '(c) "Tron (TRC-20)" — brand + TRC-20 standard suffix' },
	{ key: 'assets.usdt.network.trc20.displayName', locale: 'pl', reason: '(c) "Tron (TRC-20)" — brand + TRC-20 standard suffix' },
	{ key: 'assets.usdt.network.trc20.displayName', locale: 'ru', reason: '(c) "Tron (TRC-20)" — brand + TRC-20 standard suffix' },
	{ key: 'assets.usdt.network.spl.displayName', locale: 'de', reason: '(c) "Solana (SPL)" — brand + SPL standard suffix' },
	{ key: 'assets.usdt.network.spl.displayName', locale: 'es', reason: '(c) "Solana (SPL)" — brand + SPL standard suffix' },
	{ key: 'assets.usdt.network.spl.displayName', locale: 'fr', reason: '(c) "Solana (SPL)" — brand + SPL standard suffix' },
	{ key: 'assets.usdt.network.spl.displayName', locale: 'it', reason: '(c) "Solana (SPL)" — brand + SPL standard suffix' },
	{ key: 'assets.usdt.network.spl.displayName', locale: 'pl', reason: '(c) "Solana (SPL)" — brand + SPL standard suffix' },
	{ key: 'assets.usdt.network.spl.displayName', locale: 'ru', reason: '(c) "Solana (SPL)" — brand + SPL standard suffix' },
	{ key: 'assets.usdt.network.bep20.displayName', locale: 'de', reason: '(c) "BNB Smart Chain (BEP-20)" — BNB acronym + Smart Chain brand + BEP-20 standard suffix' },
	{ key: 'assets.usdt.network.bep20.displayName', locale: 'es', reason: '(c) "BNB Smart Chain (BEP-20)" — BNB acronym + Smart Chain brand + BEP-20 standard suffix' },
	{ key: 'assets.usdt.network.bep20.displayName', locale: 'fa', reason: '(c) "BNB Smart Chain (BEP-20)" — BNB acronym + Smart Chain brand + BEP-20 standard suffix' },
	{ key: 'assets.usdt.network.bep20.displayName', locale: 'fr', reason: '(c) "BNB Smart Chain (BEP-20)" — BNB acronym + Smart Chain brand + BEP-20 standard suffix' },
	{ key: 'assets.usdt.network.bep20.displayName', locale: 'it', reason: '(c) "BNB Smart Chain (BEP-20)" — BNB acronym + Smart Chain brand + BEP-20 standard suffix' },
	{ key: 'assets.usdt.network.bep20.displayName', locale: 'pl', reason: '(c) "BNB Smart Chain (BEP-20)" — BNB acronym + Smart Chain brand + BEP-20 standard suffix' },
	{ key: 'assets.usdt.network.bep20.displayName', locale: 'ru', reason: '(c) "BNB Smart Chain (BEP-20)" — BNB acronym + Smart Chain brand + BEP-20 standard suffix' },

	// "USDT" is a universal acronym; same spelling everywhere.
	{ key: 'chat.address.method_usdt', locale: 'de', reason: '(c) "USDT" is a universal acronym' },
	{ key: 'chat.address.method_usdt', locale: 'es', reason: '(c) "USDT" is a universal acronym' },
	{ key: 'chat.address.method_usdt', locale: 'fa', reason: '(c) "USDT" is a universal acronym' },
	{ key: 'chat.address.method_usdt', locale: 'fr', reason: '(c) "USDT" is a universal acronym' },
	{ key: 'chat.address.method_usdt', locale: 'it', reason: '(c) "USDT" is a universal acronym' },
	{ key: 'chat.address.method_usdt', locale: 'pl', reason: '(c) "USDT" is a universal acronym' },
	{ key: 'chat.address.method_usdt', locale: 'ru', reason: '(c) "USDT" is a universal acronym' },
	{ key: 'chat.address.method_usdt', locale: 'zh-CN', reason: '(c) "USDT" is a universal acronym' },
	{ key: 'chat.address.method_usdt', locale: 'zh-HK', reason: '(c) "USDT" is a universal acronym' },

	// ─── (c) cp64: per-asset invariants (proper nouns / acronyms / protocol identifiers) — Memory #29 native-locale policy ───
	{ key: 'chat.address.method_arrr', locale: 'es', reason: `(c) "ARRR" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_arrr', locale: 'fr', reason: `(c) "ARRR" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_arrr', locale: 'de', reason: `(c) "ARRR" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_bch', locale: 'es', reason: `(c) "Bitcoin Cash" is the proper brand name; no translation` },
	{ key: 'chat.address.method_bch', locale: 'fr', reason: `(c) "Bitcoin Cash" is the proper brand name; no translation` },
	{ key: 'chat.address.method_bch', locale: 'de', reason: `(c) "Bitcoin Cash" is the proper brand name; no translation` },
	{ key: 'chat.address.method_dai', locale: 'es', reason: `(c) "DAI" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_dai', locale: 'fr', reason: `(c) "DAI" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_dai', locale: 'de', reason: `(c) "DAI" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_dash', locale: 'es', reason: `(c) "Dash" is the proper brand name; no translation` },
	{ key: 'chat.address.method_dash', locale: 'fr', reason: `(c) "Dash" is the proper brand name; no translation` },
	{ key: 'chat.address.method_dash', locale: 'de', reason: `(c) "Dash" is the proper brand name; no translation` },
	{ key: 'chat.address.method_dcr', locale: 'es', reason: `(c) "DCR" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_dcr', locale: 'fr', reason: `(c) "DCR" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_dcr', locale: 'de', reason: `(c) "DCR" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_doge', locale: 'es', reason: `(c) "Dogecoin" is the proper brand name; no translation` },
	{ key: 'chat.address.method_doge', locale: 'fr', reason: `(c) "Dogecoin" is the proper brand name; no translation` },
	{ key: 'chat.address.method_doge', locale: 'de', reason: `(c) "Dogecoin" is the proper brand name; no translation` },
	{ key: 'chat.address.method_eth', locale: 'es', reason: `(c) "ETH" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_eth', locale: 'fr', reason: `(c) "ETH" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_eth', locale: 'de', reason: `(c) "ETH" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_ltc', locale: 'es', reason: `(c) "Litecoin" is the proper brand name; no translation` },
	{ key: 'chat.address.method_ltc', locale: 'fr', reason: `(c) "Litecoin" is the proper brand name; no translation` },
	{ key: 'chat.address.method_ltc', locale: 'de', reason: `(c) "Litecoin" is the proper brand name; no translation` },
	{ key: 'chat.address.method_sol', locale: 'es', reason: `(c) "SOL" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_sol', locale: 'fr', reason: `(c) "SOL" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_sol', locale: 'de', reason: `(c) "SOL" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_usdc', locale: 'es', reason: `(c) "USDC" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_usdc', locale: 'fr', reason: `(c) "USDC" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_usdc', locale: 'de', reason: `(c) "USDC" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_xrp', locale: 'es', reason: `(c) "XRP" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_xrp', locale: 'fr', reason: `(c) "XRP" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_xrp', locale: 'de', reason: `(c) "XRP" is the universal ticker symbol; no translation` },
	{ key: 'chat.address.method_zec', locale: 'es', reason: `(c) "Zcash" is the proper brand name; no translation` },
	{ key: 'chat.address.method_zec', locale: 'fr', reason: `(c) "Zcash" is the proper brand name; no translation` },
	{ key: 'chat.address.method_zec', locale: 'de', reason: `(c) "Zcash" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_arrr', locale: 'es', reason: `(c) "Pirate Chain (ARRR)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_arrr', locale: 'fr', reason: `(c) "Pirate Chain (ARRR)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_arrr', locale: 'de', reason: `(c) "Pirate Chain (ARRR)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_dai', locale: 'es', reason: `(c) "DAI {network}" — DAI is the brand; {network} is a placeholder` },
	{ key: 'chat.address.pill_method_dai', locale: 'fr', reason: `(c) "DAI {network}" — DAI is the brand; {network} is a placeholder` },
	{ key: 'chat.address.pill_method_dai', locale: 'de', reason: `(c) "DAI {network}" — DAI is the brand; {network} is a placeholder` },
	{ key: 'chat.address.pill_method_dcr', locale: 'es', reason: `(c) "Decred (DCR)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_dcr', locale: 'fr', reason: `(c) "Decred (DCR)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_dcr', locale: 'de', reason: `(c) "Decred (DCR)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_eth', locale: 'es', reason: `(c) "Ethereum (ETH)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_eth', locale: 'fr', reason: `(c) "Ethereum (ETH)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_eth', locale: 'de', reason: `(c) "Ethereum (ETH)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_sol', locale: 'es', reason: `(c) "Solana (SOL)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_sol', locale: 'fr', reason: `(c) "Solana (SOL)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_sol', locale: 'de', reason: `(c) "Solana (SOL)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_xrp', locale: 'es', reason: `(c) "Ripple (XRP)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_xrp', locale: 'fr', reason: `(c) "Ripple (XRP)" is the proper brand name; no translation` },
	{ key: 'chat.address.pill_method_xrp', locale: 'de', reason: `(c) "Ripple (XRP)" is the proper brand name; no translation` },
	{ key: 'assets.dai.network.arbitrum.displayName', locale: 'es', reason: `(c) "Arbitrum One" is the proper network/brand name` },
	{ key: 'assets.dai.network.arbitrum.displayName', locale: 'fr', reason: `(c) "Arbitrum One" is the proper network/brand name` },
	{ key: 'assets.dai.network.arbitrum.displayName', locale: 'de', reason: `(c) "Arbitrum One" is the proper network/brand name` },
	{ key: 'assets.dai.network.base.displayName', locale: 'es', reason: `(c) "Base" is the proper network/brand name (Coinbase L2)` },
	{ key: 'assets.dai.network.base.displayName', locale: 'fr', reason: `(c) "Base" is the proper network/brand name (Coinbase L2)` },
	{ key: 'assets.dai.network.base.displayName', locale: 'de', reason: `(c) "Base" is the proper network/brand name (Coinbase L2)` },
	{ key: 'assets.dai.network.erc20.displayName', locale: 'es', reason: `(c) "Ethereum (ERC-20)" is the protocol identifier` },
	{ key: 'assets.dai.network.erc20.displayName', locale: 'fr', reason: `(c) "Ethereum (ERC-20)" is the protocol identifier` },
	{ key: 'assets.dai.network.erc20.displayName', locale: 'de', reason: `(c) "Ethereum (ERC-20)" is the protocol identifier` },
	{ key: 'assets.dai.network.polygon.displayName', locale: 'es', reason: `(c) "Polygon (PoS)" is the proper network name + protocol designation` },
	{ key: 'assets.dai.network.polygon.displayName', locale: 'fr', reason: `(c) "Polygon (PoS)" is the proper network name + protocol designation` },
	{ key: 'assets.dai.network.polygon.displayName', locale: 'de', reason: `(c) "Polygon (PoS)" is the proper network name + protocol designation` },
	{ key: 'assets.usdc.network.base.displayName', locale: 'es', reason: `(c) "Base" is the proper network/brand name (Coinbase L2)` },
	{ key: 'assets.usdc.network.base.displayName', locale: 'fr', reason: `(c) "Base" is the proper network/brand name (Coinbase L2)` },
	{ key: 'assets.usdc.network.base.displayName', locale: 'de', reason: `(c) "Base" is the proper network/brand name (Coinbase L2)` },
	{ key: 'assets.usdc.network.erc20.displayName', locale: 'es', reason: `(c) "Ethereum (ERC-20)" is the protocol identifier` },
	{ key: 'assets.usdc.network.erc20.displayName', locale: 'fr', reason: `(c) "Ethereum (ERC-20)" is the protocol identifier` },
	{ key: 'assets.usdc.network.erc20.displayName', locale: 'de', reason: `(c) "Ethereum (ERC-20)" is the protocol identifier` },
	{ key: 'assets.usdc.network.polygon.displayName', locale: 'es', reason: `(c) "Polygon" is the proper network/brand name` },
	{ key: 'assets.usdc.network.polygon.displayName', locale: 'fr', reason: `(c) "Polygon" is the proper network/brand name` },
	{ key: 'assets.usdc.network.polygon.displayName', locale: 'de', reason: `(c) "Polygon" is the proper network/brand name` },
	{ key: 'assets.usdc.network.spl.displayName', locale: 'es', reason: `(c) "Solana (SPL)" is the protocol identifier` },
	{ key: 'assets.usdc.network.spl.displayName', locale: 'fr', reason: `(c) "Solana (SPL)" is the protocol identifier` },
	{ key: 'assets.usdc.network.spl.displayName', locale: 'de', reason: `(c) "Solana (SPL)" is the protocol identifier` },
	{ key: 'privacy.opt_in_tech.cashfusion.name', locale: 'es', reason: `(c) "CashFusion" is the proper protocol name; no translation` },
	{ key: 'privacy.opt_in_tech.cashfusion.name', locale: 'fr', reason: `(c) "CashFusion" is the proper protocol name; no translation` },
	{ key: 'privacy.opt_in_tech.cashfusion.name', locale: 'de', reason: `(c) "CashFusion" is the proper protocol name; no translation` },
	{ key: 'privacy.opt_in_tech.coinjoin.name', locale: 'es', reason: `(c) "CoinJoin" is the proper protocol name; no translation` },
	{ key: 'privacy.opt_in_tech.coinjoin.name', locale: 'fr', reason: `(c) "CoinJoin" is the proper protocol name; no translation` },
	{ key: 'privacy.opt_in_tech.coinjoin.name', locale: 'de', reason: `(c) "CoinJoin" is the proper protocol name; no translation` },
	{ key: 'privacy.opt_in_tech.mweb.name', locale: 'es', reason: `(c) "MWEB (MimbleWimble Extension Blocks)" is the proper protocol name` },
	{ key: 'privacy.opt_in_tech.mweb.name', locale: 'fr', reason: `(c) "MWEB (MimbleWimble Extension Blocks)" is the proper protocol name` },
	{ key: 'privacy.opt_in_tech.mweb.name', locale: 'de', reason: `(c) "MWEB (MimbleWimble Extension Blocks)" is the proper protocol name` },
	{ key: 'privacy.opt_in_tech.payjoin.name', locale: 'es', reason: `(c) "PayJoin (BIP-78)" is the proper protocol name + BIP designation` },
	{ key: 'privacy.opt_in_tech.payjoin.name', locale: 'fr', reason: `(c) "PayJoin (BIP-78)" is the proper protocol name + BIP designation` },
	{ key: 'privacy.opt_in_tech.payjoin.name', locale: 'de', reason: `(c) "PayJoin (BIP-78)" is the proper protocol name + BIP designation` },
	{ key: 'privacy.opt_in_tech.privatesend.name', locale: 'es', reason: `(c) "PrivateSend" is the proper protocol name (Dash); no translation` },
	{ key: 'privacy.opt_in_tech.privatesend.name', locale: 'fr', reason: `(c) "PrivateSend" is the proper protocol name (Dash); no translation` },
	{ key: 'privacy.opt_in_tech.privatesend.name', locale: 'de', reason: `(c) "PrivateSend" is the proper protocol name (Dash); no translation` },
	{ key: 'assets.dai.price_subline.live', locale: 'es', reason: `(c) "1 DAI = \${price}" — DAI brand + placeholder, no prose` },
	{ key: 'assets.dai.price_subline.live', locale: 'fr', reason: `(c) "1 DAI = \${price}" — DAI brand + placeholder, no prose` },
	{ key: 'assets.dai.price_subline.live', locale: 'de', reason: `(c) "1 DAI = \${price}" — DAI brand + placeholder, no prose` },
	{ key: 'assets.dai.network.picker.label', locale: 'es', reason: `(c) "DAI network" — DAI brand; "network" treated as invariant in tight UI label` },
	{ key: 'assets.dai.network.picker.label', locale: 'fr', reason: `(c) "DAI network" — DAI brand; "network" treated as invariant in tight UI label` },
	{ key: 'assets.dai.network.picker.label', locale: 'de', reason: `(c) "DAI network" — DAI brand; "network" treated as invariant in tight UI label` },
	{ key: 'assets.dai.network.arbitrum.displayName', locale: 'it', reason: `(c) "Arbitrum One" — brand name, no translation` },
	{ key: 'assets.dai.network.arbitrum.displayName', locale: 'pl', reason: `(c) "Arbitrum One" — brand name, no translation` },
	{ key: 'assets.dai.network.arbitrum.displayName', locale: 'ru', reason: `(c) "Arbitrum One" — brand name, no translation` },
	{ key: 'assets.dai.network.arbitrum.displayName', locale: 'fa', reason: `(c) "Arbitrum One" — brand name, no translation` },
	{ key: 'assets.dai.network.arbitrum.displayName', locale: 'zh-CN', reason: `(c) "Arbitrum One" — brand name, no translation` },
	{ key: 'assets.dai.network.arbitrum.displayName', locale: 'zh-HK', reason: `(c) "Arbitrum One" — brand name, no translation` },
	{ key: 'assets.dai.network.base.displayName', locale: 'it', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.dai.network.base.displayName', locale: 'pl', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.dai.network.base.displayName', locale: 'ru', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.dai.network.base.displayName', locale: 'fa', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.dai.network.base.displayName', locale: 'zh-CN', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.dai.network.base.displayName', locale: 'zh-HK', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.dai.network.erc20.displayName', locale: 'it', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.dai.network.erc20.displayName', locale: 'pl', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.dai.network.erc20.displayName', locale: 'ru', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.dai.network.erc20.displayName', locale: 'fa', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.dai.network.erc20.displayName', locale: 'zh-CN', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.dai.network.erc20.displayName', locale: 'zh-HK', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.dai.network.polygon.displayName', locale: 'it', reason: `(c) "Polygon (PoS)" — brand + consensus name` },
	{ key: 'assets.dai.network.polygon.displayName', locale: 'pl', reason: `(c) "Polygon (PoS)" — brand + consensus name` },
	{ key: 'assets.dai.network.polygon.displayName', locale: 'ru', reason: `(c) "Polygon (PoS)" — brand + consensus name` },
	{ key: 'assets.dai.network.polygon.displayName', locale: 'fa', reason: `(c) "Polygon (PoS)" — brand + consensus name` },
	{ key: 'assets.dai.network.polygon.displayName', locale: 'zh-CN', reason: `(c) "Polygon (PoS)" — brand + consensus name` },
	{ key: 'assets.dai.network.polygon.displayName', locale: 'zh-HK', reason: `(c) "Polygon (PoS)" — brand + consensus name` },
	{ key: 'assets.usdc.network.base.displayName', locale: 'it', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.usdc.network.base.displayName', locale: 'pl', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.usdc.network.base.displayName', locale: 'ru', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.usdc.network.base.displayName', locale: 'fa', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.usdc.network.base.displayName', locale: 'zh-CN', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.usdc.network.base.displayName', locale: 'zh-HK', reason: `(c) "Base" — brand name, no translation` },
	{ key: 'assets.usdc.network.erc20.displayName', locale: 'it', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.usdc.network.erc20.displayName', locale: 'pl', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.usdc.network.erc20.displayName', locale: 'ru', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.usdc.network.erc20.displayName', locale: 'fa', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.usdc.network.erc20.displayName', locale: 'zh-CN', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.usdc.network.erc20.displayName', locale: 'zh-HK', reason: `(c) "Ethereum (ERC-20)" — brand + protocol name` },
	{ key: 'assets.usdc.network.polygon.displayName', locale: 'it', reason: `(c) "Polygon" — brand name` },
	{ key: 'assets.usdc.network.polygon.displayName', locale: 'pl', reason: `(c) "Polygon" — brand name` },
	{ key: 'assets.usdc.network.polygon.displayName', locale: 'ru', reason: `(c) "Polygon" — brand name` },
	{ key: 'assets.usdc.network.polygon.displayName', locale: 'fa', reason: `(c) "Polygon" — brand name` },
	{ key: 'assets.usdc.network.polygon.displayName', locale: 'zh-CN', reason: `(c) "Polygon" — brand name` },
	{ key: 'assets.usdc.network.polygon.displayName', locale: 'zh-HK', reason: `(c) "Polygon" — brand name` },
	{ key: 'assets.usdc.network.spl.displayName', locale: 'it', reason: `(c) "Solana (SPL)" — brand + token-program name` },
	{ key: 'assets.usdc.network.spl.displayName', locale: 'pl', reason: `(c) "Solana (SPL)" — brand + token-program name` },
	{ key: 'assets.usdc.network.spl.displayName', locale: 'ru', reason: `(c) "Solana (SPL)" — brand + token-program name` },
	{ key: 'assets.usdc.network.spl.displayName', locale: 'fa', reason: `(c) "Solana (SPL)" — brand + token-program name` },
	{ key: 'assets.usdc.network.spl.displayName', locale: 'zh-CN', reason: `(c) "Solana (SPL)" — brand + token-program name` },
	{ key: 'assets.usdc.network.spl.displayName', locale: 'zh-HK', reason: `(c) "Solana (SPL)" — brand + token-program name` },
	{ key: 'chat.address.method_arrr', locale: 'it', reason: `(c) "ARRR" — ticker, invariant` },
	{ key: 'chat.address.method_arrr', locale: 'pl', reason: `(c) "ARRR" — ticker, invariant` },
	{ key: 'chat.address.method_arrr', locale: 'ru', reason: `(c) "ARRR" — ticker, invariant` },
	{ key: 'chat.address.method_arrr', locale: 'fa', reason: `(c) "ARRR" — ticker, invariant` },
	{ key: 'chat.address.method_arrr', locale: 'zh-CN', reason: `(c) "ARRR" — ticker, invariant` },
	{ key: 'chat.address.method_arrr', locale: 'zh-HK', reason: `(c) "ARRR" — ticker, invariant` },
	{ key: 'chat.address.method_dai', locale: 'it', reason: `(c) "DAI" — ticker, invariant` },
	{ key: 'chat.address.method_dai', locale: 'pl', reason: `(c) "DAI" — ticker, invariant` },
	{ key: 'chat.address.method_dai', locale: 'ru', reason: `(c) "DAI" — ticker, invariant` },
	{ key: 'chat.address.method_dai', locale: 'fa', reason: `(c) "DAI" — ticker, invariant` },
	{ key: 'chat.address.method_dai', locale: 'zh-CN', reason: `(c) "DAI" — ticker, invariant` },
	{ key: 'chat.address.method_dai', locale: 'zh-HK', reason: `(c) "DAI" — ticker, invariant` },
	{ key: 'chat.address.method_dcr', locale: 'it', reason: `(c) "DCR" — ticker, invariant` },
	{ key: 'chat.address.method_dcr', locale: 'pl', reason: `(c) "DCR" — ticker, invariant` },
	{ key: 'chat.address.method_dcr', locale: 'ru', reason: `(c) "DCR" — ticker, invariant` },
	{ key: 'chat.address.method_dcr', locale: 'fa', reason: `(c) "DCR" — ticker, invariant` },
	{ key: 'chat.address.method_dcr', locale: 'zh-CN', reason: `(c) "DCR" — ticker, invariant` },
	{ key: 'chat.address.method_dcr', locale: 'zh-HK', reason: `(c) "DCR" — ticker, invariant` },
	{ key: 'chat.address.method_eth', locale: 'it', reason: `(c) "ETH" — ticker, invariant` },
	{ key: 'chat.address.method_eth', locale: 'pl', reason: `(c) "ETH" — ticker, invariant` },
	{ key: 'chat.address.method_eth', locale: 'ru', reason: `(c) "ETH" — ticker, invariant` },
	{ key: 'chat.address.method_eth', locale: 'fa', reason: `(c) "ETH" — ticker, invariant` },
	{ key: 'chat.address.method_eth', locale: 'zh-CN', reason: `(c) "ETH" — ticker, invariant` },
	{ key: 'chat.address.method_eth', locale: 'zh-HK', reason: `(c) "ETH" — ticker, invariant` },
	{ key: 'chat.address.method_sol', locale: 'it', reason: `(c) "SOL" — ticker, invariant` },
	{ key: 'chat.address.method_sol', locale: 'pl', reason: `(c) "SOL" — ticker, invariant` },
	{ key: 'chat.address.method_sol', locale: 'ru', reason: `(c) "SOL" — ticker, invariant` },
	{ key: 'chat.address.method_sol', locale: 'fa', reason: `(c) "SOL" — ticker, invariant` },
	{ key: 'chat.address.method_sol', locale: 'zh-CN', reason: `(c) "SOL" — ticker, invariant` },
	{ key: 'chat.address.method_sol', locale: 'zh-HK', reason: `(c) "SOL" — ticker, invariant` },
	{ key: 'chat.address.method_usdc', locale: 'it', reason: `(c) "USDC" — ticker, invariant` },
	{ key: 'chat.address.method_usdc', locale: 'pl', reason: `(c) "USDC" — ticker, invariant` },
	{ key: 'chat.address.method_usdc', locale: 'ru', reason: `(c) "USDC" — ticker, invariant` },
	{ key: 'chat.address.method_usdc', locale: 'fa', reason: `(c) "USDC" — ticker, invariant` },
	{ key: 'chat.address.method_usdc', locale: 'zh-CN', reason: `(c) "USDC" — ticker, invariant` },
	{ key: 'chat.address.method_usdc', locale: 'zh-HK', reason: `(c) "USDC" — ticker, invariant` },
	{ key: 'chat.address.method_xrp', locale: 'it', reason: `(c) "XRP" — ticker, invariant` },
	{ key: 'chat.address.method_xrp', locale: 'pl', reason: `(c) "XRP" — ticker, invariant` },
	{ key: 'chat.address.method_xrp', locale: 'ru', reason: `(c) "XRP" — ticker, invariant` },
	{ key: 'chat.address.method_xrp', locale: 'fa', reason: `(c) "XRP" — ticker, invariant` },
	{ key: 'chat.address.method_xrp', locale: 'zh-CN', reason: `(c) "XRP" — ticker, invariant` },
	{ key: 'chat.address.method_xrp', locale: 'zh-HK', reason: `(c) "XRP" — ticker, invariant` },
	{ key: 'chat.address.pill_method_arrr', locale: 'it', reason: `(c) "Pirate Chain (ARRR)" — brand name` },
	{ key: 'chat.address.pill_method_arrr', locale: 'pl', reason: `(c) "Pirate Chain (ARRR)" — brand name` },
	{ key: 'chat.address.pill_method_arrr', locale: 'ru', reason: `(c) "Pirate Chain (ARRR)" — brand name` },
	{ key: 'chat.address.pill_method_arrr', locale: 'fa', reason: `(c) "Pirate Chain (ARRR)" — brand name` },
	{ key: 'chat.address.pill_method_arrr', locale: 'zh-CN', reason: `(c) "Pirate Chain (ARRR)" — brand name` },
	{ key: 'chat.address.pill_method_arrr', locale: 'zh-HK', reason: `(c) "Pirate Chain (ARRR)" — brand name` },
	{ key: 'chat.address.pill_method_dai', locale: 'it', reason: `(c) "DAI {network}" — brand + placeholder` },
	{ key: 'chat.address.pill_method_dai', locale: 'pl', reason: `(c) "DAI {network}" — brand + placeholder` },
	{ key: 'chat.address.pill_method_dai', locale: 'ru', reason: `(c) "DAI {network}" — brand + placeholder` },
	{ key: 'chat.address.pill_method_dai', locale: 'fa', reason: `(c) "DAI {network}" — brand + placeholder` },
	{ key: 'chat.address.pill_method_dai', locale: 'zh-CN', reason: `(c) "DAI {network}" — brand + placeholder` },
	{ key: 'chat.address.pill_method_dai', locale: 'zh-HK', reason: `(c) "DAI {network}" — brand + placeholder` },
	{ key: 'chat.address.pill_method_dcr', locale: 'it', reason: `(c) "Decred (DCR)" — brand name` },
	{ key: 'chat.address.pill_method_dcr', locale: 'pl', reason: `(c) "Decred (DCR)" — brand name` },
	{ key: 'chat.address.pill_method_dcr', locale: 'ru', reason: `(c) "Decred (DCR)" — brand name` },
	{ key: 'chat.address.pill_method_dcr', locale: 'fa', reason: `(c) "Decred (DCR)" — brand name` },
	{ key: 'chat.address.pill_method_dcr', locale: 'zh-CN', reason: `(c) "Decred (DCR)" — brand name` },
	{ key: 'chat.address.pill_method_dcr', locale: 'zh-HK', reason: `(c) "Decred (DCR)" — brand name` },
	{ key: 'chat.address.pill_method_eth', locale: 'it', reason: `(c) "Ethereum (ETH)" — brand name` },
	{ key: 'chat.address.pill_method_eth', locale: 'pl', reason: `(c) "Ethereum (ETH)" — brand name` },
	{ key: 'chat.address.pill_method_eth', locale: 'ru', reason: `(c) "Ethereum (ETH)" — brand name` },
	{ key: 'chat.address.pill_method_eth', locale: 'fa', reason: `(c) "Ethereum (ETH)" — brand name` },
	{ key: 'chat.address.pill_method_eth', locale: 'zh-CN', reason: `(c) "Ethereum (ETH)" — brand name` },
	{ key: 'chat.address.pill_method_eth', locale: 'zh-HK', reason: `(c) "Ethereum (ETH)" — brand name` },
	{ key: 'chat.address.pill_method_sol', locale: 'it', reason: `(c) "Solana (SOL)" — brand name` },
	{ key: 'chat.address.pill_method_sol', locale: 'pl', reason: `(c) "Solana (SOL)" — brand name` },
	{ key: 'chat.address.pill_method_sol', locale: 'ru', reason: `(c) "Solana (SOL)" — brand name` },
	{ key: 'chat.address.pill_method_sol', locale: 'fa', reason: `(c) "Solana (SOL)" — brand name` },
	{ key: 'chat.address.pill_method_sol', locale: 'zh-CN', reason: `(c) "Solana (SOL)" — brand name` },
	{ key: 'chat.address.pill_method_sol', locale: 'zh-HK', reason: `(c) "Solana (SOL)" — brand name` },
	{ key: 'chat.address.pill_method_xrp', locale: 'it', reason: `(c) "Ripple (XRP)" — brand name` },
	{ key: 'chat.address.pill_method_xrp', locale: 'pl', reason: `(c) "Ripple (XRP)" — brand name` },
	{ key: 'chat.address.pill_method_xrp', locale: 'ru', reason: `(c) "Ripple (XRP)" — brand name` },
	{ key: 'chat.address.pill_method_xrp', locale: 'fa', reason: `(c) "Ripple (XRP)" — brand name` },
	{ key: 'chat.address.pill_method_xrp', locale: 'zh-CN', reason: `(c) "Ripple (XRP)" — brand name` },
	{ key: 'chat.address.pill_method_xrp', locale: 'zh-HK', reason: `(c) "Ripple (XRP)" — brand name` },
	{ key: 'assets.dai.price_subline.live', locale: 'it', reason: `(c) "1 DAI = \${price}" — DAI brand + placeholder` },
	{ key: 'assets.dai.price_subline.live', locale: 'pl', reason: `(c) "1 DAI = \${price}" — DAI brand + placeholder` },
	{ key: 'assets.dai.price_subline.live', locale: 'ru', reason: `(c) "1 DAI = \${price}" — DAI brand + placeholder` },
	{ key: 'assets.dai.price_subline.live', locale: 'fa', reason: `(c) "1 DAI = \${price}" — DAI brand + placeholder` },
	{ key: 'assets.dai.price_subline.live', locale: 'zh-CN', reason: `(c) "1 DAI = \${price}" — DAI brand + placeholder` },
	{ key: 'assets.dai.price_subline.live', locale: 'zh-HK', reason: `(c) "1 DAI = \${price}" — DAI brand + placeholder` },
	{ key: 'privacy.opt_in_tech.cashfusion.name', locale: 'it', reason: `(c) "CashFusion" — protocol name (BCH)` },
	{ key: 'privacy.opt_in_tech.cashfusion.name', locale: 'pl', reason: `(c) "CashFusion" — protocol name (BCH)` },
	{ key: 'privacy.opt_in_tech.cashfusion.name', locale: 'ru', reason: `(c) "CashFusion" — protocol name (BCH)` },
	{ key: 'privacy.opt_in_tech.cashfusion.name', locale: 'fa', reason: `(c) "CashFusion" — protocol name (BCH)` },
	{ key: 'privacy.opt_in_tech.cashfusion.name', locale: 'zh-CN', reason: `(c) "CashFusion" — protocol name (BCH)` },
	{ key: 'privacy.opt_in_tech.cashfusion.name', locale: 'zh-HK', reason: `(c) "CashFusion" — protocol name (BCH)` },
	{ key: 'privacy.opt_in_tech.coinjoin.name', locale: 'it', reason: `(c) "CoinJoin" — protocol name (BTC)` },
	{ key: 'privacy.opt_in_tech.coinjoin.name', locale: 'pl', reason: `(c) "CoinJoin" — protocol name (BTC)` },
	{ key: 'privacy.opt_in_tech.coinjoin.name', locale: 'ru', reason: `(c) "CoinJoin" — protocol name (BTC)` },
	{ key: 'privacy.opt_in_tech.coinjoin.name', locale: 'fa', reason: `(c) "CoinJoin" — protocol name (BTC)` },
	{ key: 'privacy.opt_in_tech.coinjoin.name', locale: 'zh-CN', reason: `(c) "CoinJoin" — protocol name (BTC)` },
	{ key: 'privacy.opt_in_tech.coinjoin.name', locale: 'zh-HK', reason: `(c) "CoinJoin" — protocol name (BTC)` },
	{ key: 'privacy.opt_in_tech.mweb.name', locale: 'it', reason: `(c) "MWEB (MimbleWimble Extension Blocks)" — protocol acronym` },
	{ key: 'privacy.opt_in_tech.mweb.name', locale: 'pl', reason: `(c) "MWEB (MimbleWimble Extension Blocks)" — protocol acronym` },
	{ key: 'privacy.opt_in_tech.mweb.name', locale: 'ru', reason: `(c) "MWEB (MimbleWimble Extension Blocks)" — protocol acronym` },
	{ key: 'privacy.opt_in_tech.mweb.name', locale: 'fa', reason: `(c) "MWEB (MimbleWimble Extension Blocks)" — protocol acronym` },
	{ key: 'privacy.opt_in_tech.mweb.name', locale: 'zh-CN', reason: `(c) "MWEB (MimbleWimble Extension Blocks)" — protocol acronym` },
	{ key: 'privacy.opt_in_tech.mweb.name', locale: 'zh-HK', reason: `(c) "MWEB (MimbleWimble Extension Blocks)" — protocol acronym` },
	{ key: 'privacy.opt_in_tech.payjoin.name', locale: 'it', reason: `(c) "PayJoin (BIP-78)" — protocol name + BIP` },
	{ key: 'privacy.opt_in_tech.payjoin.name', locale: 'pl', reason: `(c) "PayJoin (BIP-78)" — protocol name + BIP` },
	{ key: 'privacy.opt_in_tech.payjoin.name', locale: 'ru', reason: `(c) "PayJoin (BIP-78)" — protocol name + BIP` },
	{ key: 'privacy.opt_in_tech.payjoin.name', locale: 'fa', reason: `(c) "PayJoin (BIP-78)" — protocol name + BIP` },
	{ key: 'privacy.opt_in_tech.payjoin.name', locale: 'zh-CN', reason: `(c) "PayJoin (BIP-78)" — protocol name + BIP` },
	{ key: 'privacy.opt_in_tech.payjoin.name', locale: 'zh-HK', reason: `(c) "PayJoin (BIP-78)" — protocol name + BIP` },
	{ key: 'privacy.opt_in_tech.privatesend.name', locale: 'it', reason: `(c) "PrivateSend" — protocol name (Dash)` },
	{ key: 'privacy.opt_in_tech.privatesend.name', locale: 'pl', reason: `(c) "PrivateSend" — protocol name (Dash)` },
	{ key: 'privacy.opt_in_tech.privatesend.name', locale: 'ru', reason: `(c) "PrivateSend" — protocol name (Dash)` },
	{ key: 'privacy.opt_in_tech.privatesend.name', locale: 'fa', reason: `(c) "PrivateSend" — protocol name (Dash)` },
	{ key: 'privacy.opt_in_tech.privatesend.name', locale: 'zh-CN', reason: `(c) "PrivateSend" — protocol name (Dash)` },
	{ key: 'privacy.opt_in_tech.privatesend.name', locale: 'zh-HK', reason: `(c) "PrivateSend" — protocol name (Dash)` },
	{ key: 'chat.address.method_bch', locale: 'it', reason: `(c) "Bitcoin Cash" — brand name` },
	{ key: 'chat.address.method_bch', locale: 'pl', reason: `(c) "Bitcoin Cash" — brand name` },
	{ key: 'chat.address.method_bch', locale: 'ru', reason: `(c) "Bitcoin Cash" — brand name` },
	{ key: 'chat.address.method_bch', locale: 'fa', reason: `(c) "Bitcoin Cash" — brand name` },
	{ key: 'chat.address.method_bch', locale: 'zh-CN', reason: `(c) "Bitcoin Cash" — brand name` },
	{ key: 'chat.address.method_bch', locale: 'zh-HK', reason: `(c) "Bitcoin Cash" — brand name` },
	{ key: 'chat.address.method_dash', locale: 'it', reason: `(c) "Dash" — brand name` },
	{ key: 'chat.address.method_dash', locale: 'pl', reason: `(c) "Dash" — brand name` },
	{ key: 'chat.address.method_dash', locale: 'ru', reason: `(c) "Dash" — brand name` },
	{ key: 'chat.address.method_dash', locale: 'fa', reason: `(c) "Dash" — brand name` },
	{ key: 'chat.address.method_dash', locale: 'zh-CN', reason: `(c) "Dash" — brand name` },
	{ key: 'chat.address.method_dash', locale: 'zh-HK', reason: `(c) "Dash" — brand name` },
	{ key: 'chat.address.method_doge', locale: 'it', reason: `(c) "Dogecoin" — brand name` },
	{ key: 'chat.address.method_doge', locale: 'pl', reason: `(c) "Dogecoin" — brand name` },
	{ key: 'chat.address.method_doge', locale: 'ru', reason: `(c) "Dogecoin" — brand name` },
	{ key: 'chat.address.method_doge', locale: 'fa', reason: `(c) "Dogecoin" — brand name` },
	{ key: 'chat.address.method_doge', locale: 'zh-CN', reason: `(c) "Dogecoin" — brand name` },
	{ key: 'chat.address.method_doge', locale: 'zh-HK', reason: `(c) "Dogecoin" — brand name` },
	{ key: 'chat.address.method_ltc', locale: 'it', reason: `(c) "Litecoin" — brand name` },
	{ key: 'chat.address.method_ltc', locale: 'pl', reason: `(c) "Litecoin" — brand name` },
	{ key: 'chat.address.method_ltc', locale: 'ru', reason: `(c) "Litecoin" — brand name` },
	{ key: 'chat.address.method_ltc', locale: 'fa', reason: `(c) "Litecoin" — brand name` },
	{ key: 'chat.address.method_ltc', locale: 'zh-CN', reason: `(c) "Litecoin" — brand name` },
	{ key: 'chat.address.method_ltc', locale: 'zh-HK', reason: `(c) "Litecoin" — brand name` },
	{ key: 'chat.address.method_zec', locale: 'it', reason: `(c) "Zcash" — brand name` },
	{ key: 'chat.address.method_zec', locale: 'pl', reason: `(c) "Zcash" — brand name` },
	{ key: 'chat.address.method_zec', locale: 'ru', reason: `(c) "Zcash" — brand name` },
	{ key: 'chat.address.method_zec', locale: 'fa', reason: `(c) "Zcash" — brand name` },
	{ key: 'chat.address.method_zec', locale: 'zh-CN', reason: `(c) "Zcash" — brand name` },
	{ key: 'chat.address.method_zec', locale: 'zh-HK', reason: `(c) "Zcash" — brand name` },
	{ key: 'assets.usdc.price_subline.live', locale: 'it', reason: `(c) "1 USDC = \${price} live" — brand + placeholder; "live" stays English in most locales as a UI status indicator` },
	{ key: 'assets.usdc.price_subline.live', locale: 'pl', reason: `(c) "1 USDC = \${price} live" — brand + placeholder; "live" stays English in most locales as a UI status indicator` },
	{ key: 'assets.usdc.price_subline.live', locale: 'ru', reason: `(c) "1 USDC = \${price} live" — brand + placeholder; "live" stays English in most locales as a UI status indicator` },
	{ key: 'assets.usdc.price_subline.live', locale: 'fa', reason: `(c) "1 USDC = \${price} live" — brand + placeholder; "live" stays English in most locales as a UI status indicator` },
	{ key: 'assets.usdc.price_subline.live', locale: 'zh-CN', reason: `(c) "1 USDC = \${price} live" — brand + placeholder; "live" stays English in most locales as a UI status indicator` },
	{ key: 'assets.usdc.price_subline.live', locale: 'zh-HK', reason: `(c) "1 USDC = \${price} live" — brand + placeholder; "live" stays English in most locales as a UI status indicator` },
	// ─── cp116 setup-wizard same-spelling cases: short labels that
	//     legitimately match English in some locales. ──────────────
	{ key: 'admin.setup_wizard.payment.category_online', locale: 'de', reason: `(b) "Online" is the same word in German UI conventions; identical to EN by accepted usage` },
	{ key: 'admin.setup_wizard.payment.category_crypto', locale: 'fr', reason: `(b) "Crypto" is the same word in French UI conventions; identical to EN by accepted usage` },
	{ key: 'admin.setup_wizard.payment.description_label', locale: 'fr', reason: `(b) "Description" is the same word in French; identical to EN by spelling identity` },
	// ─── ADR-0043 / cp132 2FA: closed-source-authenticator brand
	//     names that do NOT translate.  Google Authenticator,
	//     Microsoft Authenticator, and Authy are product names
	//     trademarked by their respective vendors; their .name
	//     fields render identically in every locale by design.
	//     The .reason field beside each name IS translated. ──
	{ key: 'settings.totp.not_recommended_apps.google_authenticator.name', locale: 'de', reason: '(c) "Google Authenticator" is a registered product name; does not translate' },
	{ key: 'settings.totp.not_recommended_apps.google_authenticator.name', locale: 'es', reason: '(c) "Google Authenticator" is a registered product name; does not translate' },
	{ key: 'settings.totp.not_recommended_apps.google_authenticator.name', locale: 'fr', reason: '(c) "Google Authenticator" is a registered product name; does not translate' },
	{ key: 'settings.totp.not_recommended_apps.microsoft_authenticator.name', locale: 'de', reason: '(c) "Microsoft Authenticator" is a registered product name; does not translate' },
	{ key: 'settings.totp.not_recommended_apps.microsoft_authenticator.name', locale: 'es', reason: '(c) "Microsoft Authenticator" is a registered product name; does not translate' },
	{ key: 'settings.totp.not_recommended_apps.microsoft_authenticator.name', locale: 'fr', reason: '(c) "Microsoft Authenticator" is a registered product name; does not translate' },
	{ key: 'settings.totp.not_recommended_apps.authy.name', locale: 'de', reason: '(c) "Authy" is a registered product name; does not translate' },
	{ key: 'settings.totp.not_recommended_apps.authy.name', locale: 'es', reason: '(c) "Authy" is a registered product name; does not translate' },
	{ key: 'settings.totp.not_recommended_apps.authy.name', locale: 'fr', reason: '(c) "Authy" is a registered product name; does not translate' },
	// cp396 — "Blockchain" is a universally-adopted loanword; the body text in
	// each of these locales uses it verbatim, so the glossary TITLE matches it
	// by design. (it/pl already use "blockchain" elsewhere and pass the
	// heuristic; ru/fa/zh translate it: Блокчейн / بلاکچین / 区块链 / 區塊鏈.)
	{ key: 'glossary.blockchain.title', locale: 'de', reason: '(b) "Blockchain" is a universal tech loanword (Duden-listed); body uses it verbatim' },
	{ key: 'glossary.blockchain.title', locale: 'es', reason: '(b) "Blockchain" is a universal tech loanword; body uses it verbatim' },
	{ key: 'glossary.blockchain.title', locale: 'fr', reason: '(b) "Blockchain" is a universal tech loanword; body uses it verbatim' },
	{ key: 'orderbook.card.message_word', locale: 'fr', reason: '(a) "Message" is the same word in French; translating it would be wrong (cp404)' },
	{ key: 'chat.export.parties_heading', locale: 'fr', reason: '(a) "Parties" is the same word in French — the parties to an agreement (cp404)' },
	// cp424 — "Power up" / "Power down" are Blurt operation terms of art,
	// kept verbatim like BLURT / BP. blurtwallet.com and Morphit's own FAQ
	// (all 10 locales) use them untranslated; the wallet modal's subtitles
	// + schedule notice ARE fully translated around them.
	{ key: 'profile.wallet.power_up_action', locale: 'de', reason: '(b) "Power up" is a Blurt term of art (loanword); FAQ + blurtwallet.com keep it verbatim' },
	{ key: 'profile.wallet.power_up_action', locale: 'es', reason: '(b) "Power up" is a Blurt term of art (loanword); FAQ + blurtwallet.com keep it verbatim' },
	{ key: 'profile.wallet.power_up_action', locale: 'fr', reason: '(b) "Power up" is a Blurt term of art (loanword); FAQ + blurtwallet.com keep it verbatim' },
	{ key: 'profile.wallet.power_down_action', locale: 'de', reason: '(b) "Power down" is a Blurt term of art (loanword); FAQ + blurtwallet.com keep it verbatim' },
	{ key: 'profile.wallet.power_down_action', locale: 'es', reason: '(b) "Power down" is a Blurt term of art (loanword); FAQ + blurtwallet.com keep it verbatim' },
	{ key: 'profile.wallet.power_down_action', locale: 'fr', reason: '(b) "Power down" is a Blurt term of art (loanword); FAQ + blurtwallet.com keep it verbatim' },
	{ key: 'profile.wallet.power_up_title', locale: 'de', reason: '(c) "Power up BLURT" is all Blurt terms (Power up + BLURT); invariant across locales' },
	{ key: 'profile.wallet.power_up_title', locale: 'es', reason: '(c) "Power up BLURT" is all Blurt terms (Power up + BLURT); invariant across locales' },
	{ key: 'profile.wallet.power_up_title', locale: 'fr', reason: '(c) "Power up BLURT" is all Blurt terms (Power up + BLURT); invariant across locales' },
	{ key: 'profile.wallet.power_down_title', locale: 'de', reason: '(c) "Power down BP" is all Blurt terms (Power down + BP); invariant across locales' },
	{ key: 'profile.wallet.power_down_title', locale: 'es', reason: '(c) "Power down BP" is all Blurt terms (Power down + BP); invariant across locales' },
	{ key: 'profile.wallet.power_down_title', locale: 'fr', reason: '(c) "Power down BP" is all Blurt terms (Power down + BP); invariant across locales' },
	// cp466 — the #2 Terms markdown-guide modal (post_order.terms_md_guide.*).
	// German translates most element names (Heading→Überschrift, Bold→Fett,
	// Link's row label stays a table cell) but two are byte-identical to English
	// by correct German usage, not a miss: "Element" is a German cognate, and
	// "Link" is the standard German loanword for a hyperlink (der Link).
	{ key: 'post_order.terms_md_guide.col_element', locale: 'de', reason: '(a) "Element" is a German cognate — spelled identically to English' },
	{ key: 'post_order.terms_md_guide.el_link', locale: 'de', reason: '(b) "Link" is the standard German loanword for a hyperlink (der Link)' },
	// ─── FAQ glossary acronyms (2026-07-19, Ken): the 12 technical
	//     acronyms added as glossary terms have TITLES equal to the
	//     acronym itself (ECIES / X25519 / TLS / …). Acronyms are not
	//     translated, so the title is byte-identical to English in every
	//     locale by design — exactly like the Blurt key-role identifiers
	//     above. The BODIES are fully translated. (c) invariant.
	{ key: 'glossary.aead.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.aead.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.aead.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.dns.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.dns.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.dns.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ecdh.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ecdh.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ecdh.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ecies.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ecies.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ecies.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ens.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ens.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ens.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ipfs.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ipfs.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.ipfs.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.mcp.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.mcp.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.mcp.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.p2p.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.p2p.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.p2p.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.pwa.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.pwa.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.pwa.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.rss.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.rss.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.rss.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.tls.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.tls.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.tls.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.x25519.title', locale: 'de', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.x25519.title', locale: 'es', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	{ key: 'glossary.x25519.title', locale: 'fr', reason: '(c) universal acronym / technical identifier — not translated in any locale' },
	// Website / Streaming profile cards (cp506)
	{ key: 'footer.globe', locale: 'de', reason: '(b) "Website" is a German loanword, spelled identically to English' },
	{ key: 'identity.website_link_tooltip', locale: 'de', reason: '(b) "Website" is a German loanword, spelled identically to English' },
	{ key: 'footer.play', locale: 'de', reason: '(b) "Streaming" is a loanword, spelled identically to English' },
	{ key: 'footer.play', locale: 'es', reason: '(b) "Streaming" is a loanword, spelled identically to English' },
	{ key: 'footer.play', locale: 'fr', reason: '(b) "Streaming" is a loanword, spelled identically to English' },
	{ key: 'settings.website_url.placeholder', locale: 'de', reason: '(c) "https://..." URL placeholder template — invariant across locales' },
	{ key: 'settings.website_url.placeholder', locale: 'es', reason: '(c) "https://..." URL placeholder template — invariant across locales' },
	{ key: 'settings.website_url.placeholder', locale: 'fr', reason: '(c) "https://..." URL placeholder template — invariant across locales' }
];

const allowSet = new Set(ALLOW_LIST.map((e) => `${e.key}::${e.locale}`));

// ─── Find genuine misses ───────────────────────────────────
//
// Definition: a key whose value in some locale L is byte-identical
// to its English value, AND that pairing is NOT in the allow-list.
// We don't filter by translation-coverage threshold — every miss
// must be allow-listed or fixed.

interface Finding { key: string; locale: string; value: string }
const findings: Finding[] = [];

// Memory #29 policy on locale-translation requirements:
//   - en/es/fr/de: MUST be natively translated for new keys
//     (the "native-translation locales").
//   - fa/it/pl/ru/zh-CN/zh-HK: EN-fallback acceptable as
//     community-translation backlog (the "policy-fallback
//     locales").  Each EN-identical string in these locales is
//     the documented Memory #29 backlog state, NOT a translation
//     miss.  This smoke skips the byte-identical check for them.
//
// The native-translations-floor-smoke (LL #47) covers the
// orthogonal regression case — "going down" from a previously-
// native string back to EN-fallback — for ALL 9 non-EN locales.
// This smoke handles the "must be native per policy" forward
// gate for es/fr/de only.
const POLICY_FALLBACK_LOCALES = new Set(['fa', 'it', 'pl', 'ru', 'zh-CN', 'zh-HK']);

for (const [k, enV] of en) {
	if (!enV || enV.trim() === '') continue;
	// Skip strings that are pure format/identifiers (no alpha chars).
	if (![...enV].some((c) => /[a-zA-Z]/.test(c))) continue;
	for (const l of nonEn) {
		if (POLICY_FALLBACK_LOCALES.has(l)) continue; // Memory #29 backlog (reduced to ~49 long-form keys at cp68)
		const lV = data.get(l)!.get(k);
		if (lV === undefined) continue; // structural drift caught by parity smoke
		if (lV !== enV) continue; // translated, fine
		if (allowSet.has(`${k}::${l}`)) continue;
		findings.push({ key: k, locale: l, value: enV });
	}
}

// ─── Reporting ─────────────────────────────────────────────

console.log('');
console.log('── i18n translation completeness smoke ─────────────────');
console.log('');

// ─── v1.7.7: WRONG-SCRIPT LEAK ──────────────────────────────────────
// A single Chinese character sat in the middle of a Russian sentence
// ("но他 делает") and 3,368 i18n checks passed. Key coverage was fine, parity
// was fine, dead keys were fine — every existing guard asks "is the key there?"
// and none asks "is the text in the right alphabet?".
//
// This is a translation-time hazard, not a typo: when ten locales are written in
// one pass, characters bleed between them. It is also nearly invisible on
// review, because catching it means reading a language you may not speak and
// noticing one glyph. A machine notices instantly.
//
// Deliberately narrow — it only flags a locale carrying a script that has no
// business in it at all. It says nothing about Latin text inside a non-Latin
// locale, because brand names, protocol terms and placeholders legitimately stay
// Latin everywhere (there is already a reasoned allow-list above for exactly
// that). Han characters in Cyrillic prose, or Cyrillic in Persian, are never
// deliberate.
const HAN = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const CYRILLIC = /[\u0400-\u04ff]/;
const ARABIC = /[\u0600-\u06ff]/;
const HANGUL = /[\uac00-\ud7af]/;
const KANA = /[\u3040-\u30ff]/;

/** Scripts that must NEVER appear in a given locale's strings. */
const FORBIDDEN_SCRIPTS: Record<string, Array<{ name: string; re: RegExp }>> = {
	en: [{ name: 'Han', re: HAN }, { name: 'Cyrillic', re: CYRILLIC }, { name: 'Arabic', re: ARABIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }],
	es: [{ name: 'Han', re: HAN }, { name: 'Cyrillic', re: CYRILLIC }, { name: 'Arabic', re: ARABIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }],
	fr: [{ name: 'Han', re: HAN }, { name: 'Cyrillic', re: CYRILLIC }, { name: 'Arabic', re: ARABIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }],
	de: [{ name: 'Han', re: HAN }, { name: 'Cyrillic', re: CYRILLIC }, { name: 'Arabic', re: ARABIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }],
	it: [{ name: 'Han', re: HAN }, { name: 'Cyrillic', re: CYRILLIC }, { name: 'Arabic', re: ARABIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }],
	pl: [{ name: 'Han', re: HAN }, { name: 'Cyrillic', re: CYRILLIC }, { name: 'Arabic', re: ARABIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }],
	// Russian legitimately carries Latin brand names; Han/Arabic/Hangul/Kana never.
	ru: [{ name: 'Han', re: HAN }, { name: 'Arabic', re: ARABIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }],
	// Persian legitimately carries Latin brand names and Arabic script IS its script.
	fa: [{ name: 'Han', re: HAN }, { name: 'Cyrillic', re: CYRILLIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }],
	// Chinese legitimately carries Latin brand names; Cyrillic/Arabic/Hangul never.
	// Kana is excluded: it is NOT Chinese, and a stray one means text bled in.
	'zh-CN': [{ name: 'Cyrillic', re: CYRILLIC }, { name: 'Arabic', re: ARABIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }],
	'zh-HK': [{ name: 'Cyrillic', re: CYRILLIC }, { name: 'Arabic', re: ARABIC }, { name: 'Hangul', re: HANGUL }, { name: 'Kana', re: KANA }]
};

const scriptLeaks: string[] = [];
for (const loc of locales) {
	const forbidden = FORBIDDEN_SCRIPTS[loc];
	if (forbidden === undefined) continue;
	const strings = data.get(loc);
	if (strings === undefined) continue;
	for (const [key, value] of strings) {
		for (const { name, re } of forbidden) {
			const m = re.exec(value);
			if (m !== null) {
				scriptLeaks.push(`${loc}: ${name} character ${JSON.stringify(m[0])} in ${key}`);
			}
		}
	}
}

const scenarios = [
	{
		name: `no wrong-script leaks across all ${SUPPORTED_LOCALES.length} locales`,
		ok: scriptLeaks.length === 0,
		detail: scriptLeaks.slice(0, 5).join('; ')
	},
	{
		name: `all ${SUPPORTED_LOCALES.length} locale files were loaded successfully`,
		ok: locales.length === SUPPORTED_LOCALES.length
	},
	{
		name: 'EN source-of-truth has at least 2,000 string keys',
		ok: en.size >= 2000
	},
	{
		name: 'allow-list has documented justifications for every entry',
		ok: ALLOW_LIST.every((e) => e.reason && e.reason.trim().length > 5)
	},
	{
		name: 'no string is byte-identical to English in a locale outside the allow-list',
		ok: findings.length === 0
	}
];

if (findings.length > 0) {
	console.log(`  ${findings.length} unexpected EN-byte-identical entries:`);
	const byKey = new Map<string, string[]>();
	for (const f of findings) {
		if (!byKey.has(f.key)) byKey.set(f.key, []);
		byKey.get(f.key)!.push(f.locale);
	}
	for (const [k, ls] of [...byKey.entries()].sort()) {
		const enV = en.get(k)!;
		const preview = enV.length > 50 ? enV.slice(0, 47) + '…' : enV;
		console.log(`    ${k}: ${JSON.stringify(preview)} [${ls.sort().join(', ')}]`);
	}
	console.log('');
	console.log('  Each finding is either (a) a real translation miss — fix the locale,');
	console.log('  or (b) a legitimate same-spelling/loanword/invariant — add to the');
	console.log('  ALLOW_LIST in this smoke with a documented (a/b/c) reason.');
	console.log('');
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const s of scenarios) {
	if (s.ok) passed++;
	else {
		failed++;
		failures.push(`  ✗ ${s.name}`);
	}
}
if (failures.length > 0) {
	console.log(failures.join('\n'));
	console.log('');
}

console.log('────────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
