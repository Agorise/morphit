/**
 * Lokinet is opt-in (v1.18.0 review, S3) — the decision itself.
 *
 * Lokinet has no proxy: a `.loki` name is resolved through the system
 * resolver, which on a box without lokinet is the ISP's. Every node used to
 * look `.loki` names up regardless — once a minute for the liveness check, and
 * for every `.loki` peer on each warm-up and send — so a tor-only home server
 * told its ISP it ran Morphit. No installer sets lokinet up, so the DEFAULT is
 * what almost every node gets, and the default is what this pins:
 *
 *   - nothing set                         → off;
 *   - this instance publishes a `.loki`    → on (publishing one is running one);
 *   - MORPHIT_INDEXER_LOKINET=on / off     → wins either way.
 *
 * The other tests take `lokinet` as a given config value; this is the only
 * place the environment is turned into that value.
 */
import { describe, it, expect } from 'vitest';
import { hiddenServiceProxyConfigFromEnv, lokinetEnabledFromEnv } from '@morphit/hidden-transport';

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe('whether this node looks up .loki names', () => {
	it('a node that set nothing does not — the case every installer-built node is in', () => {
		expect(lokinetEnabledFromEnv(env({}))).toBe(false);
		expect(hiddenServiceProxyConfigFromEnv(env({})).lokinet).toBe(false);
	});

	it('`auto` behaves exactly like unset', () => {
		expect(lokinetEnabledFromEnv(env({ MORPHIT_INDEXER_LOKINET: 'auto' }))).toBe(false);
		expect(
			lokinetEnabledFromEnv(
				env({ MORPHIT_INDEXER_LOKINET: 'auto', MORPHIT_INSTANCE_LOKINET_ADDRESS: 'abc.loki' })
			)
		).toBe(true);
	});

	it('an instance that publishes a .loki address runs lokinet, so it is on', () => {
		expect(lokinetEnabledFromEnv(env({ MORPHIT_INSTANCE_LOKINET_ADDRESS: 'abc.loki' }))).toBe(true);
		expect(lokinetEnabledFromEnv(env({ MORPHIT_INSTANCE_LOKINET_ADDRESS: '   ' }))).toBe(false);
	});

	it.each(['on', '1', 'true', 'yes', 'ON'])('%s switches it on without publishing', (v) => {
		expect(lokinetEnabledFromEnv(env({ MORPHIT_INDEXER_LOKINET: v }))).toBe(true);
	});

	it.each(['off', '0', 'false', 'no'])('%s switches it off even when publishing', (v) => {
		expect(
			lokinetEnabledFromEnv(
				env({ MORPHIT_INDEXER_LOKINET: v, MORPHIT_INSTANCE_LOKINET_ADDRESS: 'abc.loki' })
			)
		).toBe(false);
	});
});
