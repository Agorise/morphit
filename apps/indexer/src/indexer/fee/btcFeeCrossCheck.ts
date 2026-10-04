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
 * Verdict, by MAJORITY of the peers that answered (up to `maxPeers`, default
 * three, are asked):
 *   - 'disagree' only when at least TWO peers answered and more of them report
 *     another index, address or key than report this node's — so one
 *     registered peer can no longer veto every BTC fee address (any answering
 *     dissenter used to be enough, and registering a peer is free);
 *   - 'agree' when more answering peers agree than disagree;
 *   - 'unchecked' otherwise: nobody could answer (a lagging peer's "no such
 *     order" is no answer), a tie, or a LONE dissenter — logged, since an
 *     honest peer with a divergent log looks the same as a hostile one.
 * Residual risk,
 * stated: the browser takes this verdict from its own indexer, so it protects
 * against an HONEST node with a divergent log, not against a lying operator —
 * who, bound by the browser's own derivation, can at worst point at another
 * treasury address (see docs, OPERATIONS §40.12).
 */
import { hiddenNetworkOf } from '@morphit/hidden-transport';
import { clearnetRefused } from '@morphit/hidden-transport/router';

import { addressesOf, type FastPeer } from '$indexer/chatFastFederation';
import { logger } from '$log';

const log = logger('btc-fee-crosscheck');

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
	/** Peers whose answer named another index, address or key. */
	readonly disagreeing: number;
}

/** The majority rule above. PURE. */
export function crossCheckVerdict(agreeing: number, disagreeing: number): CrossCheckVerdict {
	if (agreeing + disagreeing >= 2 && disagreeing > agreeing) return 'disagree';
	if (agreeing > disagreeing) return 'agree';
	return 'unchecked';
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
	const maxPeers = input.maxPeers ?? 3;
	const path = `/v1/orders/${encodeURIComponent(input.account)}/${encodeURIComponent(input.permlink)}/btc-fee`;
	let asked = 0;
	let agreeing = 0;
	let disagreeing = 0;
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
			else if (same === false) disagreeing++;
			break;
		}
		if (tried) asked++;
	}
	const verdict = crossCheckVerdict(agreeing, disagreeing);
	if (disagreeing > 0 && verdict !== 'disagree') {
		log.warn('btc_fee_crosscheck_dissent_outvoted', {
			order: `${input.account}/${input.permlink}`,
			agreeing,
			disagreeing,
			verdict
		});
	}
	return { verdict, asked, agreeing, disagreeing };
}
