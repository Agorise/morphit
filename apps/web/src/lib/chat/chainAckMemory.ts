/**
 * The chain read marker this tab broadcast per thread (v1.21.17), so opening a
 * thread again does not put the same marker on chain again: every marker is a
 * chain operation, paid in the account's bandwidth. In memory only — a new tab
 * or a reload sends its first marker again — and forgotten at sign-out.
 */
const acked = new Map<string, number>();

const keyOf = (peer: string, orderPermlink: string): string => `${peer}\u0000${orderPermlink}`;

/** The newest message time acked on chain for this thread from this tab. */
export function chainAckedFor(peer: string, orderPermlink: string): number | null {
	return acked.get(keyOf(peer, orderPermlink)) ?? null;
}

/** A marker went out (never moves back). */
export function rememberChainAck(peer: string, orderPermlink: string, atMs: number): void {
	const k = keyOf(peer, orderPermlink);
	const prev = acked.get(k);
	if (prev === undefined || atMs > prev) acked.set(k, atMs);
}

export function clearChainAckMemory(): void {
	acked.clear();
}
