/**
 * The unseal of the chat-key pins that every unlock starts ($stores/identity →
 * $lib/chat/pubPin unsealPins) is asynchronous. Until it has landed, the pins a
 * Lock sealed are not readable, so a peer's key looked up in that moment would
 * look like a first contact and be pinned without the "safety number changed"
 * step. Lookups wait for it here first.
 *
 * A module of its own, with no imports, so the identity store (on every page)
 * can set it without pulling the chat crypto into the first paint.
 */
let pending: Promise<unknown> = Promise.resolve();

/** The identity store: the unseal of this unlock. */
export function setUnsealPending(p: Promise<unknown>): void {
	pending = p.catch(() => undefined);
}

/** Resolves once the latest unseal has finished (at once when none runs). */
export function unsealSettled(): Promise<unknown> {
	return pending;
}
