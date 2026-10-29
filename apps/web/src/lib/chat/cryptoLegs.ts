/**
 * A crypto-for-crypto trade, step by step (v1.21.17).
 *
 * An order such as "I'm buying at least 25 BRL of BLURT with XMR or BTC" is
 * paid in TWO coins: the buyer pays the order's PAYMENT coin (XMR or BTC — the
 * `pay_<coin>` methods) and the seller pays the order's ASSET (BLURT). The chat
 * used to offer only the asset leg: the BLURT seller saw "Send BLURT" at once,
 * before he had been paid, and the BLURT buyer saw "Share your Blurt account",
 * which nobody needs — BLURT goes to the account he is chatting from. The
 * maintainer's first live trade went exactly that way: the BLURT was sent and
 * the XMR/BTC never was, because the buyer was never shown where to pay.
 *
 * The order of a crypto-for-crypto trade is now:
 *   1. the ASSET SENDER says where, and how much, to pay him: an address of
 *      the payment coin with the amount (for BLURT, his account and the
 *      amount — the ask the payment is then checked against, and what ties
 *      the payer to this trade on his screen);
 *   2. the ASSET RECEIVER pays it, from the ask in the chat (copy / QR, or
 *      "Pay now" for BLURT), and records the payment (txid; for Monero also
 *      the tx key);
 *   3. the asset sender sees that payment checked live (amount, confirmations)
 *      and only then gets "Send <asset>" — at 0 confirmations already;
 *   4. he sends the asset (to the receiver's account for BLURT, else to the
 *      address the receiver shares).
 *
 * Orders paid any other way (PayPal, cash, a mix of crypto and non-crypto
 * methods) and barter orders keep the one-leg flow of chatMoneyFlow.
 *
 * PURE: no stores, no DOM. The thread's facts come in as plain lists.
 */
import { isGoodsAsset, type AssetTicker } from '@morphit/asset-registry';
import { chatAssetFromTicker } from '$lib/assets/registry';
import type { ChatAssetTicker } from './payload';
import { chatMoneyFlow } from './orderRole';

/** What the two legs are, for one reader of one order. */
export interface TwoLegPlan {
	/** The coins the payment leg can be made in (the `pay_<coin>` methods). */
	readonly paymentCoins: readonly ChatAssetTicker[];
	/** The payment coins the asset sender asks to be paid in (an address, or
	 *  for BLURT his account, with the amount): all of them. */
	readonly paymentAddressCoins: readonly ChatAssetTicker[];
	/** The order's asset, as a chat coin. */
	readonly asset: ChatAssetTicker;
	/** True when this reader sends the asset (and is paid first). */
	readonly iSendAsset: boolean;
}

/**
 * The two-leg plan for `order` as seen by its owner (`orderIsMine`) or the
 * other party — or null when the order is not crypto-for-crypto: no order, a
 * barter order, a dead order, or any payment method that is not a crypto
 * rail (then the one-leg flow applies).
 */
export function twoLegPlan(
	order: {
		side: string;
		status?: string;
		asset?: string;
		payment_methods?: readonly string[];
	} | null,
	orderIsMine: boolean
): TwoLegPlan | null {
	if (!order || order.asset === undefined || isGoodsAsset(order.asset as AssetTicker)) return null;
	const asset = chatAssetFromTicker(order.asset);
	if (asset === null) return null;
	const methods = order.payment_methods ?? [];
	if (methods.length === 0) return null;
	const paymentCoins: ChatAssetTicker[] = [];
	for (const m of methods) {
		const rail = /^pay_([a-z0-9]+)$/.exec(m);
		const coin = rail ? chatAssetFromTicker(rail[1]!) : null;
		// A method that is not a crypto rail (PayPal, cash …): not this flow.
		if (coin === null) return null;
		if (coin !== asset && !paymentCoins.includes(coin)) paymentCoins.push(coin);
	}
	if (paymentCoins.length === 0) return null;
	const flow = chatMoneyFlow(order, orderIsMine);
	// A finished order shows neither leg (chatMoneyFlow hides both).
	if (!flow.payNow && !flow.shareAddress) return null;
	return {
		paymentCoins,
		paymentAddressCoins: paymentCoins,
		asset,
		iSendAsset: flow.payNow
	};
}

