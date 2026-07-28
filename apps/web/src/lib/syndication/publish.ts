/**
 * Syndication publishers — Post A (first-trade) and Post B (per-order).
 *
 * Replaces the old deferred-syndication-queue model. Both posts are
 * fired in the same client turn as the action that triggers them
 * (Post A after feedback broadcast, Post B after order broadcast).
 * No indexer state, no pending banner, no scanner.
 *
 * ─── Post A: first-trade announcement ──────────────────────────────
 *
 * Fires once, when the user broadcasts feedback for their first
 * trade (which is forced to be a BLURT BUY per the waiver branch),
 * IF the user opted in to the first-trade announcement. Posted to
 * the @morphit community (parent_permlink = "blurt-176570").
 *
 * Opt-in, default OFF (see utils/syndicationPrefs.ts). The user can
 * arm it on the order form, in Settings, or at feedback time — the
 * caller checks isFirstTradeAnnounceEnabled() before firing. We
 * never post to a community on someone's behalf unless they ask.
 * Idempotent via deterministic permlink: a retry won't double-post.
 *
 * Failure mode: silent. The user just gave feedback; the welcome
 * bonus is on its way; nothing critical depends on this post landing.
 * If it fails (network, RC depleted, etc.) we log and move on. The
 * function returns a Result for callers that want to surface
 * success state, but the typical caller fires-and-forgets.
 *
 * ─── Post B: per-order announcement ────────────────────────────────
 *
 * Fires immediately after the user broadcasts an order, IFF they
 * ticked the "Syndicate this order to my Blog too" checkbox on
 * the /post form. Posted to the user's own blog
 * (parent_permlink = "morphit", which becomes the post's category).
 *
 * Idempotent via deterministic permlink derived from the order
 * permlink. A retry behaves as an edit, not a new post.
 *
 * Failure mode: explicit Result returned to the caller, which
 * surfaces it on the order-success screen. The order itself is
 * already on-chain — failing to syndicate is a soft error.
 */

import { orderTitleParts } from '$lib/utils/orderTitle';
import { formatDayMonth } from '$lib/i18n/formatters';
import { get } from 'svelte/store';
import { _, locale } from 'svelte-i18n';

import type { LiveIdentity } from '$crypto/keygen';
import type { AssetTicker } from '@morphit/asset-registry';
import { broadcastComment, type CommentPayload } from '$blurt/ops/comment';
import { getUserBlurtAccount } from '$blurt/ops/profile';
import { DEFAULT_LOCALE } from '$i18n/locales';

/** The @morphit community account on Blurt. Posts here get
 *  surfaced to @morphit subscribers and indexed under the
 *  community feed at https://blurt.blog/created/blurt-176570 . */
const MORPHIT_COMMUNITY = 'blurt-176570';

/** Primary tag for personal-blog Morphit posts. Becomes
 *  parent_permlink for Post B and is the discoverable category
 *  on Blurt. Aligns with the project tag. */
const MORPHIT_TAG = 'morphit';

/** Image URLs (operator-supplied, pre-uploaded to Blurt's image
 *  host). Hardcoded here because the syndication flow shouldn't
 *  do per-post uploads — the same image is used for every Morphit
 *  user's announcement. If we later want operator-customizable
 *  images we'd thread these through config. */
const IMAGE_FIRST_TRADE =
	'https://img.blurt.blog/blurtimage/morphit/e3d56ddc849685c391dcdb03526463b8264f3e09.png';
// v1.9.0 (Ken) — the per-order announcement now leads with Morphit's own
// og-image (served from the site), matching the order detail page's header, and
// is reused as the post's social-card thumbnail.
const IMAGE_ORDER_POST = 'https://morphit.io/og-image.png';

// ─── Result types ──────────────────────────────────────────────────

export type PublishResult =
	| { readonly ok: true; readonly trxId: string; readonly permlink: string }
	| { readonly ok: false; readonly error: string };

// ─── Permlink derivation ───────────────────────────────────────────

/** Permlink for Post A. Account-keyed (not trx-keyed) so the
 *  "once per account" contract is enforced structurally: if this
 *  function is called more than once for the same account, the
 *  second broadcast hits Blurt's duplicate-permlink-is-edit path
 *  and no new post appears — the original stays, silently updated.
 *  Callers can still use a local flag to avoid the redundant
 *  broadcast, but correctness doesn't depend on that flag. */
