/**
 * The fees account from 1 November 2026 (by block time). While the configured
 * fees account is not registered on chain, the indexer then tells the site's
 * users to pay the whole fee to the Morphit treasury: /v1/instance's
 * `fee_recipient` is the treasury, and a LOCAL caller also gets
 * `configured_fee_recipient`. These tests drive:
 *   - the real localFeeView against a stand-in indexer (it must ask as a local
 *     caller to learn the configured account);
 *   - `morphit-ops status`: it must name the configured account as the
 *     unregistered one and say the fees go to the treasury, not that other
 *     instances hide the orders (true only before then);
 *   - the upgrade heal's one calm line, before and after.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalFeeView } from '../src/lib/operatorFeeRecipient.ts';

let fakeView: LocalFeeView | null | undefined;
vi.mock('../src/lib/operatorFeeRecipient.ts', async (orig) => {
	const real = (await orig()) as typeof import('../src/lib/operatorFeeRecipient.ts');
	return {
		...real,
		localFeeView: (...a: Parameters<typeof real.localFeeView>) =>
			fakeView === undefined ? real.localFeeView(...a) : Promise.resolve(fakeView)
	};
});
vi.mock('../src/init/chainCheck.ts', async (orig) => ({
	...((await orig()) as object),
	lookupBlurtAccount: async () => null
}));

const { localFeeView } = await import('../src/lib/operatorFeeRecipient.ts');
const { feesAccountStatus, runStatus } = await import('../src/commands/status.ts');
const { healFeeRecipientRegistration } = await import('../src/lib/feeRecipientHeal.ts');
const { CONSENSUS_V2_ACTIVATION_TIME } = await import(
	'../../indexer/src/indexer/consensusActivation.ts'
);
const ACT = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);

/** After 1 November: the configured account b-fees is unregistered. */
const AFTER: LocalFeeView = {
	feeRecipient: 'morphit-fees',
	configuredFeeRecipient: 'b-fees',
	registered: false,
	reportsRegistration: true
};
/** Before 1 November: the same account, still advertised. */
const BEFORE: LocalFeeView = { ...AFTER, feeRecipient: 'b-fees' };

let out = '';
let root = '';
beforeEach(() => {
	fakeView = undefined;
	out = '';
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
	vi.spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void (out += a.join(' ') + '\n')
	);
	root = mkdtempSync(join(tmpdir(), 'morphit-feerule-'));
	vi.stubEnv('MORPHIT_ENV_ROOT', root);
	vi.stubEnv('MORPHIT_BACKUP_DIR', join(root, 'backups'));
	vi.stubEnv('MORPHIT_RELAY_LISTEN_HOST', '127.0.0.1');
	vi.stubEnv('MORPHIT_RELAY_LISTEN_PORT', '1');
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("localFeeView reads the configured account as this node's local caller", () => {
	const servers: Server[] = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((sv) => new Promise((r) => sv.close(r))));
	});
	it('gets configured_fee_recipient, which the indexer serves only with x-morphit-local-health: 1', async () => {
		const sv = createServer((q, r) => {
			const local = q.headers['x-morphit-local-health'] === '1';
			r.setHeader('content-type', 'application/json');
			r.end(
				JSON.stringify({
					fee_recipient: 'morphit-fees',
					fee_recipient_registered: false,
					...(local ? { configured_fee_recipient: 'b-fees' } : {})
				})
			);
		});
		servers.push(sv);
		await new Promise<void>((r) => sv.listen(0, '127.0.0.1', r));
		const base = `http://127.0.0.1:${(sv.address() as AddressInfo).port}`;
		expect(await localFeeView({ bases: [base], timeoutMs: 4_000 })).toEqual(AFTER);
	});
});

