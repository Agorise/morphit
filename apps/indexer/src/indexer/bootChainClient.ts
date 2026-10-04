/**
 * Morphit indexer — a chain client for a standalone script, routed like the
 * service's.
 *
 * The indexer service installs the hidden-service router before it reads the
 * chain (main.ts): `.onion` goes to Tor, `.b32.i2p` to i2pd, and a node with no
 * clearnet RPC refuses every public clearnet origin. A script that builds a
 * BlurtClient without it sends `.b32.i2p` / `.onion` names to the system
 * resolver — on a zero-clearnet box that is a DNS leak of every hidden node it
 * asks, and the read then fails, so Tier-2 snapshot verification there was
 * silently "inconclusive". Every script that reads the chain builds its
 * client here.
 *
 * Installing the router is not optional and not best-effort: if it cannot be
 * installed the script stops, rather than reading the chain unrouted.
 */
import { BlurtClient } from '$blurt/client';
import type { Config } from '$config';
import {
	installHiddenServiceDispatcher,
	indexerRouterPolicy
} from '$indexer/hiddenServiceDispatcher';
import { hiddenServiceProxyConfigFromEnv } from '$indexer/hiddenServiceFetch';

let installed = false;

/** Install the service's router for this process (once). Call before the
 *  script's first network request of any kind. Throws if it cannot. */
export function installChainRouting(
	config: Pick<Config, 'blurtRpcEndpoints' | 'hiddenRpcEndpoints'>
): void {
	if (installed) return;
	installHiddenServiceDispatcher(
		hiddenServiceProxyConfigFromEnv(process.env),
		indexerRouterPolicy(config)
	);
	installed = true;
}

/** A BlurtClient whose requests go through the service's router. */
export function bootChainClient(config: Config): BlurtClient {
	installChainRouting(config);
	return new BlurtClient(config);
}
