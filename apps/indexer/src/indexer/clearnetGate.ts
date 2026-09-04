/**
 * clearnetGate — computes the `clearnet_eliminated` flag (v1.15.x stage 4).
 *
 * The single keystone the "Zero use of clearnet internet" claim (frontend brag,
 * Security page, FAQ, blog) hangs on. It is TRUE only when EVERY outbound leg of
 * a hidden-only node is provably private over Tor/I2P — a strict AND, so any one
 * unproven leg keeps it FALSE and the strong claim off. This is what stops the
 * marketing ever outrunning the code.
 *
 * PURE + total → exhaustively unit-tested. Each leg is derived from real runtime
 * facts by the caller (see /v1/instance); this module only combines them.
 */

export interface ClearnetEliminationLegs {
	/** Chain reads go over onion/i2p RPC only — the clearnet RPC pool is empty
	 *  AND at least one hidden RPC endpoint is configured (a truly hidden-only
	 *  node, not merely a misconfigured one with no RPC at all). */
	readonly chainHidden: boolean;
	/** This node runs/publishes a Tor .onion address. */
	readonly transportTor: boolean;
	/** This node runs/publishes an I2P address. Both transports are REQUIRED
	 *  (the maintainer's directive: hidden-only means Tor AND I2P as equals) so a compromise
	 *  or block of one network can't dark the node — and so "zero clearnet" never
	 *  rests on a single hidden network. */
	readonly transportI2p: boolean;
	/** Price comes from the federation over Tor/I2P (federated median primary),
	 *  never a clearnet price API. */
	readonly priceFederated: boolean;
	/** The served frontend auto-loads nothing external (build-time invariant,
	 *  enforced by frontend-local-only-smoke). */
	readonly frontendLocal: boolean;
	/** Upgrades are fetched from federation peers' hidden IPFS gateways over
	 *  Tor/I2P, verified against the on-chain SHA, fail-closed. */
	readonly upgradeHidden: boolean;
	/** No clearnet Matrix homeserver: the alert bot is off, or its homeserver is
	 *  a .onion/.i2p address (so it doesn't phone a clearnet homeserver). */
	readonly matrixClean: boolean;
}

/**
 * Compute `clearnet_eliminated`. Strict AND of every leg — a hidden-only node
 * that hasn't proven all of them is NOT "zero clearnet", and the flag stays
 * false so no strong claim renders.
 */
export function computeClearnetEliminated(legs: ClearnetEliminationLegs): boolean {
	return (
		legs.chainHidden &&
		legs.transportTor &&
		legs.transportI2p &&
		legs.priceFederated &&
		legs.frontendLocal &&
		legs.upgradeHidden &&
		legs.matrixClean
	);
}

/** The legs still preventing `clearnet_eliminated` — surfaced on /v1/instance so
 *  an operator can see exactly what to fix (e.g. "add an I2P address", "your
 *  Matrix homeserver is clearnet"). Empty array ⇔ eliminated. PURE. */
export function clearnetEliminationMissing(legs: ClearnetEliminationLegs): (keyof ClearnetEliminationLegs)[] {
	return (Object.keys(legs) as (keyof ClearnetEliminationLegs)[]).filter((k) => !legs[k]);
}

/**
 * Is a Matrix homeserver URL a hidden-service address (so the alert bot doesn't
 * touch clearnet)? PURE. An absent/empty homeserver means the bot isn't wired to
 * one → clean. A clearnet host → not clean.
 */
export function matrixHomeserverIsHidden(homeserverUrl: string | null | undefined): boolean {
	if (!homeserverUrl || homeserverUrl.trim() === '') return true; // no bot / no server → clean
	let host: string;
	try {
		host = new URL(homeserverUrl).hostname.toLowerCase();
	} catch {
		return false; // unparseable → treat as unsafe
	}
	return host.endsWith('.onion') || host.endsWith('.i2p');
}

/** The frontend is local-only by build invariant (frontend-local-only-smoke
 *  fails CI otherwise), so the served bundle a node ships auto-loads nothing
 *  external. Exposed as a constant the runtime gate can trust. */
export const FRONTEND_IS_LOCAL_ONLY = true;
