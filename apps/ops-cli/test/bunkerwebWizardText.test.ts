/**
 * v1.21.1 review (D-3): the install wizard told operators to add ASN blocks
 * ("BLACKLIST_* / GREYLIST_* AS blocks") and that "AUTO_LETS_ENCRYPT=yes
 * handles TLS" — but Morphit ships AUTO_LETS_ENCRYPT=no (the host's certbot
 * gets the certificate; the no-phone-home smoke requires it), no Morphit
 * instance blocks by country or ASN, and after the `cp -r` it printed there
 * was no bunkerweb.env to edit, only bunkerweb.env.example.
 *
 * These run the wizard step and the checklist renderer, then RUN the copy
 * commands they print (sudo dropped, /etc/bunkerweb pointed at a temp dir)
 * and look at what an operator who follows them ends up with.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BUNKERWEB_PRIVACY_SETTINGS, envValues } from '../src/lib/bunkerwebPrivacy.ts';

const explained: string[] = [];
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	askYesNo: async () => true,
	step: () => {},
	explain: (t: string) => {
		explained.push(t);
	}
}));
const { stepBunkerWeb, stepHardening } = await import('../src/init/steps.ts');
const { renderHardeningChecklist } = await import('../src/init/render.ts');

const REPO = resolve(__dirname, '..', '..', '..');
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function printed(fn: () => Promise<unknown>): Promise<string> {
	const out: string[] = [];
	const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out.push(a.join(' '));
	});
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	return out.join('\n');
}

/** Run the `sudo mkdir` / `sudo cp` lines of `text` from the repo root, with
 *  /etc/bunkerweb → a temp dir; returns that dir. */
function follow(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'bwwizard-'));
	dirs.push(dir);
	const etc = join(dir, 'etc-bunkerweb');
	const cmds = text
		.split('\n')
		.map((l) => l.replace(/^[\s#>-]*/, '').trim())
		.filter((l) => /^sudo (mkdir|cp) /.test(l))
		.map((l) => l.replace(/^sudo /, '').replaceAll('/etc/bunkerweb', etc));
	expect(cmds.length).toBeGreaterThan(0);
	for (const c of cmds) {
		const r = spawnSync('sh', ['-c', c], { cwd: REPO, encoding: 'utf8' });
		expect(r.status, `${c}: ${r.stderr}`).toBe(0);
	}
	return etc;
}

function expectRunnableBunkerWeb(etc: string): void {
	// the file the instructions say to edit, and that docker-compose.yml reads
	expect(existsSync(join(etc, 'bunkerweb.env'))).toBe(true);
	expect(readFileSync(join(etc, 'docker-compose.yml'), 'utf8')).toMatch(/- \.\/bunkerweb\.env/);
	const v = envValues(readFileSync(join(etc, 'bunkerweb.env'), 'utf8'));
	expect(v.get('AUTO_LETS_ENCRYPT')).toBe('no');
	for (const s of BUNKERWEB_PRIVACY_SETTINGS)
		expect(v.get(s.key) ?? s.bunkerwebDefault, s.key).toBe(s.value);
}

const WRONG = [
	/AUTO_LETS_ENCRYPT=yes/,
	/AUTO_LETS_ENCRYPT\) handles|AUTO_LETS_ENCRYPT=yes handles/,
	/BLACKLIST_\*|GREYLIST_\*/,
	/AS blocks\./
];

describe('the wizard’s BunkerWeb instructions (D-3)', () => {
	it('step 22: following its commands gives a bunkerweb.env with Morphit’s settings; TLS from certbot', async () => {
		const text = await printed(() => stepBunkerWeb());
		for (const w of WRONG) expect(text).not.toMatch(w);
		expect(text).toMatch(/sudo certbot certonly --standalone -d /);
		expect(text).toMatch(/AUTO_LETS_ENCRYPT=no/);
		expectRunnableBunkerWeb(follow(text));
	});
	it('step 23 (BunkerWeb chosen) does not say BunkerWeb’s own ACME client handles TLS', async () => {
		explained.length = 0;
		await printed(() => stepHardening(true));
		const text = explained.join('\n');
		expect(text).toMatch(/certbot/);
		for (const w of WRONG) expect(text).not.toMatch(w);
	});
	it('the hardening checklist: certbot for TLS, and its copy block gives a runnable bunkerweb.env', () => {
		const md = renderHardeningChecklist({
			instanceName: 'x',
			origin: 'https://trade.example.org',
			bunkerWebEnabled: true
		});
		for (const w of WRONG) expect(md).not.toMatch(w);
		expect(md).toMatch(/sudo certbot certonly --standalone -d trade\.example\.org/);
		expectRunnableBunkerWeb(follow(md));
	});
});
