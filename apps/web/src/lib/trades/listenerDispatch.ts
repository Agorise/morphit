/**
 * listenerDispatch — pure dispatch logic for the global trade-
 * event listener.
 *
 * Phase F.5 audit fix (F-32).  The listener's post-decode logic
 * (route to store, fire toast, fire notification) was previously
 * inlined inside `handleAppend`, which made it untestable
 * because handleAppend is async and does I/O (decrypt, store
 * mutation).
 *
 * This module contains the pure decision logic: given a decoded
 * payload + a context (current user, current pathname), return
 * a plan describing what side-effects the caller should apply.
 * Smoke tests can pass synthetic inputs and assert the plan
 * without mocking the store or window.
 *
 * The caller (`handleAppend`) reads the plan and applies the
 * effects via the real I/O functions.
 */

import type { DecodeResult, ChatAssetTicker } from '$lib/chat/payload';

/** Inputs the dispatcher needs to make routing decisions. */
export interface ListenerDispatchContext {
	/** The record's sender — the chat peer for the local user. */
	readonly sender: string;
	/** Local user's blurt account.  Used as `recipient` for
	 *  incoming-payload verification. */
	readonly me: string;
	/** Current page pathname (e.g. window.location.pathname).
	 *  Used for the F-38 same-page suppression check.  Pass
	 *  empty string in non-browser contexts; the dispatcher
	 *  treats that as "not on chat page." */
	readonly currentPathname: string;
	/** Current UI locale (e.g. 'en', 'zh-CN'). The chat route is
	 *  locale-prefixed (/[lang]/chat/[account]), so BOTH the
	 *  same-page suppression path AND the click-through href must
	 *  carry it — otherwise the suppression never matches (toast
	 *  fires even while viewing the chat) and the link 404s. */
	readonly lang: string;
}

/** A store mutation the caller should apply. */
export type StoreEffect =
	| {
			readonly kind: 'recordAddressShared';
			readonly args: {
				readonly orderPermlink: string;
				readonly peer: string;
				readonly method: ChatAssetTicker;
				readonly address: string;
				readonly expectedAmount: number | undefined;
				readonly expectedMemo: string | undefined;
				readonly direction: 'incoming';
			};
	  }
	| {
			readonly kind: 'recordFundsSent';
			readonly args: {
				readonly orderPermlink: string;
				readonly peer: string;
				readonly method: ChatAssetTicker;
				readonly txid: string;
				readonly claimedMemo: string | undefined;
				readonly amount: number | undefined;
				readonly direction: 'incoming';
			};
	  };

/** A verification trigger the caller should fire. */
export interface VerifyEffect {
	readonly recipient: string;
	readonly sender: string;
	readonly amountBlurt: number;
	readonly echoedMemo: string;
	readonly orderPermlink: string;
	readonly txid: string;
}

/** A toast + notification intent. */
export interface NotifyEffect {
	readonly kind: 'address' | 'funds_sent';
	/** Args for i18n interpolation.  Caller calls
	 *  `t('chat.trade_event.X', { values })` to get the final
	 *  string.  We don't bake the strings in here so the
	 *  dispatch stays pure (no svelte-i18n call inside). */
	readonly i18n: {
		readonly titleKey: string;
		readonly bodyKey: string;
		readonly values: Record<string, string>;
	};
	/** Deep-link target for click-through. */
	readonly href: string;
	/** Browser-notification tag key. */
	readonly notificationTag: string;
	/** Toast severity. */
	readonly toastKind: 'info' | 'success';
}

/** The full plan: zero-or-more effects.  Caller applies each.
 *  All fields are optional so the caller can early-exit when
 *  any effect is absent.  Per F-30 / F-38 / etc. we may have a
 *  store effect but no notify effect. */
export interface ListenerDispatchPlan {
	readonly store: StoreEffect | null;
	readonly verify: VerifyEffect | null;
	readonly notify: NotifyEffect | null;
}

/** The empty plan — return this when the payload should be
 *  ignored entirely (unknown kind, missing permlink, etc.). */
const EMPTY: ListenerDispatchPlan = {
	store: null,
	verify: null,
	notify: null
};