function firstTradePermlink(account: string): string {
	return `morphit-first-trade-${account}`;
}

/** Permlink for Post B. Derived from the order's permlink so
 *  retries are safe — duplicate broadcast = edit. */
function orderPostPermlink(orderPermlink: string): string {
	return `morphit-announce-${orderPermlink}`;
}

// ─── Post A: first-trade announcement ──────────────────────────────

export interface FirstTradeContext {
	/** Counterparty's Blurt account name. In Phase 4's
	 *  welfare-bonus path (the only path that fires Post A
	 *  today), the new user is always the BUYER and `seller`
	 *  is the counterparty's account. The i18n template
	 *  ("first trade with @{seller}") relies on this upstream
	 *  invariant — if a future change ever fires Post A from
	 *  a sell-side trade, the template needs revisiting. */
	readonly seller: string;
}

/** Fire Post A. Silent failure on errors — caller may inspect
 *  the Result if they want, but typically fires-and-forgets. */
export async function publishFirstTradePost(
	live: LiveIdentity,
	ctx: FirstTradeContext
): Promise<PublishResult> {
	const account = getUserBlurtAccount();
	if (!account) {
		return { ok: false, error: 'no_account' };
	}

	const t = get(_);
	const title = t('syndicate.first_trade.title', {
		values: { seller: ctx.seller }
	}) as string;
	const lang = (get(locale) ?? DEFAULT_LOCALE) as string;
	const body = t('syndicate.first_trade.body', {
		values: { username: account, lang }
	}) as string;

	const permlink = firstTradePermlink(account);

	const payload: CommentPayload = {
		primaryTag: MORPHIT_COMMUNITY,
		tags: [MORPHIT_TAG, 'first-trade', 'p2p-trading'],
		permlink,
		title,
		body,
		extraMetadata: {
			image: [IMAGE_FIRST_TRADE]
		}
	};

	try {
		const result = await broadcastComment(live, payload);
		return { ok: true, trxId: result.trx_id, permlink };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

// ─── Post B: per-order announcement ────────────────────────────────

export interface OrderPostContext {
	/** The order's permlink (used for retry-safe deterministic
	 *  permlink derivation AND to build the order URL). */
	readonly orderPermlink: string;
	/** Buy or sell. */
	readonly side: 'buy' | 'sell';
	/** The asset the user is buying or selling (e.g. BTC). */
	readonly asset: AssetTicker;
	/** The "other side" of the trade — for fiat orders this is
	 *  the fiat code (USD, EUR, MXN…); for crypto-for-crypto it
	 *  would be the other crypto ticker. From the order's
	 *  fiat_currency field. */
	readonly counterAsset: string;
	/** The order's amount bounds, as entered (null/undefined when left blank).
	 *  Present so the blog post can render the SAME subject as the order card
	 *  instead of its own vaguer sentence. */
	readonly amountMin?: number | null;
	readonly amountMax?: number | null;
	/** v1.9.0 — the fields the redesigned post body mirrors from the order detail
	 *  page. Resolved payment-method display names (e.g. "Monero (XMR)"), the
	 *  order's created/expiry timestamps (ISO), the optional location/region, and
	 *  the terms text. All caller-redacted where user-supplied. */
	readonly paymentMethodNames?: readonly string[];
	readonly createdAtIso?: string;
	readonly expiresAtIso?: string | null;
	readonly locationRegion?: string | null;
	readonly terms?: string;
	/** v1.9.0 (Ken) — the BARTER inline goods label; when set, the headline reads
	 *  "…of bananas" instead of the generic "goods/services". Ignored for crypto. */
	readonly specificBarterTitle?: string | null;
	/** t.txt #5 — the BARTER accepted crypto ticker(s), so a value-free barter
	 *  headline reads "I want to sell {goods} for {cryptos}" (the same title the
	 *  order card and create-flow summary render). Ignored for crypto/valued barter. */
	readonly acceptedAssets?: readonly string[] | null;
}

/** Fire Post B. Returns an explicit Result so the order-success
 *  UI can render success/failure inline. */
export async function publishOrderPost(
	live: LiveIdentity,
	ctx: OrderPostContext
): Promise<PublishResult> {
	const account = getUserBlurtAccount();
	if (!account) {
		return { ok: false, error: 'no_account' };
	}

	const t = get(_);
	const titleKey =
		ctx.side === 'buy' ? 'syndicate.order_post.title_buy' : 'syndicate.order_post.title_sell';
	// v1.8.9 — derive the headline from the SAME builder the order card uses, so
	// the two can never drift. The blog used to say "I'm buying BLURT with MXN"
	// while the card said "I'm buying BLURT": two sentences for one order, each
	// missing something the other had.
	const subject = (() => {
		const parts = orderTitleParts(
			{
				side: ctx.side,
				asset: ctx.asset,
				fiat_currency: ctx.counterAsset,
				amount_min: ctx.amountMin ?? null,
				amount_max: ctx.amountMax ?? null,
				accepted_assets: ctx.acceptedAssets ?? null,
				// v1.9.5 (Ken) — crypto settlement for the headline. `paymentMethodNames`
				// are ALREADY resolved display labels, so the methodDisplay below is the
				// identity. Ignored for barter (which settles in accepted_assets).
				payment_methods: ctx.paymentMethodNames ?? null
			},
			(n) => String(n),
			ctx.specificBarterTitle || (t('order_title.goods_services') as string),
			{ methodDisplay: (m) => m, locale: (get(locale) ?? DEFAULT_LOCALE) as string }
		);
		return t(parts.key, { values: parts.values }) as string;
	})();
	const title = t(titleKey, {
		values: {
			subject,
			asset1: ctx.asset,
			asset2: ctx.counterAsset
		}
	}) as string;
	const lang = (get(locale) ?? DEFAULT_LOCALE) as string;

	// v1.9.0 (Ken) — the announcement body now MIRRORS the order detail page:
	// og-image header, an H1 headline (the same "…Want to trade?" title), a
	// DETAILS block of bullets (pay/accept + methods, posted/expires dates,
	// optional location, listing fee), the full order Terms rendered WITH the
	// user's markdown (Blurt renders it), a bold tagline, and the shareable link.
	// Built programmatically (not one flat i18n template) because the bullet set
	// is conditional (location is omitted when blank) and the terms carry markdown.
	// Field labels are reused from order_detail.* so the two surfaces can't drift;
	// the ": " separator + heading colons are added here so those labels stay
	// colon-free for their own dt/dd use on the detail page.
	const colon = (labelKey: string): string => `${t(labelKey) as string}: `;
	const payAcceptLabel =
		ctx.side === 'buy'
			? (t('order_detail.i_can_pay_with') as string)
			: (t('syndicate.order_post.i_will_accept') as string);
	const methods = (ctx.paymentMethodNames ?? []).join(', ');

	const bullets: string[] = [];
	if (methods.length > 0) bullets.push(`- ${payAcceptLabel}: ${methods}`);
	if (ctx.createdAtIso) bullets.push(`- ${colon('order_detail.posted_on')}${formatDayMonth(ctx.createdAtIso)}`);
	if (ctx.expiresAtIso)
		bullets.push(`- ${colon('order_detail.expires_on')}${formatDayMonth(ctx.expiresAtIso)}`);
	if (ctx.locationRegion && ctx.locationRegion.trim().length > 0)
		bullets.push(`- ${colon('order_detail.location')}${ctx.locationRegion.trim()}`);
	bullets.push(
		`- ${colon('order_detail.listing_fee')}✓ ${t('order_detail.fee_verified') as string}`
	);

	const orderUrl = `https://morphit.io/${lang}/@${account}/${ctx.orderPermlink}`;
	const termsText = (ctx.terms ?? '').trim();

	const sections: string[] = [
		`![Morphit](${IMAGE_ORDER_POST})`,
		`# ${title}`,
		`## ${t('syndicate.order_post.details') as string}`,
		bullets.join('\n')
	];
	if (termsText.length > 0) {
		sections.push(`## ${t('syndicate.order_post.terms_heading') as string}:`);
		sections.push(termsText);
	}
	sections.push(`**${t('syndicate.order_post.tagline') as string}**`);
	sections.push(`${t('syndicate.order_post.check_out') as string}\n${orderUrl}`);
	const body = sections.join('\n\n');

	const permlink = orderPostPermlink(ctx.orderPermlink);

	const payload: CommentPayload = {
		primaryTag: MORPHIT_TAG,
		tags: [MORPHIT_TAG, 'p2p-trading', ctx.asset.toLowerCase()],
		permlink,
		title,
		body,
		extraMetadata: {
			image: [IMAGE_ORDER_POST]
		}
	};

	try {
		const result = await broadcastComment(live, payload);
		return { ok: true, trxId: result.trx_id, permlink };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
