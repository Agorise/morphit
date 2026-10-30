/**
 * `morphit-ops status` (menu: Status dashboard), review 2026-10-29:
 *  - M6: the menu promises the relay balance and puts "⚠ relay balance low" on
 *    this item, yet the dashboard never showed it;
 *  - M7: "Today: N / 50" — the relay's limit lives in /etc/morphit/relay.env
 *    (20 on an Ansible install), which the dashboard never read;
 *  - M8: a row without a status glyph lost its detail (the pending-transfer
 *    breakdown, the welcome-bonus total), and delegations were not counted;
 *  - M9: "Failed broadcasts 24h" counted rows that went out after all or only
 *    await confirmation, graded on the abuse scale (✓ up to 9);
 *  - L3/L11: commands without sudo / machine; a footer promising --json "on
 *    any command"; the web-heal row repeating its value in its detail.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();
vi.mock('../src/init/chainCheck.ts', async (orig) => ({
	...((await orig()) as object),
	lookupBlurtAccount: (...a: unknown[]) => lookup(...a)
}));
vi.mock('../src/lib/operatorFeeRecipient.ts', async (orig) => ({
	...((await orig()) as object),
	localFeeView: async () => null
}));

const { runStatus, renderWebHealSection } = await import('../src/commands/status.ts');
const { row } = await import('../src/render/term.ts');

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

/** A database answering each dashboard query; `sql` records what was asked. */
function db(failedCount: string) {
	const sql: string[] = [];
	return {
		sql,
		query: async (text: string) => {
			sql.push(text);
			if (text.includes('indexer_state'))
				return { rows: [{ last_applied_block: '100', last_applied_at: new Date() }] };
			if (text.includes('pending_count'))
				return {
					rows: [
						{
							pending_count: '4',
							oldest_created_at: new Date(Date.now() - 60_000),
							liquid_count: '1',
							vesting_count: '1',
							delegation_count: '2'
						}
					]
				};
			if (text.includes('FROM accounts')) return { rows: [{ count: '5' }] };
			if (text.includes('total_blurt')) return { rows: [{ count: '2', total_blurt: '20' }] };
			if (text.includes('error_count') || text.includes('last_error_at'))
				return { rows: [{ count: failedCount }] };
			return { rows: [{ count: '0', pending: '0' }] };
		}
	};
}