/** Pure dispatcher.  Given a decoded payload + context, return
 *  a plan.  No I/O, no global state reads.
 *
 *  Accepts the full DecodeResult (not just structured kinds) so
 *  the caller doesn't have to discriminate before calling.
 *  Returns the empty plan for plaintext / unknown kinds. */
export function planListenerDispatch(
	decoded: DecodeResult,
	ctx: ListenerDispatchContext
): ListenerDispatchPlan {
	if (decoded.kind !== 'address' && decoded.kind !== 'funds_sent') {
		return EMPTY;
	}

	const orderPermlink = decoded.payload.orderPermlink;
	if (!orderPermlink) return EMPTY;

	// ─── Store effect ────────────────────────────────────────
	let store: StoreEffect | null = null;
	if (decoded.kind === 'address') {
		store = {
			kind: 'recordAddressShared',
			args: {
				orderPermlink,
				peer: ctx.sender,
				method: decoded.payload.method,
				address: decoded.payload.address,
				expectedAmount: decoded.payload.amount ? Number(decoded.payload.amount) : undefined,
				expectedMemo: decoded.payload.memo,
				direction: 'incoming'
			}
		};
	} else {
		store = {
			kind: 'recordFundsSent',
			args: {
				orderPermlink,
				peer: ctx.sender,
				method: decoded.payload.method,
				txid: decoded.payload.txid,
				claimedMemo: decoded.payload.memo,
				amount: decoded.payload.amount ? Number(decoded.payload.amount) : undefined,
				direction: 'incoming'
			}
		};
	}

	// ─── Verify effect (BLURT funds-sent only) ───────────────
	let verify: VerifyEffect | null = null;
	if (decoded.kind === 'funds_sent' && decoded.payload.method === 'blurt') {
		const amountStr = decoded.payload.amount;
		if (amountStr !== undefined) {
			const amountNum = Number(amountStr);
			if (Number.isFinite(amountNum) && amountNum > 0) {
				verify = {
					recipient: ctx.me,
					sender: ctx.sender,
					amountBlurt: amountNum,
					echoedMemo: decoded.payload.memo ?? '',
					orderPermlink,
					txid: decoded.payload.txid
				};
			}
		}
	}

	// ─── Notify effect (suppressed when on matching chat page) ──
	const expectedPath = `/${ctx.lang}/chat/${ctx.sender}`;
	const onMatchingChatPage =
		ctx.currentPathname === expectedPath || ctx.currentPathname.startsWith(`${expectedPath}/`);

	let notify: NotifyEffect | null = null;
	if (!onMatchingChatPage) {
		// F-28: truncate long permlinks for visual display.
		const displayPermlink =
			orderPermlink.length > 22 ? `${orderPermlink.slice(0, 19)}…` : orderPermlink;
		const href = `/${ctx.lang}/chat/${encodeURIComponent(ctx.sender)}?order=${encodeURIComponent(orderPermlink)}`;
		const notificationTag = `morphit-trade-${orderPermlink}`;

		if (decoded.kind === 'address') {
			notify = {
				kind: 'address',
				i18n: {
					titleKey: 'chat.trade_event.address_shared_title',
					bodyKey: 'chat.trade_event.address_shared_body',
					values: {
						peer: ctx.sender,
						method: decoded.payload.method.toUpperCase(),
						orderPermlink: displayPermlink
					}
				},
				href,
				notificationTag,
				toastKind: 'info'
			};
		} else {
			const amount = decoded.payload.amount ?? '';
			const method = decoded.payload.method.toUpperCase();
			notify = {
				kind: 'funds_sent',
				i18n: {
					titleKey: 'chat.trade_event.funds_sent_title',
					bodyKey: amount
						? 'chat.trade_event.funds_sent_body_with_amount'
						: 'chat.trade_event.funds_sent_body',
					values: amount
						? {
								peer: ctx.sender,
								amount,
								method,
								orderPermlink: displayPermlink
							}
						: { peer: ctx.sender, orderPermlink: displayPermlink }
				},
				href,
				notificationTag,
				toastKind: 'success'
			};
		}
	}

	return { store, verify, notify };
}
