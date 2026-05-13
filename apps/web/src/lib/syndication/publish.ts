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
 * Fires once, automatically, when the user broadcasts feedback for
 * their first trade (which is forced to be a BLURT BUY per the
 * waiver branch). Posted to the @morphit community
 * (parent_permlink = "blurt-176570").
 *
 * No opt-in. It's part of the onboarding promise — every new user's
 * first trade produces this post. Idempotent via deterministic
 * permlink: a retry won't double-post.
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

import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';

import type { LiveIdentity } from '$crypto/keygen';
import type { AssetTicker } from '@morphit/asset-registry';
import { broadcastComment, type CommentPayload } from '$blurt/ops/comment';
import { getUserBlurtAccount } from '$blurt/ops/profile';

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
const IMAGE_ORDER_POST =
	'https://img.blurt.blog/blurtimage/morphit/ed05997f374e75ed59746588f09c0771f136df26.png';

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
	const body = t('syndicate.first_trade.body', {
		values: { username: account }
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
	const bodyKey =
		ctx.side === 'buy' ? 'syndicate.order_post.body_buy' : 'syndicate.order_post.body_sell';
	const title = t(titleKey, {
		values: {
			asset1: ctx.asset,
			asset2: ctx.counterAsset
		}
	}) as string;
	const body = t(bodyKey, {
		values: {
			asset1: ctx.asset,
			asset2: ctx.counterAsset,
			username: account,
			permlink: ctx.orderPermlink
		}
	}) as string;

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
