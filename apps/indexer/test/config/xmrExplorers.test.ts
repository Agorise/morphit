/**
 * v1.20.0 (wave 4) — the XMR explorer list: the default is the three
 * explorers checked live on 2026-09-28 (two txprove, one raw-tx), and the list
 * accepts `raw-tx+https://…` while still refusing anything not HTTPS. The
 * config's zod default and refine use exactly these (config/index.ts).
 * v1.20.2: plus three public Monero nodes (`node+https://…`, checked live
 * 2026-10-01).
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_XMR_EXPLORERS, parseXmrExplorerList } from '../../src/config/xmrExplorers';
import { DEFAULT_MONERO_PROOF_VERIFIER_CONFIG } from '../../src/indexer/fee/moneroProofVerifier';

describe('XMR explorer list', () => {
	it('defaults to xmrchain.net, moneroexplorer.org (txprove), moneroblocks.info (raw-tx) and three public nodes', () => {
		expect(DEFAULT_XMR_EXPLORERS).toEqual([
			'https://xmrchain.net',
			'https://moneroexplorer.org',
			'raw-tx+https://moneroblocks.info',
			'node+https://xmr-node.cakewallet.com:18081',
			'node+https://node.monero.fail',
			'node+https://xmr.cryptostorm.is'
		]);
		expect(DEFAULT_MONERO_PROOF_VERIFIER_CONFIG.explorerUrls).toEqual(DEFAULT_XMR_EXPLORERS);
		expect(DEFAULT_XMR_EXPLORERS.join(',')).not.toMatch(/localmonero|monerohash|exploremonero/);
	});
	it('accepts raw-tx+https and refuses cleartext of either kind', () => {
		expect(
			parseXmrExplorerList(' raw-tx+https://moneroblocks.info , https://xmrchain.net ')
		).toEqual(['raw-tx+https://moneroblocks.info', 'https://xmrchain.net']);
		expect(parseXmrExplorerList('raw-tx+http://moneroblocks.info')).toBeNull();
		expect(parseXmrExplorerList('node+https://node.monero.fail')).toEqual([
			'node+https://node.monero.fail'
		]);
		expect(parseXmrExplorerList('node+http://node.example:18081')).toBeNull();
		expect(parseXmrExplorerList('https://xmrchain.net,http://x.example')).toBeNull();
	});
});
