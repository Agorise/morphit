/**
 * Empty fee-address lines in an installed node's env files no longer turn its
 * BTC/XMR fees off after the upgrade.
 * Real files under a scratch MORPHIT_ENV_ROOT.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	commentEmptyFeeAddressLines,
	healEmptyFeeAddressLines,
	realFeeAddressRuntime,
	verifyFeeAddressHeal
} from '../src/lib/feeAddressEmptyHeal.ts';

const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
let root = '';
const etcEnv = (): string => join(root, 'etc/morphit/indexer.env');
const optEnv = (): string => join(root, 'opt/morphit/morphit.env');

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-fee-addr-'));
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	mkdirSync(join(root, 'opt/morphit'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** What the indexer would see: the env files sourced in order, last wins. */
function effective(key: string): string | undefined {
	let v: string | undefined;
	for (const f of [optEnv(), join(root, 'opt/morphit/morphit.config.env'), etcEnv()]) {
		let text = '';
		try {
			text = readFileSync(f, 'utf8');
		} catch {
			continue;
		}
		for (const line of text.split('\n')) {
			const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
			if (m && m[1] === key) v = m[2]!.trim().replace(/^["']|["']$/g, '');
		}
	}
	return v;
}

describe('empty fee-address lines', () => {
	it('are commented out once, owner/mode kept, so the method is no longer forced off', async () => {
		writeFileSync(
			etcEnv(),
			'MORPHIT_INDEXER_DATABASE_URL=postgres://x\nMORPHIT_INDEXER_BTC_FEE_ADDRESS=\nexport MORPHIT_INDEXER_XMR_FEE_ADDRESS=""\n',
			{ mode: 0o640 }
		);
		chmodSync(etcEnv(), 0o640);
		expect(effective('MORPHIT_INDEXER_BTC_FEE_ADDRESS')).toBe('');
		const r = await healEmptyFeeAddressLines(ctx, realFeeAddressRuntime(root));
		expect(r.strategy, r.detail).toBe('commented');
		expect(effective('MORPHIT_INDEXER_BTC_FEE_ADDRESS')).toBeUndefined();
		expect(effective('MORPHIT_INDEXER_XMR_FEE_ADDRESS')).toBeUndefined();
		expect(effective('MORPHIT_INDEXER_DATABASE_URL')).toBe('postgres://x');
		expect(statSync(etcEnv()).mode & 0o777).toBe(0o640);
		expect(readFileSync(etcEnv(), 'utf8')).toMatch(/Uncomment it to turn BTC fees off/);
	});

	it('an operator who sets = on purpose after the heal is never rewritten', async () => {
		writeFileSync(etcEnv(), 'MORPHIT_INDEXER_BTC_FEE_ADDRESS=\n');
		await healEmptyFeeAddressLines(ctx, realFeeAddressRuntime(root));
		writeFileSync(etcEnv(), 'MORPHIT_INDEXER_BTC_FEE_ADDRESS=\n');
		const again = await healEmptyFeeAddressLines(ctx, realFeeAddressRuntime(root));
		expect(again.strategy).toBe('already-marked');
		expect(effective('MORPHIT_INDEXER_BTC_FEE_ADDRESS')).toBe('');
	});

	it('a box without such lines is only marked; a set address is untouched', async () => {
		writeFileSync(optEnv(), 'MORPHIT_INDEXER_BTC_FEE_ADDRESS=bc1qexample\n');
		const r = await healEmptyFeeAddressLines(ctx, realFeeAddressRuntime(root));
		expect(r.strategy).toBe('not-present');
		expect(r.detail).toBe('');
		expect(effective('MORPHIT_INDEXER_BTC_FEE_ADDRESS')).toBe('bc1qexample');
	});

	it('a file it cannot write: says the exact line, and tries again next time', async () => {
		const rt = { ...realFeeAddressRuntime(root), write: () => false };
		writeFileSync(etcEnv(), 'MORPHIT_INDEXER_XMR_FEE_ADDRESS=\n');
		const r = await healEmptyFeeAddressLines(ctx, rt);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/MORPHIT_INDEXER_XMR_FEE_ADDRESS=/);
		expect(realFeeAddressRuntime(root).markerText()).toBeNull();
	});

	it('leaves comments and other keys alone (pure)', () => {
		const t = '# MORPHIT_INDEXER_BTC_FEE_ADDRESS=\nMORPHIT_INDEXER_BTC_FEE_SATOSHIS=\n';
		expect(commentEmptyFeeAddressLines(t)).toEqual({ text: t, methods: [] });
	});

	it('after the restart: checks the running indexer shows the addresses (clearnet only)', async () => {
		const marker = () => 'fee-address-empty-v1\nmethods=BTC,XMR\n';
		const ok = await verifyFeeAddressHeal(ctx, {
			markerText: marker,
			hiddenOnly: () => false,
			instance: async () => ({ treasury: { btc: 'bc1q', xmr: '4abc' } })
		});
		expect(ok.verified).toBe(true);
		const off = await verifyFeeAddressHeal(ctx, {
			markerText: marker,
			hiddenOnly: () => false,
			instance: async () => ({ treasury: { btc: 'bc1q', xmr: null } })
		});
		expect(off.verified).toBe(false);
		expect(off.detail).toMatch(/XMR/);
		let asked = false;
		const hidden = await verifyFeeAddressHeal(ctx, {
			markerText: marker,
			hiddenOnly: () => true,
			instance: async () => ((asked = true), null)
		});
		expect(hidden.verified).toBe(true);
		expect(asked).toBe(false);
	});

	it('when the indexer does not answer, the later check uses the port the indexer listens on', async () => {
		const marker = () => 'fee-address-empty-v1\nmethods=BTC\n';
		const configured = await verifyFeeAddressHeal(ctx, {
			markerText: marker,
			hiddenOnly: () => false,
			instance: async () => null,
			bases: () => ['http://127.0.0.1:9099', 'http://127.0.0.1:8081']
		});
		expect(configured.verified).toBe(false);
		expect(configured.detail).toContain('curl -s http://127.0.0.1:9099/v1/instance');
		const standard = await verifyFeeAddressHeal(ctx, {
			markerText: marker,
			hiddenOnly: () => false,
			instance: async () => null
		});
		expect(standard.detail).toContain('curl -s http://127.0.0.1:8081/v1/instance');
		expect(standard.detail).not.toMatch(/:3000\b/);
	});
});
