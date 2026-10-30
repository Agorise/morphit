/**
 * `morphit-ops edit`:
 *  - run without sudo, an unreadable settings file says "Run it with sudo:
 *    sudo morphit-ops edit" (it printed a raw EACCES stack);
 *  - a new Tor address saved in the alt-network section is checked against
 *    what Tor on this server serves, and a mismatch is said; the change is
 *    part of the on-chain registration, so the re-publish is offered.
 * The real runEdit against scratch files; prompts, the restart and the
 * register broadcast are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const deny: { path: string | null } = vi.hoisted(() => ({ path: null }));
vi.mock('node:fs', async (orig) => {
	const fs = await orig<typeof import('node:fs')>();
	return {
		...fs,
		readFileSync: ((p: unknown, ...rest: unknown[]) => {
			if (deny.path !== null && String(p) === deny.path)
				throw Object.assign(new Error(`EACCES: permission denied, open '${String(p)}'`), {
					code: 'EACCES'
				});
			return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
		}) as typeof fs.readFileSync
	};
});

let asks: string[] = [];
let registerRuns = 0;
vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		askChoice: vi.fn(async (_q: string, choices: readonly string[]) =>
			choices.findIndex((c) => c === 'Alt-network addresses')
		),
		ask: vi.fn(async (_q: string, d?: string) => {
			const a = asks.shift() ?? '';
			return a === '' ? (d ?? '') : a;
		}),
		askYesNo: vi.fn(async (q: string) => /apply these changes|broadcast this change/i.test(q))
	};
});
vi.mock('../src/lib/restartServices.ts', () => ({ offerRestart: vi.fn(async () => false) }));
vi.mock('../src/commands/register.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, runRegister: vi.fn(async () => (registerRuns++, 0)) };
});
vi.mock('../src/lib/instanceOrigin.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, syncInstanceOrigin: vi.fn(() => ({ detail: '', verified: true })) };
});

const { runEdit } = await import('../src/commands/edit.ts');

const ONION_OLD = `${'b'.repeat(56)}.onion`;
const ONION_NEW = `${'a'.repeat(56)}.onion`;
let root = '';
let printed: string[] = [];
const saved = { ...process.env };
const live = (): string => join(root, 'opt/morphit');
const cfg = (): string => join(live(), 'morphit.config.env');

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'edit-sudo-'));
	mkdirSync(live(), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	mkdirSync(join(root, 'var/lib/tor/morphit'), { recursive: true });
	writeFileSync(join(root, 'var/lib/tor/morphit/hostname'), `${ONION_OLD}\n`);
	writeFileSync(
		cfg(),
		`MORPHIT_INSTANCE_ORIGIN=https://example-node.org\nMORPHIT_INSTANCE_NAME=Site\nMORPHIT_INSTANCE_TOR_ADDRESS=${ONION_OLD}\n`
	);
	asks = [];
	registerRuns = 0;
	printed = [];
	deny.path = null;
	process.env.MORPHIT_ENV_ROOT = root;
	delete process.env.MORPHIT_INSTANCE_TOR_ADDRESS;
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		printed.push(a.map(String).join(' '));
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

describe('edit', () => {
	it('an unreadable settings file: "Run it with sudo", no raw error', async () => {
		deny.path = cfg();
		expect(await runEdit({ flags: { out: live() }, positional: [] } as never)).toBe(1);
		const out = printed.join('\n');
		expect(out).toMatch(/Run it with sudo: sudo morphit-ops edit/);
	});

	it('a new Tor address Tor here does not serve: said; and the re-publish is offered', async () => {
		asks = [ONION_NEW, '', '', '', '', ''];
		expect(await runEdit({ flags: { out: live() }, positional: [] } as never)).toBe(0);
		const out = printed.join('\n');
		expect(out).toMatch(
			new RegExp(`Tor on this server serves ${ONION_OLD}, not the address you saved`)
		);
		expect(out).toMatch(/You changed your alt-network addresses/);
		expect(registerRuns).toBe(1);
	});
});
