/**
 * Block 4 waits until the nodes LIST the release transaction in @morphit's
 * account history before the ceremony moves on to the upgrades (morphit.io,
 * 2026-10-08: the v1.21.3 upgrade read one node's history right after the
 * broadcast, did not find the record, and refused; a minute later it went
 * through). See scripts/lib/historyListing.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { historyLists, waitForHistoryListing } from '../../scripts/lib/historyListing';

const TRX = 'ab'.repeat(20);
const entry = (trx: string) => [7, { trx_id: trx, block: 1, op: ['custom_json', {}] }];

function clock() {
	let t = 0;
	return { now: () => t, sleep: async (ms: number) => void (t += ms), at: () => t };
}

describe('waiting for the release record to be listed', () => {
	it('keeps asking until every node that answers lists it', async () => {
		const c = clock();
		const lagging = new Map([
			['https://a', 0],
			['https://b', 3]
		]);
		let rounds = 0;
		const r = await waitForHistoryListing({
			nodes: ['https://a', 'https://b'],
			account: 'morphit',
			trxId: TRX,
			now: c.now,
			sleep: c.sleep,
			log: () => undefined,
			call: async (url) => {
				if (url === 'https://a') rounds++;
				return rounds > (lagging.get(url) ?? 0) ? [entry(TRX)] : [entry('cd'.repeat(20))];
			}
		});
		expect(r.complete).toBe(true);
		expect(r.listed.sort()).toEqual(['https://a', 'https://b']);
		expect(rounds, 'it stopped while node b still did not list it').toBeGreaterThanOrEqual(4);
	});

	it('a node that never answers is not waited for; one that answered and lags is', async () => {
		const c = clock();
		const r = await waitForHistoryListing({
			nodes: ['https://up', 'https://down', 'https://behind'],
			account: 'morphit',
			trxId: TRX,
			waitMs: 60_000,
			now: c.now,
			sleep: c.sleep,
			log: () => undefined,
			call: async (url) => {
				if (url === 'https://down') throw new Error('unreachable');
				return url === 'https://up' ? [entry(TRX)] : [];
			}
		});
		expect(r.complete).toBe(false);
		expect(r.notListed).toEqual(['https://behind']);
		expect(r.silent).toEqual(['https://down']);
		expect(
			c.at(),
			'it gave up early on a node that answers without the record'
		).toBeGreaterThanOrEqual(55_000);
	});

	it('a node that answered without it and then stops answering is still waited for', async () => {
		const c = clock();
		let flakyCalls = 0;
		const r = await waitForHistoryListing({
			nodes: ['https://up', 'https://flaky'],
			account: 'morphit',
			trxId: TRX,
			waitMs: 30_000,
			now: c.now,
			sleep: c.sleep,
			log: () => undefined,
			call: async (url) => {
				if (url === 'https://up') return [entry(TRX)];
				if (flakyCalls++ === 0) return [];
				throw new Error('timeout');
			}
		});
		expect(r.complete, 'a node seen without the record counted as done once it went quiet').toBe(
			false
		);
		expect(r.notListed).toEqual(['https://flaky']);
	});

	// v1.21.4 review (B1): a node that listed it and then stopped answering was
	// waited for until the end, and Block 4 ended without "Block 5 can start".
	it('a node that listed it and then stops answering counts as listing it', async () => {
		const c = clock();
		let round = 0;
		const r = await waitForHistoryListing({
			nodes: ['https://a', 'https://b'],
			account: 'morphit',
			trxId: TRX,
			waitMs: 120_000,
			now: c.now,
			sleep: c.sleep,
			log: () => undefined,
			call: async (url) => {
				if (url === 'https://a') {
					round++;
					if (round === 1) return [entry(TRX)];
					throw new Error('timeout');
				}
				return round >= 3 ? [entry(TRX)] : [];
			}
		});
		expect(r.complete, 'a node that already listed it was waited for again').toBe(true);
		expect(r.listed.sort()).toEqual(['https://a', 'https://b']);
		expect(c.at()).toBeLessThan(120_000);
	});

	it('reads the transaction id, not a version string the history might echo', () => {
		expect(historyLists([entry(TRX)], TRX)).toBe(true);
		expect(historyLists([entry('00'.repeat(20))], TRX)).toBe(false);
		expect(historyLists(null, TRX)).toBe(false);
	});
});

describe('release-broadcast waits for the listing after it broadcasts', () => {
	it('main() calls waitForHistoryListing with the broadcast transaction id, after the broadcast', () => {
		const file = join(__dirname, '..', '..', 'scripts', 'release-broadcast.ts');
		const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		const calls: Array<{ name: string; pos: number; text: string }> = [];
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n)) {
				const name = n.expression.getText(sf);
				if (name === 'broadcastCustomJsonOnce' || name === 'waitForHistoryListing')
					calls.push({ name, pos: n.getStart(sf), text: n.getText(sf) });
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
		const send = calls.find((c) => c.name === 'broadcastCustomJsonOnce');
		const wait = calls.find((c) => c.name === 'waitForHistoryListing');
		expect(send, 'no broadcast call').toBeDefined();
		expect(wait, 'Block 4 moves on without waiting for the history listing').toBeDefined();
		expect(wait!.pos).toBeGreaterThan(send!.pos);
		expect(wait!.text).toMatch(/trxId:\s*res\.trxId/);
	});
});