/** Is this order paid only in other coins (a crypto-for-crypto order),
 *  whatever its status? A finished one has no plan (twoLegPlan) — and then
 *  no money moves from an address card either. */
export function isCryptoForCrypto(
	order: { asset?: string; payment_methods?: readonly string[] } | null
): boolean {
	if (!order || order.asset === undefined || isGoodsAsset(order.asset as AssetTicker)) return false;
	const asset = chatAssetFromTicker(order.asset);
	const methods = order.payment_methods ?? [];
	if (asset === null || methods.length === 0) return false;
	let other = false;
	for (const m of methods) {
		const rail = /^pay_([a-z0-9]+)$/.exec(m);
		const coin = rail ? chatAssetFromTicker(rail[1]!) : null;
		if (coin === null) return false;
		if (coin !== asset) other = true;
	}
	return other;
}

/** A structured message of the thread, reduced to what the legs need. */
export type ThreadFact =
	| {
			readonly kind: 'address';
			readonly mine: boolean;
			readonly method: ChatAssetTicker;
			readonly orderPermlink: string | null;
	  }
	| {
			readonly kind: 'funds_sent';
			readonly mine: boolean;
			readonly method: ChatAssetTicker;
			readonly orderPermlink: string | null;
			readonly txid: string;
	  };

/** How the payment leg stands, as far as the asset sender can tell. */
export type PaymentLegState =
	/** No payment recorded yet. */
	| 'unpaid'
	/** Recorded, and the check saw it arrive (any number of confirmations). */
	| 'seen'
	/** Recorded; the check is still running, or found nothing yet. */
	| 'checking'
	/** Recorded; it could not be confirmed here (explorers unreachable for a
	 *  while, no Monero tx key, no amount asked, a coin without a check). Only
	 *  the seller's own wallet can tell. */
	| 'unverifiable'
	/** Recorded; the check found it short or not paying this address (the
	 *  seller may still confirm it from his own wallet: paid in two parts, to
	 *  an earlier address of his …). */
	| 'mismatch'
	/** Recorded; mined before the address was first shared — someone's
	 *  earlier payment to it, not this trade's. */
	| 'old'
	/** Recorded in a coin for which no address was shared before it. */
	| 'no_address'
	/** Arrived, but no amount was asked: whether it is enough is the
	 *  seller's call (always so for a BLURT payment leg). */
	| 'unasked'
	/** Its transaction was already cited for another order. */
	| 'reused';

/** What a payment check said about a txid (see paymentChecks.ts). */
export type PaymentCheckVerdict =
	| 'seen'
	| 'checking'
	| 'unverifiable'
	| 'mismatch'
	| 'old'
	| 'no_address'
	| 'unasked'
	| 'reused';

/** The buttons and hints of a two-leg trade for this reader. */
export interface TwoLegButtons {
	/** Asset sender: share an address for the payment coin(s). */
	readonly sharePaymentAddress: boolean;
	/** Asset sender: "Send <asset>" — only once the payment leg is seen, or,
	 *  when it could not be confirmed here, once he said he sees it in his
	 *  own wallet. */
	readonly sendAsset: boolean;
	/** "Send <asset>" comes with "check your wallet first": the payment was
	 *  not confirmed here, the seller vouched for it himself. */
	readonly sendAssetUnchecked: boolean;
	/** Asset sender: "I see it in my wallet" (could not be confirmed here) or
	 *  "The amount is right" (arrived, no amount asked) — his own word, which
	 *  then brings up "Send <asset>". The hint tells which. */
	readonly confirmInWallet: boolean;
	/** Asset receiver: pay the BLURT the asset sender asked for, from the app. */
	readonly payBlurt: boolean;
	/** Asset receiver: share an address to receive the asset (not for BLURT). */
	readonly shareAssetAddress: boolean;
	/** The status line under the buttons, if any. */
	readonly hint:
		| 'waiting_address'
		| 'waiting_payment'
		| 'checking_payment'
		| 'payment_short'
		| 'payment_no_address'
		| 'payment_reused'
		| 'payment_old'
		/** Paid, but the asset receiver has not said where to send a coin
		 *  that is not BLURT (BLURT goes to the account he chats from). */
		| 'waiting_asset_address'
		| 'check_wallet'
		| 'check_amount'
		| null;
}

