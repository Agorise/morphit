/**
 * Morphit indexer — ask another instance which fee address it gave an order
 * (v1.20.0, MK-H2 / V3-5, V3-6).
 *
 * Every indexer numbers per-order BTC fee addresses from its own event log.
 * If THIS node's log differs from the federation's — a block a hostile RPC
 * endpoint forged or censored, a pin an older version stored stripped — it
 * numbers differently, and the payer's browser (which re-derives the address
 * from the chain-verified xpub, so the address is always a treasury address)
 * would still send the money to ANOTHER order's address. The browser cannot
 * ask other instances itself (its Content-Security-Policy allows only its own
 * origin and the RPC nodes), so this node asks up to `maxPeers` directory
 * peers, the way it already reaches them for federated chat: hidden addresses
 * over the hidden transport, clearnet only when this is not a hidden-only
 * node, never following redirects (the fetchers do that).
 *
 * Verdict: 'disagree' if ANY answering peer reports another index, address or
 * key; 'agree' if at least one answered and all agree; 'unchecked' if none
 * could answer (a lagging peer's "no such order" is no answer). Residual risk,
 * stated: the browser takes this verdict from its own indexer, so it protects
 * against an HONEST node with a divergent log, not against a lying operator —
 * who, bound by the browser's own derivation, can at worst point at another
 * treasury address (see docs, OPERATIONS §40.12).
 */
import { hiddenNetworkOf } from '@morphit/hidden-transport';
import { clearnetRefused } from '@morphit/hidden-transport/router';

import { addressesOf, type FastPeer } from '$indexer/chatFastFederation';

export interface LocalBtcFee {
	readonly index: number;
	readonly address: string;
	readonly xpub: string;
}

export type CrossCheckVerdict = 'agree' | 'disagree' | 'unchecked';

export interface CrossCheckResult {
	readonly verdict: CrossCheckVerdict;
	/** Peers asked (reachable address tried). */
	readonly asked: number;
	/** Peers whose answer matched. */
	readonly agreeing: number;
}

function sameFee(a: unknown, local: LocalBtcFee): boolean | null {
	if (typeof a !== 'object' || a === null) return null;
	const o = a as Record<string, unknown>;
	if (typeof o.index !== 'number' || typeof o.address !== 'string') return null;
	return (
		o.index === local.index &&
		o.address === local.address &&
		(typeof o.xpub !== 'string' || o.xpub === local.xpub)
	);
}

export async function crossCheckBtcFee(input: {
	readonly local: LocalBtcFee;
	readonly account: string;
	readonly permlink: string;
	/** Directory peers, best first (chatFastFederation.fastPeersFromDirectory). */
	readonly peers: readonly (FastPeer | { origin: string; hidden: boolean })[];
	/** GET JSON from a peer; throws on any failure or non-2xx. Chosen per
	 *  address by the caller (hidden transport or the pinned clearnet fetch). */
	readonly fetchJson: (url: string, hidden: boolean) => Promise<unknown>;
	readonly maxPeers?: number;
}): Promise<CrossCheckResult> {
	const maxPeers = input.maxPeers ?? 2;
	const path = `/v1/orders/${encodeURIComponent(input.account)}/${encodeURIComponent(input.permlink)}/btc-fee`;
	let asked = 0;
	let agreeing = 0;
	let disagree = false;
	for (const peer of input.peers) {
		if (asked >= maxPeers) break;
		let tried = false;
		for (const addr of addressesOf(peer as FastPeer)) {
			const hiddenUrl = hiddenNetworkOf(addr.origin) !== null;
			if (addr.hidden && !hiddenUrl) continue;
			if (!addr.hidden && clearnetRefused()) continue;
			tried = true;
			let body: unknown;
			try {
				body = await input.fetchJson(new URL(path, addr.origin).toString(), addr.hidden);
			} catch {
				continue; // next address of the same peer
			}
			const same = sameFee(body, input.local);
			if (same === true) agreeing++;
			else if (same === false) disagree = true;
			break;
		}
		if (tried) asked++;
	}
	return { verdict: disagree ? 'disagree' : agreeing > 0 ? 'agree' : 'unchecked', asked, agreeing };
}
