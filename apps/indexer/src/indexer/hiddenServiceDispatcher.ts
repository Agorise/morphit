/**
 * Morphit indexer — global per-host hidden-service routing dispatcher.
 *
 * The router itself now lives in `@morphit/hidden-transport/router`, so the
 * RELAY installs the same one (F32): it was the process that broadcasts, and
 * on a tor-only node it had no router at all. This module keeps every name the
 * indexer and its tests import, and adds the indexer's install log line. The
 * design notes — why clearnet is untouched, why only two suffixes divert, why
 * a hidden-only node fails closed — are in the package, with the code they
 * describe.
 */

import {
	installHiddenServiceDispatcher as installRouter,
	type HiddenDispatcherHandle
} from '@morphit/hidden-transport/router';
import type { HiddenServiceProxyConfig } from './hiddenServiceFetch';
import { logger } from '$log';

export {
	hiddenRouteOf,
	isClearnetOrigin,
	clearnetRefused,
	ClearnetRefusedError,
	buildHiddenSubDispatchers,
	HiddenServiceRoutingDispatcher
} from '@morphit/hidden-transport/router';
export type {
	HiddenRoute,
	HiddenSubDispatchers,
	HiddenDispatcherHandle
} from '@morphit/hidden-transport/router';

const log = logger('hidden-dispatcher');

/**
 * Install the routing dispatcher globally (see the package), and say so in the
 * indexer's log. main.ts always installs it; `indexerRouterPolicy` picks the
 * policy.
 */
export function installHiddenServiceDispatcher(
	config: HiddenServiceProxyConfig,
	policy: 'allow' | 'refuse' = 'allow'
): HiddenDispatcherHandle {
	const handle = installRouter(config, policy);
	log.info('hidden_dispatcher_installed', {
		tor: config.torSocks.length > 0 ? config.torSocks : '(disabled)',
		i2p: config.i2pHttpProxy.length > 0 ? config.i2pHttpProxy : '(disabled)',
		clearnet_policy: policy,
		note:
			policy === 'refuse'
				? 'HIDDEN-ONLY: public clearnet fail-closed; .onion→Tor, .b32.i2p→i2pd, local/.loki allowed'
				: 'clearnet unchanged; .onion→Tor, .b32.i2p→i2pd'
	});
	return handle;
}

/**
 * Whether, and how, the indexer installs the router. PURE. Always installed.
 *
 * It used to be installed only when hidden RPC
 * endpoints were CONFIGURED, which left two configurations without one:
 *   - a clearnet node with a blank hidden list still merges `.onion`/`.i2p`
 *     nodes from the on-chain RPC directory into its pool (at boot and at
 *     runtime); with no router those names went to the system resolver, the
 *     ISP's. With the router, a hidden name goes to its proxy or is refused
 *     before any lookup, and clearnet goes to a plain Agent — undici's default,
 *     unchanged.
 *   - a node reading only from a co-located blurtd (both lists blank) is
 *     hidden-only by every other rule here (an empty clearnet pool drops the
 *     clearnet price sources and makes the peer monitor sample over hidden
 *     addresses only), but with no router `clearnetRefused()` was false and
 *     the probe, chat fan-out and FX sources used clearnet from the box's own
 *     address. An empty clearnet pool now means `refuse`, whatever else is set;
 *     loopback (the co-located blurtd) is never refused.
 */
export function indexerRouterPolicy(config: {
	readonly blurtRpcEndpoints: readonly string[];
	readonly hiddenRpcEndpoints: readonly string[];
}): 'refuse' | 'allow' {
	return config.blurtRpcEndpoints.length === 0 ? 'refuse' : 'allow';
}
