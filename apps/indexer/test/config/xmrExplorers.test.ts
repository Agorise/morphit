/**
 * v1.20.0 (wave 4) — the XMR explorer list: the default is the three
 * explorers checked live on 2026-09-28 (two txprove, one raw-tx), and the list
 * accepts `raw-tx+https://…` while still refusing anything not HTTPS. The
 * config's zod default and refine use exactly these (config/index.ts).
 * v1.20.2: plus three public Monero nodes (`node+https://…`, checked live
 * 2026-10-01). v1.20.3: two onion xmrblocks explorers FIRST (answered
 * /api/networkinfo over Tor, 2026-10-02); `http://` is accepted for a
 * .onion / .i2p host only.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_XMR_EXPLORERS, parseXmrExplorerList } from '../../src/config/xmrExplorers';
import { DEFAULT_MONERO_PROOF_VERIFIER_CONFIG } from '../../src/indexer/fee/moneroProofVerifier';

describe('XMR explorer list', () => {
	it('defaults to two onion explorers, then xmrchain.net, moneroexplorer.org (txprove), moneroblocks.info (raw-tx) and three public nodes', () => {
		expect(DEFAULT_XMR_EXPLORERS).toEqual([
			'http://xmrexplrthytnunr4jasr3vnjc6jo5idsyxzv74a7ep7dy7lwcv2eoyd.onion',
			'http://nklwsomtuok6dhqqecp3a26xzgokfgmeuaplcdkaxehncg57yzarvbad.onion',
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
	it('accepts http:// for a v3 onion or an I2P name only (the network encrypts end to end)', () => {
		const onion = `http://${'a'.repeat(56)}.onion`;
		expect(parseXmrExplorerList(`${onion},node+${onion}:18089`)).toEqual([
			onion,
			`node+${onion}:18089`
		]);
		expect(parseXmrExplorerList(`http://${'b'.repeat(52)}.b32.i2p`)).not.toBeNull();
		expect(parseXmrExplorerList('http://short.onion')).toBeNull();
		expect(parseXmrExplorerList(`http://u:p@${'a'.repeat(56)}.onion`)).toBeNull();
	});
});
