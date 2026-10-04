/**
 * The relay installs the router even with no hidden endpoint configured.
 *
 *
 * A clearnet relay with a blank MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS installed no
 * router — yet at boot it merges the on-chain RPC directory, `.onion`/`.i2p`
 * nodes included, into its pool. With no router those names went to the system
 * resolver (the ISP's). Asserted at the real resolver: `dns.lookup` is counted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dns from 'node:dns';
import {
	installHiddenServiceDispatcher,
	routerInstallPolicy,
	clearnetRefused,
	type HiddenDispatcherHandle
} from '@morphit/hidden-transport/router';
import { hiddenRouterPolicy } from '../src/config/index.ts';

const ONION = `${'a'.repeat(56)}.onion`;
const PROXIES = { torSocks: '127.0.0.1:1', i2pHttpProxy: '127.0.0.1:1' };

let lookups: string[] = [];
const realLookup = dns.lookup;
let handle: HiddenDispatcherHandle | null = null;
beforeEach(() => {
	lookups = [];
	(dns as unknown as { lookup: unknown }).lookup = (
		host: string,
		opts: unknown,
		cb?: (...a: unknown[]) => void
	): void => {
		lookups.push(host);
		const done = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
		done(Object.assign(new Error('stub: no DNS here'), { code: 'ENOTFOUND' }));
	};
});
afterEach(async () => {
	(dns as unknown as { lookup: unknown }).lookup = realLookup;
	await handle?.uninstall();
	handle = null;
});

describe('L3 — relay router', () => {
	it('a clearnet relay never resolves a directory .onion, and keeps clearnet', async () => {
		// What main.ts does with the decision.
		const policy = routerInstallPolicy(
			hiddenRouterPolicy({
				hiddenOnly: false,
				blurtRpcEndpoints: ['https://rpc.example'],
				hiddenRpcEndpoints: []
			})
		);
		if (policy !== null) handle = installHiddenServiceDispatcher(PROXIES, policy);
		await fetch(`http://${ONION}/`, { method: 'POST', body: '{}' }).catch(() => undefined);
		expect(lookups, 'the .onion name went to the system resolver').not.toContain(ONION);
		expect(clearnetRefused()).toBe(false);
	});
});
