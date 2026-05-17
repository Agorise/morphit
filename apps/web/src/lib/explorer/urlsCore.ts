/**
 * Morphit — external chain-explorer URL builders (pure helpers).
 *
 * Pure-function half of the explorer URL builders.  Lives in a
 * separate file from `urls.ts` so node-side smokes and tests
 * can import these helpers without pulling in Svelte stores
 * (which require the SvelteKit `$lib` alias resolver).
 *
 * `urls.ts` is the thin wrapper that consults the
 * `instance.chat_link_urls` operator overrides; this module
 * holds the txid regexes, the bundled defaults, the
 * substitution helper, and the validator for chat-link URL
 * templates.  Both files re-export the bundled-default
 * constants so callers can reference them by either path.
 */

/** BTC txid: 64 hex chars (32 bytes).  Case-insensitive. */
export const BTC_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** XMR txid: 64 hex chars (32 bytes).  Case-insensitive. */
export const XMR_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** BCH txid (Part 122 cp21).  64 hex chars (sha256d of the
 *  transaction, same format as BTC since BCH forked from BTC).
 *  Case-insensitive at the regex layer; chat-link substitution
 *  normalizes to lowercase before URL construction. */
export const BCH_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** LTC txid (Part 122 cp24).  64 hex chars (sha256d, same as
 *  BTC and BCH since all three share Bitcoin's hash structure).
 *  Case-insensitive at regex layer; substitution normalizes. */
export const LTC_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** Blurt trx_id: 40 hex chars (20 bytes). */
export const BLURT_TRXID_RE = /^[0-9a-fA-F]{40}$/;

/** Account-name format used elsewhere in the codebase. */
export const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

/** Bundled defaults used when an operator hasn't overridden
 *  the per-instance template (via
 *  `MORPHIT_FRONTEND_{BTC,XMR,BCH,LTC}_CHAT_LINK_URL`), or when
 *  the store hasn't loaded yet (SSR / pre-hydration / fetch fail).
 *  Per the original Batch K choices:
 *   - mempool.space: no JS, no tracking, fast, popular
 *   - xmrchain.net: reference for Monero block explorers
 *   - blockchair.com/bitcoin-cash: established multi-chain
 *     explorer, predictable URL format, good uptime (Part 122
 *     cp21 BCH addition; chosen from operator's eight-explorer
 *     candidate list as the best balance of reliability +
 *     URL-format predictability — operators wanting different
 *     defaults override via MORPHIT_FRONTEND_BCH_CHAT_LINK_URL)
 *   - litecoinspace.org/tx/{txid}: community-led Litecoin
 *     explorer modeled on mempool.space (no JS tracking, open
 *     source, privacy-aligned with Morphit's priority #1).
 *     Chosen from operator's seven-explorer candidate list as
 *     the BTC-mempool-equivalent for LTC.  Operators wanting
 *     different defaults override via
 *     MORPHIT_FRONTEND_LTC_CHAT_LINK_URL.
 *
 *  Operators wanting different defaults override per-instance;
 *  these bundled values are the "do nothing, ship sensible"
 *  fallback. */
export const BUNDLED_BTC_CHAT_LINK_URL = 'https://mempool.space/tx/{txid}';
export const BUNDLED_XMR_CHAT_LINK_URL = 'https://xmrchain.net/tx/{txid}';
export const BUNDLED_BCH_CHAT_LINK_URL =
	'https://blockchair.com/bitcoin-cash/transaction/{txid}';
export const BUNDLED_LTC_CHAT_LINK_URL = 'https://litecoinspace.org/tx/{txid}';

/** Substitute `{txid}` into a template.  Defensive: if the
 *  template doesn't contain `{txid}` (e.g. an operator who
 *  somehow bypassed the validator on the way in), append
 *  `/tx/<txid>` to the origin so at least SOMETHING resolves.
 *  Returns null if the template can't be parsed at all. */
export function substituteTxidIntoTemplate(
	template: string,
	txid: string
): string | null {
	if (template.includes('{txid}')) {
		return template.replace(/\{txid\}/g, txid);
	}
	try {
		const parsed = new URL(template);
		return `${parsed.protocol}//${parsed.host}/tx/${txid}`;
	} catch {
		return null;
	}
}

/** Validate a chat-link URL template.  Same contract as the
 *  ops-cli wizard's parseChatLinkTemplate and the indexer
 *  config's isValidChatLinkTemplate.  Returns true on success,
 *  false on any failure mode.  Used by the frontend store to
 *  defensively reject malformed operator overrides at hydration
 *  (defense-in-depth: the indexer's zod schema is supposed to
 *  catch these, but a hostile or buggy indexer might still
 *  serve garbage). */
export function isValidChatLinkTemplate(s: string): boolean {
	if (typeof s !== 'string') return false;
	if (!s.startsWith('https://')) return false;
	if (!s.includes('{txid}')) return false;
	const sampleTxid =
		'0000000000000000000000000000000000000000000000000000000000000000';
	const filled = s.replace(/\{txid\}/g, sampleTxid);
	try {
		const parsed = new URL(filled);
		if (parsed.protocol !== 'https:') return false;
		if (parsed.username !== '' || parsed.password !== '') return false;
		return true;
	} catch {
		return false;
	}
}
