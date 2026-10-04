/**
 * VT1-5 follow-up — GET /v1/account/:account/history answers a history page
 * too large for its request budget with a distinct 413 `reply_too_large`
 * ("ask for fewer entries"), never a 502 "could not reach the Blurt network"
 * and never a shorter page: the browser reads a short page as the start of
 * history, which would silently truncate the P&L export.
 *
 * The RPC fetch guard sizes a get_account_history reply from its `limit`
 * (hidden-transport rpcReplyBudget); an honest history of long non-Morphit
 * content can still exceed it, and every node would send the same.
 */
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { RpcReplyOverRequestBudgetError } from '@morphit/hidden-transport/rpc-fetch';
import { accountHistoryRoute } from '$api/accountHistory';
import { BlurtClient } from '$blurt/client';

const mount = (blurt: BlurtClient): Hono => {
	const app = new Hono();
	app.route('/v1/account', accountHistoryRoute(blurt));
	return app;
};
const stub = (callCondenser: () => Promise<unknown>): BlurtClient =>
	({ callCondenser }) as unknown as BlurtClient;

describe('account history: a reply over its budget (VT1-5)', () => {
	it('is a 413 reply_too_large, not a 502 and not a page', async () => {
		const res = await mount(
			stub(async () => {
				throw new RpcReplyOverRequestBudgetError('http://node.example', 8 * 1024 * 1024);
			})
		).request('/v1/account/alice/history?limit=1000');
		expect(res.status).toBe(413);
		const body = (await res.json()) as { code?: string; entries?: unknown };
		expect(body.code).toBe('reply_too_large');
		expect(body.entries).toBeUndefined();
	});

	it('a network failure is still a 502', async () => {
		const res = await mount(
			stub(async () => {
				throw new Error('fetch failed');
			})
		).request('/v1/account/alice/history');
		expect(res.status).toBe(502);
	});

	describe('end to end, through the real client and fetch guard', () => {
		const servers: http.Server[] = [];
		beforeAll(() => {
			process.env.MORPHIT_RPC_HEALTH_STATE = join(
				mkdtempSync(join(tmpdir(), 'hist413-')),
				'h.json'
			);
		});
		afterEach(async () => {
			await Promise.all(
				servers.splice(0).map(
					(s) =>
						new Promise<void>((r) => {
							s.closeAllConnections?.();
							s.close(() => r());
						})
				)
			);
		});
		/** A node answering get_account_history with ~9 MiB: over the 8 MiB a
		 *  one-entry page may return. Every honest node would send the same. */
		const node = (host: string): Promise<string> =>
			new Promise((resolve) => {
				const s = http.createServer((req, res) => {
					let body = '';
					req.on('data', (c) => (body += c));
					req.on('end', () => {
						const id = (JSON.parse(body) as { id?: unknown }).id ?? 0;
						const big = 'x'.repeat(9 * 1024 * 1024);
						res.writeHead(200, { 'content-type': 'application/json' });
						res.end(
							JSON.stringify({
								jsonrpc: '2.0',
								id,
								result: [[0, { op: ['comment', { body: big }] }]]
							})
						);
					});
				});
				servers.push(s);
				s.listen(0, host, () =>
					resolve(`http://${host}:${(s.address() as { port: number }).port}`)
				);
			});

		it('three nodes sending the same oversized page give a 413', { timeout: 30_000 }, async () => {
			const urls = await Promise.all(['127.0.0.71', '127.0.0.72', '127.0.0.73'].map(node));
			const blurt = new BlurtClient({
				blurtRpcEndpoints: urls,
				hiddenRpcEndpoints: [],
				localRpcEndpoints: []
			} as never);
			const res = await mount(blurt).request('/v1/account/alice/history?from=0&limit=1');
			expect(res.status).toBe(413);
			expect(((await res.json()) as { code?: string }).code).toBe('reply_too_large');
		});
	});
});