let out = '';
let root = '';
beforeEach(() => {
	out = '';
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
	vi.spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void (out += a.join(' ') + '\n')
	);
	root = mkdtempSync(join(tmpdir(), 'morphit-status-'));
	mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
	mkdirSync(join(root, 'opt', 'morphit'), { recursive: true });
	writeFileSync(
		join(root, 'etc', 'morphit', 'relay.env'),
		'MORPHIT_RELAY_ACCOUNT=alice-relay\nMORPHIT_RELAY_SIGNUP_DAILY_CEILING=20\n'
	);
	vi.stubEnv('MORPHIT_ENV_ROOT', root);
	vi.stubEnv('MORPHIT_BACKUP_DIR', join(root, 'backups'));
	lookup.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const run = (d: ReturnType<typeof db>) =>
	runStatus({ db: d, config, flags: {}, positional: [] } as never);

describe('status dashboard', () => {
	it('shows the relay balance, graded like the menu marker, for the relay account', async () => {
		lookup.mockResolvedValue({ name: 'alice-relay', balance: '42.000 BLURT', balanceBlurt: 42 });
		await run(db('0'));
		expect(lookup).toHaveBeenCalledWith('alice-relay');
		expect(out).toMatch(/Relay balance:\s+42\.000 BLURT\s+\[WARN\].*running low/);
	});

	it("says so when the chain can't be read, without a false alarm", async () => {
		lookup.mockRejectedValue(new Error('down'));
		await run(db('0'));
		expect(out).toMatch(/Relay balance:\s+\(unknown\)\s+\[i\] Could not reach the Blurt network/);
	});

	it("uses the relay's own daily limit from relay.env", async () => {
		lookup.mockResolvedValue(null);
		await run(db('0'));
		expect(out).toMatch(/Today:\s+5 \/ 20 /);
		expect(out).toMatch(/25% of the relay's daily limit/);
	});

	it('shows the pending breakdown with delegations, and the bonus total', async () => {
		lookup.mockResolvedValue(null);
		await run(db('0'));
		expect(out).toMatch(/Pending transfers:\s+4\s+1 liquid, 1 vesting, 2 delegations/);
		expect(out).toMatch(/Welcome bonuses today:\s+2\s+20\.00 BLURT total/);
	});

	it('failed broadcasts: only still-unsent rows that errored, a warning from the first', async () => {
		lookup.mockResolvedValue(null);
		const d = db('1');
		await run(d);
		const q = d.sql.find((s) => s.includes('last_error_at >= $1') && s.includes('COUNT')) ?? '';
		expect(q).toMatch(/broadcast_at IS NULL/);
		expect(q).toMatch(/error_count > 0/);
		expect(out).toMatch(
			/Failed broadcasts 24h:\s+1\s+\[WARN\] still not sent — see them, on this server: sudo morphit-ops failed-broadcasts/
		);
	});

	it('prints no command without sudo, and no promise about --json on "any command"', async () => {
		lookup.mockResolvedValue(null);
		await run(db('0'));
		for (const m of out.matchAll(/`?morphit-ops [a-z-]+/g)) {
			const at = m.index ?? 0;
			if (m[0].startsWith('`morphit-ops --help')) continue;
			expect(out.slice(Math.max(0, at - 5), at)).toMatch(/sudo $/);
		}
		expect(out).not.toMatch(/--json` to any command/);
	});
});

describe('a row without a status glyph', () => {
	it('keeps its detail', () => {
		row({ label: 'Pending transfers:', value: '3', detail: '3 liquid' });
		expect(out).toMatch(/Pending transfers:\s+3\s+3 liquid/);
	});
});

describe('the web proxy row', () => {
	it('does not repeat its value in its detail', () => {
		renderWebHealSection(
			{
				state: 'done',
				result: 'left-alone',
				detail: 'its settings were changed by hand',
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString()
			} as never,
			Date.now()
		);
		const line = out.split('\n').find((l) => l.includes('Privacy settings:')) ?? '';
		expect(line.match(/left as they are/g)).toHaveLength(1);
		expect(line).toContain('its settings were changed by hand');
	});
});

describe("the relay's key against the chain (the relay's own active_key check)", () => {
	const servers: Server[] = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((sv) => new Promise((r) => sv.close(r))));
	});
	/** A stand-in relay /v1/health answering `body`, set as this node's relay. */
	async function relayAnswers(body: unknown): Promise<void> {
		const sv = createServer((_q, r) => {
			r.setHeader('content-type', 'application/json');
			r.end(JSON.stringify(body));
		});
		servers.push(sv);
		await new Promise<void>((r) => sv.listen(0, '127.0.0.1', r));
		vi.stubEnv('MORPHIT_RELAY_LISTEN_HOST', '127.0.0.1');
		vi.stubEnv('MORPHIT_RELAY_LISTEN_PORT', String((sv.address() as AddressInfo).port));
	}
	const RELAY = { status: 'ok', rpc_ok: true, blurt_balance: '250.000 BLURT' };

	it('mismatch: an error row in plain words, then the exact fix commands on this server, in order', async () => {
		lookup.mockResolvedValue(null);
		await relayAnswers({ ...RELAY, active_key: { state: 'mismatch', public_key: 'BLT6x' } });
		await run(db('0'));
		expect(out).toMatch(
			/Relay key:\s+not the active key\s+\[ERR\] the relay's key file is not the account's active key on the chain: signups and payouts are paused/
		);
		const show = out.indexOf('sudo morphit-ops show-key');
		const edit = out.indexOf('sudo morphit-ops edit-active-key');
		const restart = out.indexOf('sudo systemctl restart morphit-relay');
		expect(show).toBeGreaterThan(-1);
		expect(edit).toBeGreaterThan(show);
		expect(restart).toBeGreaterThan(edit);
		expect(out).toMatch(/To fix it, on this server:/);
	});

	it('no such account: said as such, and the fix is the account name — never edit-active-key', async () => {
		lookup.mockResolvedValue(null);
		await relayAnswers({
			...RELAY,
			active_key: {
				state: 'mismatch',
				public_key: 'BLT6x',
				no_account: true,
				account: 'alice-relai'
			}
		});
		await run(db('0'));
		expect(out).toMatch(
			/Relay key:\s+no such account\s+\[ERR\] the relay's account @alice-relai does not exist on the Blurt chain/
		);
		expect(out).toContain('MORPHIT_RELAY_ACCOUNT=');
		expect(out).not.toMatch(/edit-active-key|show-key/);
	});

	it.each(['unknown', 'unchecked'])('%s: not an error, no fix commands', async (state) => {
		lookup.mockResolvedValue(null);
		await relayAnswers({ ...RELAY, active_key: { state, public_key: 'BLT6x', why: 'x' } });
		await run(db('0'));
		const line = out.split('\n').find((l) => l.includes('Relay key:')) ?? '';
		expect(line).toMatch(/\[i\]/);
		expect(out).not.toMatch(/\[ERR\]|edit-active-key|signups and payouts are paused/);
	});

	it('ok: a ✓ row', async () => {
		lookup.mockResolvedValue(null);
		await relayAnswers({ ...RELAY, active_key: { state: 'ok', public_key: 'BLT6x' } });
		await run(db('0'));
		expect(out).toMatch(/Relay key:\s+matches the chain\s+\[OK\]/);
	});

	it('the relay not answering is "unknown", never an error', async () => {
		lookup.mockResolvedValue(null);
		vi.stubEnv('MORPHIT_RELAY_LISTEN_HOST', '127.0.0.1');
		vi.stubEnv('MORPHIT_RELAY_LISTEN_PORT', '1');
		await run(db('0'));
		expect(out).toMatch(/Relay key:\s+\(unknown\)\s+\[i\] Could not ask the relay/);
		expect(out).not.toMatch(/\[ERR\]/);
	});

	it('--json carries the state', async () => {
		lookup.mockResolvedValue(null);
		await relayAnswers({ ...RELAY, active_key: { state: 'mismatch', public_key: 'BLT6x' } });
		const logged: string[] = [];
		vi.spyOn(process.stdout, 'write').mockImplementation(
			(c: unknown) => (logged.push(String(c)), true)
		);
		await runStatus({ db: db('0'), config, flags: { json: 'true' }, positional: [] } as never);
		const text = logged.join('') + out;
		const j = JSON.parse(text.slice(text.indexOf('{'))) as { relay_key: { state: unknown } };
		expect(j.relay_key.state).toBe('mismatch');
	});
});
