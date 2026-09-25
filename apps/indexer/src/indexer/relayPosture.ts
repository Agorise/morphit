/**
 * What this node's own RELAY last said about how it reaches the chain.
 *
 * WHY THE INDEXER NEEDS TO KNOW (F32). `clearnet_eliminated` — the keystone
 * behind the "Zero use of clearnet internet" label — was computed from the
 * INDEXER's configuration alone. The relay is a separate process with its own
 * chain endpoint list, and it is the one that broadcasts: signups, relayed
 * transfers. On a tor-only install it went to clearnet RPC operators from the
 * box's own address while the indexer beside it did not, and the label said
 * zero. The claim is about the node, so the node's relay has to be asked.
 *
 * The relay reports `hidden_only` on its `/v1/health`; the operational-health
 * sampler (which already probes that endpoint for up/down) records it here.
 * Held in the indexer layer, not the API one, so the federation probe's self
 * row and `/v1/instance` read the same value without the indexer importing
 * from its HTTP layer.
 *
 * Unknown (never sampled, relay down since boot, or a relay too old to say) is
 * NOT hidden-only. The gate is a strict AND of things proven; a leg that has
 * not been proven is false.
 */

let lastReported: boolean | null = null;

/** Record what the relay said. `null` = it answered without saying (an older
 *  relay) — recorded as such, because that is also not proof. */
export function noteRelayHiddenOnly(reported: boolean | null): void {
	lastReported = reported;
}

/** True only if the relay's last answer said it reaches the chain over hidden
 *  services alone. */
export function relayReportsHiddenOnly(): boolean {
	return lastReported === true;
}

/** Test seam. */
export function _resetRelayPostureForTest(): void {
	lastReported = null;
}
