/**
 * v1.20.0 — "2 or more would be ideal and reduce the amount of trust that
 * we have to give to those explorers". An XMR fee is verified only when at
 * least TWO independent explorers agree, unless the operator says otherwise.
 * An instance whose own list has only one explorer keeps a quorum of 1 (a
 * quorum of 2 could never be met there and the indexer would refuse to boot),
 * with a calm boot line saying why.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, resolveXmrQuorum } from '../../src/config/index';
import { DEFAULT_MONERO_PROOF_VERIFIER_CONFIG } from '../../src/indexer/fee/moneroProofVerifier';

const BASE: Record<string, string> = {
	MORPHIT_INDEXER_DATABASE_URL: 'postgres://u:p@localhost:5432/morphit_indexer',
	MORPHIT_INDEXER_RELAY_ACCOUNT: 'tester',
	MORPHIT_INDEXER_FEE_RECIPIENT: 'tester',
	MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
	MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY: 'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
	MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f'
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	for (const k of Object.keys(process.env)) if (k.startsWith('MORPHIT_')) delete process.env[k];
	Object.assign(process.env, BASE);
});
afterEach(() => {
	process.env = saved;
});

function load(extra: Record<string, string> = {}): {
	cfg: ReturnType<typeof loadConfig>;
	warned: string[];
} {
	Object.assign(process.env, extra);
	const warned: string[] = [];
	const orig = console.warn;
	console.warn = (...a: unknown[]): void => {
		warned.push(a.map(String).join(' '));
	};
	try {
		return { cfg: loadConfig(), warned };
	} finally {
		console.warn = orig;
	}
}

describe('XMR explorer quorum', () => {
	it('defaults to 2 agreeing explorers with the default list', () => {
		const { cfg, warned } = load();
		expect(cfg.xmrExplorerUrls.length).toBeGreaterThanOrEqual(2);
		expect(cfg.xmrMinSuccessfulResponses).toBe(2);
		expect(warned.filter((w) => w.includes('XMR_MIN_SUCCESSFUL_RESPONSES'))).toEqual([]);
	});
	it('the verifier module default is 2 as well', () => {
		expect(DEFAULT_MONERO_PROOF_VERIFIER_CONFIG.minSuccessfulResponses).toBe(2);
	});
	it('an operator list with ONE explorer boots with quorum 1 and says why (no crash)', () => {
		const { cfg, warned } = load({ MORPHIT_INDEXER_XMR_EXPLORER_URLS: 'https://xmrchain.net' });
		expect(cfg.xmrMinSuccessfulResponses).toBe(1);
		expect(warned.some((w) => w.includes('XMR_MIN_SUCCESSFUL_RESPONSES'))).toBe(true);
	});
	it('an explicit value is honoured (1 or 3)', () => {
		expect(
			load({ MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES: '1' }).cfg.xmrMinSuccessfulResponses
		).toBe(1);
		expect(
			load({ MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES: '3' }).cfg.xmrMinSuccessfulResponses
		).toBe(3);
	});
	it('an explicit value above the list length still refuses to boot', () => {
		expect(() =>
			load({
				MORPHIT_INDEXER_XMR_EXPLORER_URLS: 'https://xmrchain.net',
				MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES: '2'
			})
		).toThrow(/Quorum can never be met/);
	});
	it('resolveXmrQuorum: unset → min(2, list length), never below 1', () => {
		expect(resolveXmrQuorum(undefined, 3).value).toBe(2);
		expect(resolveXmrQuorum(undefined, 2).value).toBe(2);
		expect(resolveXmrQuorum(undefined, 1).value).toBe(1);
		expect(resolveXmrQuorum(undefined, 0).value).toBe(1);
		expect(resolveXmrQuorum(3, 5).value).toBe(3);
	});
});
