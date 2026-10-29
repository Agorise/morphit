/**
 * Payments this person made from this device for an order, kept until sign-out
 * (v1.21.17).
 *
 * A crypto-for-crypto seller's "Send BLURT" hides once his own receipt for it
 * is in the thread. The receipt is a chat message posted AFTER the transfer:
 * when that post failed (the node refused it, the tab went away, the network
 * dropped), the thread had no receipt, and "Send BLURT" came back — the way to
 * pay twice. Every payment the app makes, or that he records with "Mark sent",
 * is noted here before its receipt is posted, and counts as his receipt for the
 * buttons whatever became of the message.
 *
 * Kept in the session's person storage ($lib/storage/personStorage: names the
 * peers, so never past sign-out), at most MAX_ENTRIES, newest last.
 */
import { get, writable, type Readable } from 'svelte/store';

import { personGet, personRemove, personSet, personStorageTier } from '$lib/storage/personStorage';
import type { ChatAssetTicker } from './payload';

export const LEG_LEDGER_KEY = 'morphit.chat.leg_ledger.v1';
const MAX_ENTRIES = 200;

export interface LedgerEntry {
	/** The order paid for. */
	readonly orderPermlink: string;
	/** Who was paid. */
	readonly peer: string;
	readonly method: ChatAssetTicker;
	readonly txid: string;
}

function isEntry(v: unknown): v is LedgerEntry {
	if (typeof v !== 'object' || v === null) return false;
	const e = v as Record<string, unknown>;
	return (
		typeof e.orderPermlink === 'string' &&
		typeof e.peer === 'string' &&
		typeof e.method === 'string' &&
		typeof e.txid === 'string'
	);
}

function read(): LedgerEntry[] {
	const raw = personGet(LEG_LEDGER_KEY);
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
	} catch {
		return [];
	}
}

const store = writable<readonly LedgerEntry[]>([]);
/** Re-read when a session starts or ends (person storage moves with it). */
personStorageTier.subscribe(() => store.set(read()));

/** Every payment noted, newest last. */
export const legLedger: Readable<readonly LedgerEntry[]> = { subscribe: store.subscribe };

/** Note a payment, before its receipt is posted. The same payment noted again
 *  is one entry. */
export function recordLegPayment(entry: LedgerEntry): void {
	const current = get(store).filter(
		(e) =>
			!(
				e.orderPermlink === entry.orderPermlink &&
				e.peer === entry.peer &&
				e.method === entry.method &&
				e.txid === entry.txid
			)
	);
	current.push({
		orderPermlink: entry.orderPermlink,
		peer: entry.peer,
		method: entry.method,
		txid: entry.txid
	});
	const kept = current.length > MAX_ENTRIES ? current.slice(current.length - MAX_ENTRIES) : current;
	try {
		personSet(LEG_LEDGER_KEY, JSON.stringify(kept));
	} catch {
		// best-effort: the store below still holds it for this visit
	}
	store.set(kept);
}

/** The payments made to `peer` for `orderPermlink`. */
export function legPaymentsFor(
	ledger: readonly LedgerEntry[],
	orderPermlink: string,
	peer: string
): LedgerEntry[] {
	return ledger.filter((e) => e.orderPermlink === orderPermlink && e.peer === peer);
}

/** Sign-out: forget them all, in memory and on disk. */
export function clearLegLedger(): void {
	personRemove(LEG_LEDGER_KEY);
	store.set([]);
}

/** For tests: what the store holds now. */
export function _ledgerNow(): readonly LedgerEntry[] {
	return get(store);
}
