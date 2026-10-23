/**
 * What a send binds a v4 envelope to (crypto.ts, review C-M2), or nothing — a
 * v3 send.
 *
 * Nothing is bound (v3) when:
 *   - writing v4 is off (WRITE_ENVELOPE_V4, read first);
 *   - the thread is about an order whose owner could not be told now: v4
 *     names the owner, one of the two parties;
 *   - the chain's head time could not be read, or this device's clock
 *     disagrees with it by more than ENVELOPE_CLOCK_AGREE_S. The head time is
 *     read through the sender's own instance, and a message must not carry a
 *     time the instance chose: the device's clock is the check.
 * A v3 send authenticates the words, as before; only the order and the time
 * are then the indexer's word.
 */
import type { EnvelopeBinding } from '$lib/chat/crypto';

/** How far the chain's head time and this device's clock may differ for a
 *  send to be bound to that time. */
export const ENVELOPE_CLOCK_AGREE_S = 120;

export async function sendBinding(opts: {
	/** Write v4 at all. */
	readonly write: boolean;
	/** The thread's order permlink; null for a direct message. */
	readonly order: string | null;
	/** Who posted that order (the peer or us), false/null when not known. */
	readonly ownerOf: (order: string) => Promise<string | false | null>;
	/** The chain's head time, whole seconds. */
	readonly chainNowSeconds: () => Promise<number>;
	/** This device's clock, ms (Date.now). */
	readonly deviceNowMs?: () => number;
}): Promise<EnvelopeBinding | undefined> {
	if (!opts.write) return undefined;
	let owner: string | null = null;
	if (opts.order !== null && opts.order !== '') {
		const o = await opts.ownerOf(opts.order).catch(() => null);
		if (typeof o !== 'string' || o === '') return undefined;
		owner = o;
	}
	const head = await opts.chainNowSeconds().catch(() => null);
	if (head === null || !Number.isFinite(head)) return undefined;
	const device = Math.floor((opts.deviceNowMs ?? Date.now)() / 1000);
	if (Math.abs(head - device) > ENVELOPE_CLOCK_AGREE_S) return undefined;
	return { order: opts.order, owner, t: head };
}
