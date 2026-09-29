/**
 * v1.20.0 (MK-H2, V3-5 / V3-6) — asking another instance which fee address it
 * gave an order. A node that numbered differently (a forged block from a
 * hostile RPC, a stale pin) would otherwise send the payer to someone else's
 * address with nobody noticing. Peers come from the federation directory;
 * hidden addresses go over the hidden transport, and a hidden-only node never
 * dials clearnet.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	installHiddenServiceDispatcher,
	type HiddenDispatcherHandle
} from '@morphit/hidden-transport/router';

import { crossCheckBtcFee } from '$indexer/fee/btcFeeCrossCheck';

const local = { index: 5, address: 'bc1qlocal', xpub: 'xpubA' };
const peer = (origin: string, hidden = false) => ({ origin, hidden });

function fetcher(answers: Record<string, unknown>, asked: string[] = []) {
	return async (url: string): Promise<unknown> => {
		asked.push(url);
		const a = answers[new URL(url).origin];
		if (a === undefined || a instanceof Error) throw a ?? new Error('unreachable');
		return a;
	};
}

describe('BTC fee address cross-check', () => {
	let installed: HiddenDispatcherHandle | null = null;
	afterEach(async () => {
		await installed?.uninstall();
		installed = null;
	});

	it('agrees when a peer numbered the order the same way', async () => {
		const asked: string[] = [];
		const r = await crossCheckBtcFee({
			local,
			account: 'alice',
			permlink: 'a1',
			peers: [peer('https://b.example'), peer('https://c.example')],
			fetchJson: fetcher(
				{ 'https://b.example': { index: 5, address: 'bc1qlocal', xpub: 'xpubA' } },
				asked
			)
		});
		expect(r).toEqual({ verdict: 'agree', asked: 2, agreeing: 1 });
		expect(asked[0]).toBe('https://b.example/v1/orders/alice/a1/btc-fee');
	});

	it('disagrees when any answering peer has another index or address', async () => {
		const r = await crossCheckBtcFee({
			local,
			account: 'alice',
			permlink: 'a1',
			peers: [peer('https://b.example'), peer('https://c.example')],
			fetchJson: fetcher({
				'https://b.example': { index: 5, address: 'bc1qlocal', xpub: 'xpubA' },
				'https://c.example': { index: 6, address: 'bc1qother', xpub: 'xpubA' }
			})
		});
		expect(r.verdict).toBe('disagree');
	});

	it('is "unchecked" (not a disagreement) when no peer can answer', async () => {
		const r = await crossCheckBtcFee({
			local,
			account: 'alice',
			permlink: 'a1',
			peers: [peer('https://b.example')],
			fetchJson: fetcher({})
		});
		expect(r).toEqual({ verdict: 'unchecked', asked: 1, agreeing: 0 });
	});

	it('a hidden-only node never dials a clearnet peer', async () => {
		installed = installHiddenServiceDispatcher(
			{ torSocks: '127.0.0.1:1', i2pHttpProxy: '127.0.0.1:1' } as never,
			'refuse'
		);
		const asked: string[] = [];
		const r = await crossCheckBtcFee({
			local,
			account: 'alice',
			permlink: 'a1',
			peers: [
				peer('https://b.example'),
				peer('http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion', true)
			],
			fetchJson: fetcher(
				{
					'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion': {
						index: 5,
						address: 'bc1qlocal',
						xpub: 'xpubA'
					}
				},
				asked
			)
		});
		expect(asked.every((u) => u.includes('.onion'))).toBe(true);
		expect(r.verdict).toBe('agree');
	});
});
