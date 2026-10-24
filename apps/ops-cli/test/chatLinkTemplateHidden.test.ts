/**
 * v1.21.15 — an operator's explorer link template may use plain http:// only
 * to a Tor v3 onion or an I2P host (what a hidden site links to); https://
 * anywhere. The wizard, the indexer's config check and the browser's
 * re-check give the same verdict on every template.
 */
import { describe, expect, it } from 'vitest';

import { chatLinkTemplateAccepted, parseChatLinkTemplate } from '../src/init/steps.ts';
import { probeChatLinkExplorer } from '../src/init/explorerHealth.ts';
import { isValidChatLinkTemplate as indexerValid } from '../../indexer/src/config/chatLinkTemplate.ts';
import { isValidChatLinkTemplate as webValid } from '../../web/src/lib/explorer/urlsCore.ts';

// What the wizard's edit loop decides (it used to accept only https://).
const wizardValid = (t: string): boolean => chatLinkTemplateAccepted(t, parseChatLinkTemplate(t));

const ONION = 'mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion';
const CASES: Array<[string, boolean]> = [
	['https://mempool.space/tx/{txid}', true],
	[`http://${ONION}/tx/{txid}`, true],
	[`https://${ONION}/tx/{txid}`, true],
	['http://44naenfnp6foaegpmujdn4pmhtgo52tjkgs2d3ir2wo7d7mfbufq.b32.i2p/tx/{txid}', true],
	['http://xmr.kisu.i2p/tx/{txid}', true],
	['http://mempool.space/tx/{txid}', false],
	['http://expyuzz4wqqyqhjn.onion/tx/{txid}', false], // a retired v2 onion
	['http://onion.example/tx/{txid}', false],
	['http://i2p/tx/{txid}', false],
	[`http://u:p@${ONION}/tx/{txid}`, false],
	[`http://${ONION}/tx/`, false],
	['ftp://xmr.kisu.i2p/tx/{txid}', false],
	['javascript:alert(1)//{txid}', false]
];

describe('chat-link templates to hidden explorers', () => {
	for (const [tpl, ok] of CASES) {
		it(`${ok ? 'accepts' : 'rejects'} ${tpl}`, () => {
			expect(wizardValid(tpl)).toBe(ok);
			expect(indexerValid(tpl)).toBe(ok);
			expect(webValid(tpl)).toBe(ok);
		});
	}
});

describe('the wizard never probes a hidden explorer link', () => {
	for (const tpl of [
		`http://${ONION}/tx/{txid}`,
		`https://${ONION}/tx/{txid}`,
		'http://xmr.kisu.i2p/tx/{txid}',
		'https://short.onion/tx/{txid}',
		`https://${ONION}./tx/{txid}`,
		'https://x.loki/tx/{txid}'
	]) {
		it(`skips ${tpl} — no fetch, so no name reaches the system resolver`, async () => {
			let fetched = 0;
			const r = await probeChatLinkExplorer(tpl, (async () => {
				fetched++;
				return new Response(null, { status: 200 });
			}) as unknown as typeof fetch);
			expect(r).toEqual({ kind: 'hidden_not_probed' });
			expect(fetched).toBe(0);
		});
	}
	it('still probes a clearnet link', async () => {
		let fetched = 0;
		await probeChatLinkExplorer('https://mempool.space/tx/{txid}', (async () => {
			fetched++;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch);
		expect(fetched).toBe(1);
	});
});

describe('the wizard never follows a redirect to a hidden address (v1.21.15 review)', () => {
	it('a clearnet explorer answering 302 to an .onion: not followed, so the name is never resolved', async () => {
		const asked: string[] = [];
		const r = await probeChatLinkExplorer('https://mempool.space/tx/{txid}', (async (
			u: string,
			init?: RequestInit
		) => {
			asked.push(String(u));
			expect(init?.redirect).toBe('manual');
			return new Response(null, { status: 302, headers: { location: `https://${ONION}/` } });
		}) as unknown as typeof fetch);
		expect(asked).toEqual(['https://mempool.space/']);
		expect(r.kind).not.toBe('unreachable');
	});
	it('a clearnet redirect to another clearnet host is still followed', async () => {
		const asked: string[] = [];
		await probeChatLinkExplorer('https://old.example/tx/{txid}', (async (u: string) => {
			asked.push(String(u));
			return String(u).startsWith('https://old.example')
				? new Response(null, { status: 301, headers: { location: 'https://new.example/' } })
				: new Response(null, { status: 200 });
		}) as unknown as typeof fetch);
		expect(asked).toEqual(['https://old.example/', 'https://new.example/']);
	});
});
