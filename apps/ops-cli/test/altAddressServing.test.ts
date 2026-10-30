/**
 * `morphit-ops alt-address`: making a vanity address SERVED, not only shown.
 *
 *  - Tor / I2P steps install the new key into the hidden service the server
 *    already runs: owned by Tor (`chown -R debian-tor:debian-tor`, `chmod 700`)
 *    — Tor refuses a directory it does not own, which the old "root-owned,
 *    mode 0700" copy made — with `scp -O` (a hardened server has SFTP off),
 *    each step naming its machine, and no new torrc / tunnel lines.
 *  - After a save: does Tor here really serve the address? A mismatch is
 *    said; the re-publish of the on-chain registration is offered (the old
 *    "advertised on-chain only" was false: nothing was broadcast); a Tor
 *    change updates the served pages, as `edit` does.
 *  - "Reload your site; the new pill appears" only when the restart happened.
 *  - The legacy single I2P setting is shown in the slot its ending says.
 *  - Not root: "Run it with sudo", not a raw EACCES.
 * The real runAltAddress against scratch files; prompts, the restart, the
 * register broadcast and the served-pages update are stubbed.
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

let choices: number[] = [];
let asks: string[] = [];
let yes: RegExp = /^$/;
let restartResult = false;
let registerRuns = 0;
let originSyncs = 0;
vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		askChoice: vi.fn(async () => {
			const c = choices.shift();
			if (c === undefined) throw new Error('more menus than the test answers');
			return c;
		}),
		ask: vi.fn(async (_q: string, d?: string) => {
			const a = asks.shift() ?? '';
			return a === '' ? (d ?? '') : a;
		}),
		askYesNo: vi.fn(async (q: string) => yes.test(q))
	};
});
vi.mock('../src/lib/restartServices.ts', () => ({
	offerRestart: vi.fn(async () => restartResult)
}));
vi.mock('../src/commands/register.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, runRegister: vi.fn(async () => (registerRuns++, 0)) };
});
vi.mock('../src/lib/instanceOrigin.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		syncInstanceOrigin: vi.fn(() => (originSyncs++, { detail: '', verified: true }))
	};
});

const { runAltAddress } = await import('../src/commands/altAddress.ts');

const ONION_OLD = `${'b'.repeat(56)}.onion`;
const ONION_NEW = `${'a'.repeat(56)}.onion`;
let root = '';
let printed: string[] = [];
const saved = { ...process.env };
const live = (): string => join(root, 'opt/morphit');
const cfg = (): string => join(live(), 'morphit.config.env');
const text = (): string => printed.join('\n');
const run = (): Promise<number> =>
	runAltAddress({ flags: { out: live() }, positional: [] } as never);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'alt-serving-'));
	mkdirSync(live(), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	writeFileSync(
		cfg(),
		`MORPHIT_INSTANCE_ORIGIN=https://example-node.org\nMORPHIT_INSTANCE_NAME=Site\nMORPHIT_INSTANCE_TOR_ADDRESS=${ONION_OLD}\n`
	);
	choices = [];
	asks = [];
	yes = /save it\?/i;
	restartResult = false;
	registerRuns = 0;
	originSyncs = 0;
	printed = [];
	deny.path = null;
	process.env.MORPHIT_ENV_ROOT = root;
	delete process.env.MORPHIT_INSTANCE_TOR_ADDRESS;
	delete process.env.SUDO_USER;
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		printed.push(a.map(String).join(' '));
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

const torHostname = (onion: string): void => {
	mkdirSync(join(root, 'var/lib/tor/morphit'), { recursive: true });
	writeFileSync(join(root, 'var/lib/tor/morphit/hostname'), `${onion}\n`);
};

describe('the Tor steps', () => {
	it('install the key into the existing hidden service, owned by Tor, with scp -O, machine by machine', async () => {
		choices = [0, 0, 6];
		asks = ['', ONION_NEW];
		expect(await run()).toBe(0);
		const out = text();
		expect(out).toMatch(/On your computer, copy the helper script from this server/);
		expect(out).toMatch(
			/scp -O root@example-node\.org:\S+\/scripts\/generate-onion\.sh ~\/generate-onion\.sh/
		);
		// The copy itself: the exact lines the script printed (they name the new
		// folder it made — a glob here broke once two existed).
		expect(out).toMatch(/run the "cd" and "scp -O"\s+lines the script printed/);
		expect(out).not.toMatch(/\*\.onion/);
		expect(out).toMatch(
			/sudo install -o debian-tor -g debian-tor -m 600 \/root\/hs_ed25519_secret_key \/root\/hs_ed25519_public_key \/var\/lib\/tor\/morphit\//
		);
		expect(out).toMatch(/On this server, keep a copy of the current key/);
		expect(out).toMatch(/sudo chown -R debian-tor:debian-tor \/var\/lib\/tor\/morphit$/m);
		expect(out).toMatch(/sudo chmod 700 \/var\/lib\/tor\/morphit$/m);
		expect(out).toMatch(/sudo systemctl restart tor$/m);
		expect(out).toMatch(/sudo cat \/var\/lib\/tor\/morphit\/hostname$/m);
		expect(out).not.toMatch(/HiddenServiceDir|root-owned/);
		expect(out).not.toMatch(/(^|\s)scp (?!-O)/m);
	});

	it('the I2P steps replace the key the [morphit-web] tunnel uses; no second tunnel', async () => {
		choices = [2, 0, 6];
		asks = ['', ''];
		expect(await run()).toBe(0);
		const out = text();
		expect(out).toMatch(/run the "scp -O" line the\s+script printed/);
		expect(out).toMatch(
			/sudo install -o i2pd -g i2pd -m 600 \/root\/morphit-web\.dat \/var\/lib\/i2pd\/morphit-web\.dat/
		);
		expect(out).toMatch(/sudo systemctl restart i2pd$/m);
		expect(out).not.toMatch(/^\s*\[morphit\]\s*$/m);
	});
});

describe('the account the copies go to', () => {
	it('run with sudo by alice: copies go to alice (root cannot log in over ssh on a hardened server)', async () => {
		process.env.SUDO_USER = 'alice';
		choices = [0, 0, 6];
		asks = ['', ONION_NEW];
		expect(await run()).toBe(0);
		const out = text();
		expect(out).toMatch(
			/scp -O alice@example-node\.org:\S+\/scripts\/generate-onion\.sh ~\/generate-onion\.sh/
		);
		expect(out).toMatch(/bash generate-onion\.sh morph alice@example-node\.org$/m);
		expect(out).not.toMatch(/root@/);
		expect(out).not.toMatch(/\/root\/hs_ed25519/);
	});

	it('sshTarget: alice’s real home folder from the account database; root only without sudo', async () => {
		const { sshTarget, vanitySteps } = await import('../src/commands/altAddress.ts');
		const cfgText = 'MORPHIT_INSTANCE_ORIGIN=https://example-node.org\n';
		const t = sshTarget(cfgText, { SUDO_USER: 'alice' }, (u) =>
			u === 'alice' ? '/srv/home/alice' : null
		);
		expect(t).toEqual({
			target: 'alice@example-node.org',
			placeholder: false,
			home: '/srv/home/alice'
		});
		const steps = vanitySteps('tor', 'morph', t.target, '/opt/morphit', t.home).join('\n');
		expect(steps).toContain(
			'sudo install -o debian-tor -g debian-tor -m 600 /srv/home/alice/hs_ed25519_secret_key /srv/home/alice/hs_ed25519_public_key /var/lib/tor/morphit/'
		);
		expect(steps).toContain('sudo shred -u /srv/home/alice/hs_ed25519_secret_key');
		expect(sshTarget(cfgText, {}, () => null)).toEqual({
			target: 'root@example-node.org',
			placeholder: false,
			home: '/root'
		});
		// Home not found: "~" (that account's own home when it runs the line).
		expect(sshTarget(cfgText, { SUDO_USER: 'bob' }, () => null).home).toBe('~');
	});
});

describe('after saving a Tor address', () => {
	it('Tor here serves another address: said, with what to do', async () => {
		torHostname(ONION_OLD);
		choices = [0, 0, 6];
		asks = ['', ONION_NEW];
		await run();
		expect(text()).toMatch(
			new RegExp(`Tor on this server serves ${ONION_OLD}, not the address you saved`)
		);
	});

	it('Tor here serves it: confirmed', async () => {
		torHostname(ONION_NEW);
		choices = [0, 0, 6];
		asks = ['', ONION_NEW];
		await run();
		expect(text()).toMatch(new RegExp(`✓ Tor on this server serves ${ONION_NEW}`));
	});

	it('the re-publish of the registration is offered, and the served pages are updated', async () => {
		yes = /save it\?|broadcast this change/i;
		choices = [0, 0, 6];
		asks = ['', ONION_NEW];
		await run();
		expect(registerRuns).toBe(1);
		expect(originSyncs).toBe(1);
		expect(text()).not.toMatch(/advertised on-chain only/);
	});

	it('restart declined: no "the new pill appears" (the restart commands were printed by the offer)', async () => {
		restartResult = false;
		choices = [0, 0, 6];
		asks = ['', ONION_NEW];
		await run();
		expect(text()).not.toMatch(/the new pill appears/);
		expect(text()).toMatch(/Your footer changes after that restart/);
	});

	it('restarted, but nothing could be checked (another copy): no "the new pill appears"', async () => {
		restartResult = true;
		// Another copy of the settings (--out elsewhere): nothing on this
		// machine to check the running indexer against, so no wait for it.
		const other = join(root, 'other');
		mkdirSync(other);
		writeFileSync(join(other, 'morphit.config.env'), 'MORPHIT_INSTANCE_NAME=Site\n');
		choices = [0, 0, 6];
		asks = ['', ONION_NEW];
		await runAltAddress({ flags: { out: other }, positional: [] } as never);
		expect(text()).not.toMatch(/the new pill appears/);
		expect(text()).toMatch(/could not be checked from here/);
	});
});

describe('the legacy single I2P setting', () => {
	it('a vanity name in it is shown as the vanity name, not as the b32 address', async () => {
		writeFileSync(
			cfg(),
			'MORPHIT_INSTANCE_NAME=Site\nMORPHIT_INSTANCE_I2P_ADDRESS=yourbrand.i2p\n'
		);
		choices = [2, 1, 3, 2, 6]; // b32 → Back, vanity → Back, Done
		expect(await run()).toBe(0);
		const out = text();
		expect(out).toMatch(/I2P b32 address \(DOMAIN\.b32\.i2p\)\n\s+Current: \(not set\)/);
		expect(out).toMatch(/I2P vanity name \(DOMAIN\.i2p\)\n\s+Current: yourbrand\.i2p/);
	});
});

describe('not root', () => {
	it('an unreadable settings file says to run it with sudo', async () => {
		deny.path = cfg();
		choices = [0];
		expect(await run()).toBe(1);
		expect(text()).toMatch(/Run it with sudo: sudo morphit-ops alt-address/);
	});
});

describe('--out given as a relative path', () => {
	it('is relative to where the operator ran the command (MORPHIT_OPS_CALLER_CWD)', async () => {
		const callerDir = join(root, 'home/alice');
		mkdirSync(join(callerDir, 'site'), { recursive: true });
		writeFileSync(
			join(callerDir, 'site', 'morphit.config.env'),
			`MORPHIT_INSTANCE_NAME=Site\nMORPHIT_INSTANCE_TOR_ADDRESS=${ONION_OLD}\n`
		);
		process.env.MORPHIT_OPS_CALLER_CWD = callerDir;
		choices = [0, 2, 6]; // Tor → Back → Done
		expect(await runAltAddress({ flags: { out: 'site' }, positional: [] } as never)).toBe(0);
		expect(text()).not.toMatch(/no settings file found/);
		expect(text()).toMatch(new RegExp(`Current: ${ONION_OLD}`));
	});
});