/**
 * Which buttons a two-leg trade shows to this reader, from the thread's
 * structured messages about this order and the check of the payment leg.
 * `paymentCheck` is the verdict for the payment leg's txid (null when there
 * is no payment recorded or no check yet). `walletConfirmed`: the asset
 * sender said he sees this payment in his own wallet.
 */
export function twoLegButtons(
	plan: TwoLegPlan,
	facts: readonly ThreadFact[],
	orderPermlink: string,
	paymentCheck: PaymentCheckVerdict | null,
	walletConfirmed = false
): TwoLegButtons {
	const about = (f: ThreadFact): boolean =>
		f.orderPermlink === null || f.orderPermlink === orderPermlink;
	const isPaymentCoin = (m: ChatAssetTicker): boolean => plan.paymentCoins.includes(m);
	// The payment leg is paid by the asset RECEIVER; the asset leg by the SENDER.
	// The newest, as the chat checks the newest (ConversationView.legPayment).
	const paymentReceipt = [...facts]
		.reverse()
		.find(
			(f) =>
				f.kind === 'funds_sent' && about(f) && isPaymentCoin(f.method) && f.mine !== plan.iSendAsset
		);
	const assetReceipt = facts.some(
		(f) =>
			f.kind === 'funds_sent' && about(f) && f.method === plan.asset && f.mine === plan.iSendAsset
	);
	const paymentAddressShared = facts.some(
		(f) => f.kind === 'address' && about(f) && isPaymentCoin(f.method) && f.mine === plan.iSendAsset
	);
	const paymentState: PaymentLegState =
		paymentReceipt === undefined
			? 'unpaid'
			: paymentReceipt.method === 'blurt' && paymentCheck === null
				? 'checking'
				: (paymentCheck ?? 'checking');

	if (plan.iSendAsset) {
		// What only his own wallet can settle: not confirmed here, no amount
		// asked, or not matching the ask (paid in parts, to an earlier address).
		// Never for a payment that predates his address or was already cited.
		const ownCall =
			paymentState === 'unverifiable' || paymentState === 'unasked' || paymentState === 'mismatch';
		const vouched = ownCall && walletConfirmed;
		const paid = paymentState === 'seen' || vouched;
		// Where to send it: BLURT goes to the account he chats with; any other
		// coin to the address the asset receiver shared — none yet, no "Send".
		const destinationKnown =
			plan.asset === 'blurt' ||
			facts.some(
				(f) =>
					f.kind === 'address' && about(f) && f.method === plan.asset && f.mine !== plan.iSendAsset
			);
		return {
			sharePaymentAddress:
				(paymentState === 'unpaid' || paymentState === 'no_address') &&
				plan.paymentAddressCoins.length > 0,
			sendAsset: paid && destinationKnown && !assetReceipt,
			sendAssetUnchecked: vouched && destinationKnown && !assetReceipt,
			confirmInWallet: ownCall && !walletConfirmed && !assetReceipt,
			payBlurt: false,
			shareAssetAddress: false,
			hint: assetReceipt
				? null
				: paid && !destinationKnown
					? 'waiting_asset_address'
					: paymentState === 'unpaid'
						? 'waiting_payment'
						: paymentState === 'checking'
							? 'checking_payment'
							: paymentState === 'no_address'
								? 'payment_no_address'
								: paymentState === 'reused'
									? 'payment_reused'
									: paymentState === 'old'
										? 'payment_old'
										: ownCall && !walletConfirmed
											? paymentState === 'unasked'
												? 'check_amount'
												: paymentState === 'mismatch'
													? 'payment_short'
													: 'check_wallet'
											: null
		};
	}
	// The asset receiver.
	const blurtAsked = facts.some(
		(f) => f.kind === 'address' && about(f) && f.method === 'blurt' && f.mine === plan.iSendAsset
	);
	return {
		sharePaymentAddress: false,
		sendAsset: false,
		sendAssetUnchecked: false,
		confirmInWallet: false,
		payBlurt: plan.paymentCoins.includes('blurt') && blurtAsked && paymentReceipt === undefined,
		shareAssetAddress: plan.asset !== 'blurt' && !assetReceipt,
		hint: paymentReceipt === undefined && !paymentAddressShared ? 'waiting_address' : null
	};
}