describe('morphit-ops status: the fees account from 1 November', () => {
	it('names the configured account as the unregistered one, and says the fees go to the treasury', () => {
		const s = feesAccountStatus(AFTER);
		expect(s).toMatchObject({
			account: 'b-fees',
			paid_to: 'morphit-fees',
			registered: false,
			status: 'warn'
		});
		expect(s.note).toMatch(
			/^Your fees account @b-fees is not in your on-chain operator registration/
		);
		expect(s.note).toMatch(/whole to the Morphit treasury \(@morphit-fees\) instead/);
		expect(s.note).not.toMatch(/hide/);
		expect(s.note).toMatch(/run on this server: {2}sudo morphit-ops register$/);
	});

	it('an indexer that does not report the configured account: the one the service env files set', () => {
		mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
		writeFileSync(
			join(root, 'etc', 'morphit', 'indexer.env'),
			'MORPHIT_INDEXER_FEE_RECIPIENT=b-fees\n'
		);
		const s = feesAccountStatus({ ...AFTER, configuredFeeRecipient: null });
		expect(s.account).toBe('b-fees');
		expect(s.note).toMatch(/^Your fees account @b-fees /);
	});

	it('before 1 November: other instances hide the orders, and the coming rule is named', () => {
		const s = feesAccountStatus(BEFORE);
		expect(s).toMatchObject({ account: 'b-fees', paid_to: 'b-fees', status: 'warn' });
		expect(s.note).toMatch(
			/^@b-fees is not in your on-chain operator registration, so other Morphit instances hide/
		);
		expect(s.note).toMatch(/From 1 November 2026, until it is registered/);
	});

	const db = {
		query: async (text: string) =>
			text.includes('indexer_state')
				? { rows: [{ last_applied_block: '100', last_applied_at: new Date() }] }
				: { rows: [{ count: '0', pending: '0' }] }
	};
	const config = {
		relayAccount: 'alice-relay',
		signupDailyCeiling: 50,
		thresholds: {
			relayBalance: { warn: 100, error: 30, direction: 'lower_worse' },
			drainQueueAgeSec: { warn: 300, error: 3600, direction: 'higher_worse' },
			indexerLagBlocks: { warn: 5, error: 30, direction: 'higher_worse' },
			signupsPercentOfCeiling: { warn: 80, error: 100, direction: 'higher_worse' },
			abuseAlerts24h: { warn: 10, error: 50, direction: 'higher_worse' }
		}
	};
	const run = () => runStatus({ db, config, flags: {}, positional: [] } as never);

	it('the dashboard row: the fees go to the treasury until the configured account is registered', async () => {
		fakeView = AFTER;
		await run();
		const line = out.split('\n').find((l) => l.includes('BLURT fees go to:')) ?? '';
		expect(line).toMatch(
			/BLURT fees go to:\s+@morphit-fees\s+\[WARN\] the Morphit treasury, until your fees account @b-fees is registered on chain/
		);
		expect(out).not.toMatch(
			/@morphit-fees — not registered|@morphit-fees\s+\[WARN\] not registered/
		);
	});

	it('the dashboard row before 1 November: the configured account, not registered', async () => {
		fakeView = BEFORE;
		await run();
		expect(out).toMatch(/BLURT fees go to:\s+@b-fees\s+\[WARN\] not registered on chain/);
	});
});

describe('the upgrade heal’s calm line, by the 1-November rule', () => {
	const ENV = {
		account: 'bop',
		keyFile: '/k',
		instanceName: 'B market',
		origin: 'https://b.example',
		contactUrl: null,
		operatorTag: 'b-node',
		altAddresses: { tor: null, i2p_b32: null, i2p_name: null, lokinet: null, ens: null },
		feeRecipient: 'b-fees'
	};
	function deps(view: LocalFeeView | null, now: number) {
		const lines: string[] = [];
		return {
			lines,
			deps: {
				info: (l: string) => lines.push(l),
				warn: (l: string) => lines.push(l),
				spinner: () => () => {},
				env: () => ENV,
				localRegistration: async () =>
					({
						state: 'registered',
						tag: 'b-node',
						displayName: 'B market',
						contactUrl: null
					}) as const,
				localFeeView: async () => view,
				chainRegistration: async () => {
					if (view !== null) throw new Error('the indexer’s verdict must be used');
					return { found: true as const, trxId: 't', block: 5, feeRecipient: null, payload: {} };
				},
				acceptedRegistration: async () => ({
					state: 'ok' as const,
					source: "this node's indexer",
					payload: { v: 1, tag: 'b-node', display_name: 'B market' }
				}),
				loadKey: async () => {
					throw new Error('locked');
				},
				hiddenOnly: () => false,
				now: () => now,
				hardStopAt: Number.POSITIVE_INFINITY
			}
		};
	}

	it('after: says the fees go to the treasury (the indexer’s own verdict, read once)', async () => {
		const h = deps(AFTER, ACT - 86_400_000);
		expect(await healFeeRecipientRegistration(h.deps as never)).toBe('needs_operator');
		expect(h.lines).toHaveLength(1);
		expect(h.lines[0]).toMatch(
			/this site tells its users to pay their BLURT fees whole to the Morphit treasury, and you earn none/
		);
		expect(h.lines[0]).not.toMatch(/hide/);
	});

	it('before: other instances hide the orders, and from 1 November the fees go to the treasury', async () => {
		const h = deps(BEFORE, ACT - 86_400_000);
		expect(await healFeeRecipientRegistration(h.deps as never)).toBe('needs_operator');
		expect(h.lines[0]).toMatch(
			/other Morphit instances hide the orders your users pay to it, and from 1 November 2026/
		);
	});

	it('no indexer verdict: this server’s clock decides', async () => {
		const after = deps(null, ACT + 60_000);
		await healFeeRecipientRegistration(after.deps as never);
		expect(after.lines.at(-1)).toMatch(
			/pay their BLURT fees whole to the Morphit treasury, and you earn none/
		);
		const before = deps(null, ACT - 60_000);
		await healFeeRecipientRegistration(before.deps as never);
		expect(before.lines.at(-1)).toMatch(/other Morphit instances hide/);
	});
});
