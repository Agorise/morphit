/**
 * `morphit-ops edit` (and `alt-address`) refuse, at the prompt, any value the
 * indexer would refuse at start-up. A 65-character name, a 201-character
 * tagline or an 81-character alt address used to be written, the indexer then
 * refused to start, and the edit still said the change was live.
 *
 * The limits the editor uses are tied to the indexer's OWN schema: its real
 * loadConfig() runs (in a child, as the service would) with every setting at
 * the editor's limit — accepted — and one character over — refused.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INDEXER_TEXT_LIMITS, fieldProblem, runEdit } from '../src/commands/edit.ts';
import {
	ALT_ADDRESS_MAX,
	validateAltAddress,
	validateEnsName,
	validateI2pName,
	validateNostr
} from '../src/lib/altAddressValidate.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const ALT_KEYS = [
	'MORPHIT_INSTANCE_TOR_ADDRESS',
	'MORPHIT_INSTANCE_LOKINET_ADDRESS',
	'MORPHIT_INSTANCE_I2P_B32_ADDRESS',
	'MORPHIT_INSTANCE_I2P_NAME_ADDRESS',
	'MORPHIT_INSTANCE_NOSTR_PUBKEY',
	'MORPHIT_INSTANCE_ENS_NAME'
];
const LIMITS: Record<string, number> = {
	...INDEXER_TEXT_LIMITS,
	...Object.fromEntries(ALT_KEYS.map((k) => [k, ALT_ADDRESS_MAX]))
};

/** The keys the indexer's own config loader refuses for these values. */
function indexerRefuses(values: Record<string, string>): string[] {
	const dir = mkdtempSync(join(tmpdir(), 'indexer-limits-'));
	try {
		const script = join(dir, 'probe.mts');
		writeFileSync(
			script,
			`const m = await import(${JSON.stringify(join(REPO, 'apps/indexer/src/config/index.ts'))});\n` +
				'let msg = "";\n' +
				'try { m.loadConfig(); } catch (e) { msg = String(e && e.message); }\n' +
				'process.stdout.write(JSON.stringify(msg));\n'
		);
		const r = spawnSync(join(REPO, 'node_modules/.bin/tsx'), [script], {
			cwd: join(REPO, 'apps/indexer'),
			encoding: 'utf8',
			env: { PATH: process.env.PATH, ...values },
			timeout: 60_000
		});
		expect(r.status, r.stderr).toBe(0);
		const msg = JSON.parse(r.stdout) as string;
		return Object.keys(values).filter((k) => new RegExp(`^\\s*- ${k}:`, 'm').test(msg));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("the editor's limits are the indexer's", () => {
	it('at the limit the indexer starts; one character over, it refuses that setting', () => {
		const at = Object.fromEntries(Object.entries(LIMITS).map(([k, n]) => [k, 'a'.repeat(n)]));
		const over = Object.fromEntries(Object.entries(LIMITS).map(([k, n]) => [k, 'a'.repeat(n + 1)]));
		expect(indexerRefuses(at)).toEqual([]);
		expect(indexerRefuses(over).sort()).toEqual(Object.keys(LIMITS).sort());
	}, 120_000);

	it('the editor accepts the limit and refuses one over, for every text setting', () => {
		for (const [k, n] of Object.entries(INDEXER_TEXT_LIMITS)) {
			expect(fieldProblem(k, 'a'.repeat(n)), k).toBeNull();
			expect(fieldProblem(k, 'a'.repeat(n + 1)), k).toMatch(/too long/);
		}
	});

	it('every alt-address check refuses an address longer than the indexer takes', () => {
		const long = (body: number, suffix: string): string => 'a'.repeat(body) + suffix;
		expect(validateAltAddress('lokinet', long(ALT_ADDRESS_MAX - 4, '.loki')).ok).toBe(false);
		expect(validateAltAddress('i2p', long(ALT_ADDRESS_MAX - 7, '.b32.i2p')).ok).toBe(false);
		expect(validateI2pName(long(ALT_ADDRESS_MAX - 3, '.i2p')).ok).toBe(false);
		expect(validateEnsName(long(ALT_ADDRESS_MAX - 3, '.eth')).ok).toBe(false);
		expect(validateNostr(`npub1${'q'.repeat(ALT_ADDRESS_MAX - 4)}`).ok).toBe(false);
		// …and still takes real ones.
		expect(validateAltAddress('i2p', long(52, '.b32.i2p')).ok).toBe(true);
		expect(validateEnsName('yourbrand.eth').ok).toBe(true);
		expect(validateNostr(`npub1${'q'.repeat(58)}`).ok).toBe(true);
	});
});

// ─── at the prompt ──────────────────────────────────────────────────────────

let answers: string[] = [];
vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		ask: vi.fn(async (_q: string, d?: string) => {
			const a = answers.shift();
			if (a === undefined) throw new Error('more questions than the test answers');
			return a === '' ? (d ?? '') : a;
		}),
		askYesNo: vi.fn(async (q: string) => /apply these changes/i.test(q)),
		askChoice: vi.fn(async (_q: string, choices: readonly string[]) => {
			const want = answers.shift() ?? '';
			return choices.findIndex((c) => c === want);
		})
	};
});
vi.mock('../src/lib/restartServices.ts', () => ({ offerRestart: vi.fn(async () => false) }));
vi.mock('../src/commands/register.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, runRegister: vi.fn(async () => 0) };
});

describe('edit refuses them at the prompt (asked again; never written)', () => {
	let dir = '';
	const saved = { ...process.env };
	let printed: string[] = [];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'edit-limits-'));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'morphit.config.env'), "MORPHIT_INSTANCE_NAME='Example Node'\n");
		printed = [];
		vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
			printed.push(a.map(String).join(' '));
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		process.env = { ...saved };
		rmSync(dir, { recursive: true, force: true });
	});
	it('a 65-character instance name', async () => {
		answers = ['Branding & SEO', 'A'.repeat(65), 'Shorter Name', '', '', '', '', '', ''];
		expect(await runEdit({ flags: { out: dir }, positional: [] } as never)).toBe(0);
		expect(printed.join('\n')).toMatch(/too long — 65 characters, at most 64/);
		const file = readFileSync(join(dir, 'morphit.config.env'), 'utf8');
		expect(file).not.toMatch(/A{65}/);
		expect(file).toMatch(/Shorter Name/);
	});

	it('"hello" as a Tor address', async () => {
		answers = ['Alt-network addresses', 'hello', '', '', '', '', '', ''];
		expect(await runEdit({ flags: { out: dir }, positional: [] } as never)).toBe(0);
		expect(printed.join('\n')).toMatch(/not a v3 \.onion address/);
		expect(readFileSync(join(dir, 'morphit.config.env'), 'utf8')).not.toMatch(/hello/);
	});
});
