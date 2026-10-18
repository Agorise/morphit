/**
 * `morphit-ops edit` → Branding & SEO → Contact URL on a server whose
 * /etc/morphit/indexer.env (read after morphit.config.env, last wins) still
 * holds the install-time contact: the old copy is removed, so the restart
 * really brings the new contact (v1.21.10). The real runEdit against scratch
 * files under MORPHIT_ENV_ROOT; prompts, the restart and the register
 * broadcast are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let answers: string[] = [];
const offered: string[][] = [];

vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		askChoice: vi.fn(async (_q: string, choices: readonly string[]) =>
			choices.findIndex((c) => /branding & seo/i.test(c))
		),
		// Instance name, site brand name, tagline, CONTACT URL, then the SEO fields.
		ask: vi.fn(async () => answers.shift() ?? ''),
		// "Apply these changes?" yes; "publish the registration now?" no.
		askYesNo: vi.fn(async (q: string) => /apply these changes/i.test(q))
	};
});
vi.mock('../src/lib/restartServices.ts', () => ({
	offerRestart: vi.fn(async (units: readonly string[]) => (offered.push([...units]), false))
}));
vi.mock('../src/commands/register.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, runRegister: vi.fn(async () => 0) };
});

const { runEdit } = await import('../src/commands/edit.ts');

const OLD = 'https://matrix.to/#/#morphit:matrix.org';
const IDX_TEXT = `MORPHIT_INDEXER_LISTEN_PORT=8081\nMORPHIT_INSTANCE_CONTACT_URL=${OLD}\n`;
let root = '';
const saved = { ...process.env };
const cfg = () => join(root, 'opt/morphit/morphit.config.env');
const idx = () => join(root, 'etc/morphit/indexer.env');

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-edit-contact-'));
	mkdirSync(join(root, 'opt/morphit'), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	writeFileSync(cfg(), `MORPHIT_INSTANCE_NAME=Morphit\nMORPHIT_INSTANCE_CONTACT_URL="${OLD}"\n`);
	writeFileSync(idx(), IDX_TEXT);
	answers = ['', '', '', 'operator@example.org'];
	offered.length = 0;
	process.env.MORPHIT_ENV_ROOT = root;
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

describe('edit → Contact URL with an old copy in indexer.env', () => {
	it('writes the new contact and removes the old copy the indexer would have kept', async () => {
		expect(
			await runEdit({ flags: { out: join(root, 'opt/morphit') }, positional: [] } as never)
		).toBe(0);
		expect(readFileSync(cfg(), 'utf8')).toMatch(
			/^MORPHIT_INSTANCE_CONTACT_URL=mailto:operator@example\.org$/m
		);
		expect(readFileSync(idx(), 'utf8')).toBe('MORPHIT_INDEXER_LISTEN_PORT=8081\n');
		expect(offered).toEqual([['morphit-indexer']]);
	});

	it('editing another copy of the settings (--out elsewhere) leaves the server’s indexer.env alone', async () => {
		const other = join(root, 'elsewhere');
		mkdirSync(other);
		writeFileSync(join(other, 'morphit.config.env'), `MORPHIT_INSTANCE_CONTACT_URL="${OLD}"\n`);
		expect(await runEdit({ flags: { out: other }, positional: [] } as never)).toBe(0);
		expect(readFileSync(join(other, 'morphit.config.env'), 'utf8')).toMatch(/mailto:operator/);
		expect(readFileSync(idx(), 'utf8')).toBe(IDX_TEXT);
	});
});
