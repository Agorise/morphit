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
	{ key: 'footer.i2p_b32', locale: 'es', reason: '(c) "I2P (.b32.i2p)" technical protocol' },
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
	// App-store brand names (all locales):
	{ key: 'app_stores.alternativeto.name', locale: 'es', reason: '(c) brand' },
	{ key: 'app_stores.alternativeto.name', locale: 'fr', reason: '(c) brand' },
	{ key: 'app_stores.alternativeto.name', locale: 'de', reason: '(c) brand' },
	{ key: 'app_stores.alternativeto.name', locale: 'it', reason: '(c) brand' },
	{ key: 'app_stores.alternativeto.name', locale: 'pl', reason: '(c) brand' },
	{ key: 'app_stores.alternativeto.name', locale: 'ru', reason: '(c) brand' },
	{ key: 'app_stores.alternativeto.name', locale: 'fa', reason: '(c) brand' },
	{ key: 'app_stores.alternativeto.name', locale: 'zh-CN', reason: '(c) brand' },
	{ key: 'app_stores.alternativeto.name', locale: 'zh-HK', reason: '(c) brand' },
	{ key: 'app_stores.apkmirror.name', locale: 'es', reason: '(c) brand' },
	{ key: 'app_stores.apkmirror.name', locale: 'fr', reason: '(c) brand' },
	{ key: 'app_stores.apkmirror.name', locale: 'de', reason: '(c) brand' },
	{ key: 'app_stores.apkmirror.name', locale: 'it', reason: '(c) brand' },
	{ key: 'app_stores.apkmirror.name', locale: 'pl', reason: '(c) brand' },
	{ key: 'app_stores.apkmirror.name', locale: 'ru', reason: '(c) brand' },
	{ key: 'app_stores.apkmirror.name', locale: 'fa', reason: '(c) brand' },
	{ key: 'app_stores.apkmirror.name', locale: 'zh-CN', reason: '(c) brand' },
	{ key: 'app_stores.apkmirror.name', locale: 'zh-HK', reason: '(c) brand' },
	{ key: 'app_stores.apkpure.name', locale: 'es', reason: '(c) brand' },
	{ key: 'app_stores.apkpure.name', locale: 'fr', reason: '(c) brand' },
	{ key: 'app_stores.apkpure.name', locale: 'de', reason: '(c) brand' },
	{ key: 'app_stores.apkpure.name', locale: 'it', reason: '(c) brand' },
	{ key: 'app_stores.apkpure.name', locale: 'pl', reason: '(c) brand' },
	{ key: 'app_stores.apkpure.name', locale: 'ru', reason: '(c) brand' },
	{ key: 'app_stores.apkpure.name', locale: 'fa', reason: '(c) brand' },
	{ key: 'app_stores.apkpure.name', locale: 'zh-CN', reason: '(c) brand' },
	{ key: 'app_stores.apkpure.name', locale: 'zh-HK', reason: '(c) brand' },
	{ key: 'app_stores.aptoide.name', locale: 'es', reason: '(c) brand' },
	{ key: 'app_stores.aptoide.name', locale: 'fr', reason: '(c) brand' },
	{ key: 'app_stores.aptoide.name', locale: 'de', reason: '(c) brand' },
	{ key: 'app_stores.aptoide.name', locale: 'it', reason: '(c) brand' },
	{ key: 'app_stores.aptoide.name', locale: 'pl', reason: '(c) brand' },
	{ key: 'app_stores.aptoide.name', locale: 'ru', reason: '(c) brand' },
	{ key: 'app_stores.aptoide.name', locale: 'fa', reason: '(c) brand' },
	{ key: 'app_stores.aptoide.name', locale: 'zh-CN', reason: '(c) brand' },
	{ key: 'app_stores.aptoide.name', locale: 'zh-HK', reason: '(c) brand' },
	{ key: 'app_stores.aptoide_connect.name', locale: 'es', reason: '(c) brand' },
	{ key: 'app_stores.aptoide_connect.name', locale: 'fr', reason: '(c) brand' },
	{ key: 'app_stores.aptoide_connect.name', locale: 'de', reason: '(c) brand' },
	{ key: 'app_stores.aptoide_connect.name', locale: 'it', reason: '(c) brand' },
	{ key: 'app_stores.aptoide_connect.name', locale: 'pl', reason: '(c) brand' },
	{ key: 'app_stores.aptoide_connect.name', locale: 'ru', reason: '(c) brand' },
	{ key: 'app_stores.aptoide_connect.name', locale: 'fa', reason: '(c) brand' },
	{ key: 'app_stores.aptoide_connect.name', locale: 'zh-CN', reason: '(c) brand' },
	{ key: 'app_stores.aptoide_connect.name', locale: 'zh-HK', reason: '(c) brand' },
	{ key: 'app_stores.fdroid.name', locale: 'es', reason: '(c) brand' },
	{ key: 'app_stores.fdroid.name', locale: 'fr', reason: '(c) brand' },
	{ key: 'app_stores.fdroid.name', locale: 'de', reason: '(c) brand' },
	{ key: 'app_stores.fdroid.name', locale: 'it', reason: '(c) brand' },
	{ key: 'app_stores.fdroid.name', locale: 'pl', reason: '(c) brand' },
	{ key: 'app_stores.fdroid.name', locale: 'ru', reason: '(c) brand' },
	{ key: 'app_stores.fdroid.name', locale: 'fa', reason: '(c) brand' },
	{ key: 'app_stores.fdroid.name', locale: 'zh-CN', reason: '(c) brand' },
	{ key: 'app_stores.fdroid.name', locale: 'zh-HK', reason: '(c) brand' },
	{ key: 'app_stores.obtainium.name', locale: 'es', reason: '(c) brand' },
	{ key: 'app_stores.obtainium.name', locale: 'fr', reason: '(c) brand' },
	{ key: 'app_stores.obtainium.name', locale: 'de', reason: '(c) brand' },
	{ key: 'app_stores.obtainium.name', locale: 'it', reason: '(c) brand' },
	{ key: 'app_stores.obtainium.name', locale: 'pl', reason: '(c) brand' },
	{ key: 'app_stores.obtainium.name', locale: 'ru', reason: '(c) brand' },
	{ key: 'app_stores.obtainium.name', locale: 'fa', reason: '(c) brand' },
	{ key: 'app_stores.obtainium.name', locale: 'zh-CN', reason: '(c) brand' },
	{ key: 'app_stores.obtainium.name', locale: 'zh-HK', reason: '(c) brand' },
	{ key: 'app_stores.uptodown.name', locale: 'es', reason: '(c) brand' },
	{ key: 'app_stores.uptodown.name', locale: 'fr', reason: '(c) brand' },
	{ key: 'app_stores.uptodown.name', locale: 'de', reason: '(c) brand' },
	{ key: 'app_stores.uptodown.name', locale: 'it', reason: '(c) brand' },
	{ key: 'app_stores.uptodown.name', locale: 'pl', reason: '(c) brand' },
	{ key: 'app_stores.uptodown.name', locale: 'ru', reason: '(c) brand' },
	{ key: 'app_stores.uptodown.name', locale: 'fa', reason: '(c) brand' },
	{ key: 'app_stores.uptodown.name', locale: 'zh-CN', reason: '(c) brand' },
	{ key: 'app_stores.uptodown.name', locale: 'zh-HK', reason: '(c) brand' },
	// post_order placeholder
	{ key: 'post_order.form.price_model_fiat_placeholder', locale: 'es', reason: '(b) "fiat" loanword' },
	{ key: 'post_order.form.price_model_fiat_placeholder', locale: 'fr', reason: '(b) "fiat" loanword' },
	{ key: 'post_order.form.price_model_fiat_placeholder', locale: 'it', reason: '(b) "fiat" loanword' },
	{ key: 'post_order.form.price_model_fiat_placeholder', locale: 'pl', reason: '(b) "fiat" loanword' },
	// Brand-prefix labels
	{ key: 'settings.blurt_media_url.label', locale: 'fr', reason: '(c) brand+protocol' },
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
	{ key: 'profile.my_balance.bp_label', locale: 'es', reason: '(c) chain asset symbol (BP)' },
	{ key: 'profile.my_balance.bp_label', locale: 'fr', reason: '(c) chain asset symbol (BP)' },
	{ key: 'profile.my_balance.bp_label', locale: 'de', reason: '(c) chain asset symbol (BP)' },
	{ key: 'profile.my_balance.bp_label', locale: 'it', reason: '(c) chain asset symbol (BP)' },
	{ key: 'profile.my_balance.bp_label', locale: 'pl', reason: '(c) chain asset symbol (BP)' },
	{ key: 'profile.my_balance.bp_label', locale: 'ru', reason: '(c) chain asset symbol (BP)' },
	{ key: 'profile.my_balance.bp_label', locale: 'fa', reason: '(c) chain asset symbol (BP)' },
	{ key: 'profile.my_balance.bp_label', locale: 'zh-CN', reason: '(c) chain asset symbol (BP)' },
	{ key: 'profile.my_balance.bp_label', locale: 'zh-HK', reason: '(c) chain asset symbol (BP)' },
	{ key: 'profile.my_balance.mana_label', locale: 'es', reason: '(c) chain asset symbol (MANA)' },
	{ key: 'profile.my_balance.mana_label', locale: 'fr', reason: '(c) chain asset symbol (MANA)' },
	{ key: 'profile.my_balance.mana_label', locale: 'de', reason: '(c) chain asset symbol (MANA)' },
	{ key: 'profile.my_balance.mana_label', locale: 'it', reason: '(c) chain asset symbol (MANA)' },
	{ key: 'profile.my_balance.mana_label', locale: 'pl', reason: '(c) chain asset symbol (MANA)' },
	{ key: 'profile.my_balance.mana_label', locale: 'ru', reason: '(c) chain asset symbol (MANA)' },
	{ key: 'profile.my_balance.mana_label', locale: 'fa', reason: '(c) chain asset symbol (MANA)' },
	{ key: 'profile.my_balance.mana_label', locale: 'zh-CN', reason: '(c) chain asset symbol (MANA)' },
	{ key: 'profile.my_balance.mana_label', locale: 'zh-HK', reason: '(c) chain asset symbol (MANA)' },

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

for (const [k, enV] of en) {
	if (!enV || enV.trim() === '') continue;
	// Skip strings that are pure format/identifiers (no alpha chars).
	if (![...enV].some((c) => /[a-zA-Z]/.test(c))) continue;
	for (const l of nonEn) {
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

const scenarios = [
	{
		name: 'all 10 locale files were loaded successfully',
		ok: locales.length >= 10
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
