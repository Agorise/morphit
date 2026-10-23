/**
 * tradeStatus — Svelte store wrapper around the pure logic.
 *
 * Phase F.5.  See tradeStatusPure.ts for the pure dispatcher
 * + mutator implementations.  This file holds only the
 * Svelte-store state + reactive subscriptions; pure logic
 * lives next door so smoke runners can exercise it under tsx.
 */

import { writable, get, type Readable } from 'svelte/store';
import type { VerifyResult } from '$lib/chat/blurtVerify';
import type { ChatAssetTicker } from '$lib/chat/payload';
import {
	recordAddressSharedPure,
	recordFundsSentPure,
	recordVerificationPure,
	tradeKey,
	tradeStateOf,
	tradeStateWith,
	type TradeState,
	type TradePhase,
	type MismatchField
} from '$lib/trades/tradeStatusPure';

// Re-export types for back-compat with existing consumers.
export type { TradeState, TradePhase, MismatchField };
export { tradeKey, tradeStateOf, tradeStateWith };

const _states = writable<ReadonlyMap<string, TradeState>>(new Map());

/** Public read-only view of the entire trade-state map, keyed by
 *  tradeKey(order owner, order permlink). */
export const tradeStates: Readable<ReadonlyMap<string, TradeState>> = {
	subscribe: _states.subscribe
};

/** Imperative one-shot read — for non-reactive callers. */
export function getTradeState(orderOwner: string, orderPermlink: string): TradeState | null {
	return tradeStateOf(get(_states), orderOwner, orderPermlink);
}

// ────────────────────────────────────────────────────────────────
// Mutators — thin wrappers over the pure logic
// ────────────────────────────────────────────────────────────────

export function recordAddressShared(args: {
	orderOwner: string;
	orderPermlink: string;
	peer: string;
	method: ChatAssetTicker;
	address: string;
	expectedAmount?: number;
	expectedMemo?: string;
	direction: 'outgoing' | 'incoming';
}): void {
	_states.update((current) => recordAddressSharedPure(current, args));
}

export function recordFundsSent(args: {
	orderOwner: string;
	orderPermlink: string;
	peer: string;
	method: ChatAssetTicker;
	txid: string;
	claimedMemo?: string;
	amount?: number;
	direction: 'outgoing' | 'incoming';
}): void {
	_states.update((current) => recordFundsSentPure(current, args));
}

export function recordVerification(args: {
	orderOwner: string;
	orderPermlink: string;
	verifyResult: VerifyResult;
	counterparty: string;
	amountConfirmed: boolean;
}): void {
	_states.update((current) => recordVerificationPure(current, args));
}

/** Clear all trade state.  Called by explicitLock on user-
 *  initiated session lock; future logout flow will too. */
export function clearAllTradeStates(): void {
	_states.set(new Map());
}
