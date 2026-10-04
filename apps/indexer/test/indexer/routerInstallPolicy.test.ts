/**
 * Every indexer installs the router.
 *
 * The router was installed only when hidden RPC endpoints were CONFIGURED. Two
 * configurations were left without one:
 *   - a clearnet node with MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS blank still
 *     merges `.onion`/`.i2p` nodes from the on-chain RPC directory into its pool
 *     (at boot and at runtime), and with no router those names went to the
 *     system resolver — the ISP's;
 *   - a node reading the chain only from a co-located blurtd (both lists blank)
 *     is hidden-only by every other rule in the indexer (price, peer monitor),
 *     but with no router `clearnetRefused()` was false, so the probe, chat and
 *     FX sources went to clearnet from the box's own address.
 *
 * Asserted at the real resolver: `dns.lookup` is counted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dns from 'node:dns';
import {
	indexerRouterPolicy,
	installHiddenServiceDispatcher,
	clearnetRefused,
	type HiddenDispatcherHandle
} from '$indexer/hiddenServiceDispatcher';

const ONION = `${'a'.repeat(56)}.onion`;
const PROXIES = { torSocks: '127.0.0.1:1', i2pHttpProxy: '127.0.0.1:1', lokinet: false };

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

/** What main.ts does with the decision. */
function boot(config: { blurtRpcEndpoints: string[]; hiddenRpcEndpoints: string[] }): void {
	const policy = indexerRouterPolicy(config);
	if (policy !== null) handle = installHiddenServiceDispatcher(PROXIES, policy);
}

describe('L3 — the router is installed wherever a hidden name can reach the pool', () => {
	it('a clearnet node with no hidden endpoints configured never resolves a directory .onion', async () => {
		boot({ blurtRpcEndpoints: ['https://rpc.example'], hiddenRpcEndpoints: [] });
		await fetch(`http://${ONION}/`, { method: 'POST', body: '{}' }).catch(() => undefined);
		expect(lookups, 'the .onion name went to the system resolver').not.toContain(ONION);
		expect(clearnetRefused(), 'a clearnet node must keep clearnet').toBe(false);
	});

	it('a local-blurtd-only node is hidden-only: clearnet refused, no lookup', async () => {
		boot({ blurtRpcEndpoints: [], hiddenRpcEndpoints: [] });
		expect(clearnetRefused()).toBe(true);
		await fetch('https://fx.example/rates').catch(() => undefined);
		expect(lookups).not.toContain('fx.example');
	});

	it('a hidden-only node is unchanged: refuse', () => {
		expect(
			indexerRouterPolicy({ blurtRpcEndpoints: [], hiddenRpcEndpoints: [`http://${ONION}`] })
		).toBe('refuse');
	});
	it('a mixed node is unchanged: allow', () => {
		expect(
			indexerRouterPolicy({
				blurtRpcEndpoints: ['https://rpc.example'],
				hiddenRpcEndpoints: [`http://${ONION}`]
			})
		).toBe('allow');
	});
});
