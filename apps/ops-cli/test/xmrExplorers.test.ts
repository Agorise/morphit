/**
 * v1.20.0 (wave 4) — the wizard's XMR fee explorers: the same three defaults
 * as the indexer (checked live 2026-09-28), `raw-tx+https://…` accepted for
 * XMR only, and a raw-tx explorer probed on moneroblocks.info's /api/get_stats.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_XMR_FEE_EXPLORERS, parseExplorerUrlList } from '../src/init/steps.ts';
import { probeMoneroExplorer } from '../src/init/explorerHealth.ts';
import { DEFAULT_XMR_EXPLORERS as INDEXER_DEFAULT_XMR_EXPLORERS } from '../../indexer/src/config/xmrExplorers.ts';

describe('XMR fee explorers in the wizard', () => {
	it("defaults to the indexer's list (v1.20.2: three explorers + three public nodes)", () => {
		expect(DEFAULT_XMR_FEE_EXPLORERS).toEqual([...INDEXER_DEFAULT_XMR_EXPLORERS]);
		expect(DEFAULT_XMR_FEE_EXPLORERS).toEqual([
			'https://xmrchain.net',
			'https://moneroexplorer.org',
			'raw-tx+https://moneroblocks.info',
			'node+https://xmr-node.cakewallet.com:18081',
			'node+https://node.monero.fail',
			'node+https://xmr.cryptostorm.is'
		]);
	});
	it('(v1.20.2) accepts node+https:// for XMR, never cleartext, never for BTC', () => {
		expect(
			parseExplorerUrlList('node+https://node.monero.fail,https://xmrchain.net', {
				allowRawTx: true
			})
		).toEqual(['node+https://node.monero.fail', 'https://xmrchain.net']);
		expect(typeof parseExplorerUrlList('node+https://node.monero.fail')).toBe('string');
		expect(
			typeof parseExplorerUrlList('node+http://node.example:18081', { allowRawTx: true })
		).toBe('string');
	});
	it('(v1.20.2) probes a node on /get_height (the live answer of 2026-10-01)', async () => {
		const asked: string[] = [];
		const live = {
			hash: 'e5ac88caf64523c5451f6b2ce93ec0304b75cf0c4035dd51ddbd2946e073dac0',
			height: 3774747,
			status: 'OK',
			untrusted: false
		};
		const f = (async (u: Parameters<typeof fetch>[0]) => {
			asked.push(String(u));
			return new Response(JSON.stringify(live), { status: 200 });
		}) as typeof fetch;
		expect(await probeMoneroExplorer('node+https://node.monero.fail', f)).toMatchObject({
			kind: 'ok'
		});
		expect(asked).toEqual(['https://node.monero.fail/get_height']);
		const syncing = (async () =>
			new Response(JSON.stringify({ ...live, untrusted: true }), { status: 200 })) as typeof fetch;
		expect(await probeMoneroExplorer('node+https://node.example', syncing)).toMatchObject({
			kind: 'wrong_shape',
			reason: 'the node is still syncing (untrusted)'
		});
	});
	it('accepts raw-tx+https:// only where asked (XMR), never cleartext', () => {
		expect(
			parseExplorerUrlList('raw-tx+https://moneroblocks.info,https://xmrchain.net', {
				allowRawTx: true
			})
		).toEqual(['raw-tx+https://moneroblocks.info', 'https://xmrchain.net']);
		expect(typeof parseExplorerUrlList('raw-tx+https://moneroblocks.info')).toBe('string');
		expect(
			typeof parseExplorerUrlList('raw-tx+http://moneroblocks.info', { allowRawTx: true })
		).toBe('string');
	});
	it('probes a raw-tx explorer on /api/get_stats', async () => {
		const asked: string[] = [];
		const f = (async (u: Parameters<typeof fetch>[0]) => {
			asked.push(String(u));
			return new Response(JSON.stringify({ difficulty: 1, height: 3772527 }), { status: 200 });
		}) as typeof fetch;
		expect(await probeMoneroExplorer('raw-tx+https://moneroblocks.info', f)).toMatchObject({
			kind: 'ok'
		});
		expect(asked).toEqual(['https://moneroblocks.info/api/get_stats']);
	});
});
