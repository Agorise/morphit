/**
 * v1.20.0 (wave 4) — the wizard's XMR fee explorers: the same three defaults
 * as the indexer (checked live 2026-09-28), `raw-tx+https://…` accepted for
 * XMR only, and a raw-tx explorer probed on moneroblocks.info's /api/get_stats.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_XMR_FEE_EXPLORERS, parseExplorerUrlList } from '../src/init/steps.ts';
import { probeMoneroExplorer } from '../src/init/explorerHealth.ts';

describe('XMR fee explorers in the wizard', () => {
	it("defaults to the indexer's three", () => {
		expect(DEFAULT_XMR_FEE_EXPLORERS).toEqual([
			'https://xmrchain.net',
			'https://moneroexplorer.org',
			'raw-tx+https://moneroblocks.info'
		]);
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
