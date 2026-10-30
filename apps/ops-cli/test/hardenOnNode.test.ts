/**
 * `morphit-ops harden` (menu: Harden this server) on a running node, review
 * 2026-10-29:
 *  - H3: the on-screen walkthrough said "✓ Checklist will be written next to
 *    your config files" and wrote nothing; the BunkerWeb option claimed it
 *    would set a config value it never wrote and printed relative `sudo cp`
 *    commands that overwrite a live BunkerWeb, plus a `certbot --standalone`
 *    that cannot work while BunkerWeb holds port 80; both printed the install
 *    wizard's "Step 23 of 23" / "Your Morphit config is done";
 *  - M2: BunkerWeb was "detected" from a config line, so always "no";
 *  - M3: the backup option ignored the backups the install set up, and its
 *    commands overwrote their settings;
 *  - M4: without a terminal it asked "Choose" forever;
 *  - M5: placeholders (vX.Y.Z, <cid>), a gpg | sudo tee mixing two machines,
 *    and "run the playbook" with no command.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const choices: number[] = [];
const yesNo: boolean[] = [];
/** Typed answers by question (else the offered default). */
const typed = new Map<string, string>();
const choiceCalls: { q: string; def: number | undefined }[] = [];
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	askChoice: async (q: string, _c: readonly string[], def?: number) => {
		choiceCalls.push({ q, def });
		const n = choices.shift();
		if (n === undefined) throw new Error('NO MORE ANSWERS');
		return n;
	},
	askYesNo: async () => {
		const v = yesNo.shift();
		if (v === undefined) throw new Error('NO MORE ANSWERS');
		return v;
	},
	ask: async (q: string, d?: string) => typed.get(q) ?? d ?? '',
	askInt: async (_q: string, o?: { default?: number }) => o?.default ?? 1
}));
vi.mock('../src/lib/dbContainer.ts', async (orig) => ({
	...((await orig()) as object),
	detectDbContainerAsync: async () => null
}));

const { runHarden } = await import('../src/commands/harden.ts');

let out = '';
let root = '';
beforeEach(() => {
	out = '';
	choices.length = 0;
	yesNo.length = 0;
	choiceCalls.length = 0;
	typed.clear();
	vi.spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void (out += a.join(' ') + '\n')
	);
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
	root = mkdtempSync(join(tmpdir(), 'morphit-harden-'));
	writeFileSync(join(root, 'package.json'), '{"name":"x","workspaces":[]}');
	writeFileSync(
		join(root, 'morphit.config.env'),
		'MORPHIT_INSTANCE_NAME="Alice Market"\nMORPHIT_INSTANCE_ORIGIN=https://trade.alice.net\n'
	);
	writeFileSync(join(root, 'release-info.json'), '{"tag":"v1.2.3"}');
	mkdirSync(join(root, 'etc'), { recursive: true });
	vi.stubEnv('MORPHIT_INSTALL_DIR', root);
	vi.stubEnv('MORPHIT_INSTANCE_ORIGIN', '');
	vi.stubEnv('MORPHIT_INSTANCE_NAME', '');
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const running = async () => ({ presence: 'running' as const, configDir: true, dockerError: null });
const none = async () => ({ presence: 'none' as const, configDir: false, dockerError: null });

function harden(deps: Record<string, unknown> = {}) {
	return runHarden({ flags: { out: root }, positional: [], colorEnabled: false }, {
		isTTY: true,
		detectBunkerWeb: running,
		etcDir: join(root, 'etc'),
		...deps
	} as never);
}

describe('harden on a running node', () => {
	it('without a terminal: says how to run it, asks nothing', async () => {
		const code = await runHarden({ flags: { out: root }, positional: [], colorEnabled: false }, {
			isTTY: false,
			detectBunkerWeb: running
		} as never);
		expect(code).toBe(1);
		expect(out).toContain('sudo morphit-ops harden');
		expect(choiceCalls).toHaveLength(0);
	});

	it('the walkthrough writes the checklist it promises, with the answers given', async () => {
		choices.push(1, 9);
		// SSH yes, firewall NO, updates, kernel, intrusion yes; write it: yes
		yesNo.push(true, false, true, true, true, true);
		expect(await harden()).toBe(0);
		const md = readFileSync(join(root, 'morphit-hardening-checklist.md'), 'utf8');
		expect(md).toMatch(/\[ \] Firewall \(UFW\) \+ fail2ban\s+— you chose to skip/);
		expect(md).toMatch(/\[x\] SSH lockdown/);
		expect(out).toMatch(/✓ Wrote .*morphit-hardening-checklist\.md/);
		expect(out).not.toMatch(/Step \d+ of \d+/);
		expect(out).not.toMatch(/Your Morphit config is done/);
	});

	it('with BunkerWeb running, the checklist never copies over it and gets the certificate through it', async () => {
		choices.push(0, 9);
		await harden();
		const md = readFileSync(join(root, 'morphit-hardening-checklist.md'), 'utf8');
		expect(md).not.toMatch(/sudo cp -r ops\/bunkerweb/);
		expect(md).not.toMatch(/certbot certonly --standalone/);
		expect(md).toContain(
			`sudo certbot certonly --webroot --webroot-path ${root}/apps/web/build -d trade.alice.net`
		);
		// running → no question about whether BunkerWeb will be used
		expect(choiceCalls.filter((c) => /BunkerWeb sit in front/.test(c.q))).toHaveLength(0);
	});

	it('BunkerWeb is detected from Docker: none found → the question defaults to "No"', async () => {
		choices.push(0, 0, 9);
		await harden({ detectBunkerWeb: none });
		const q = choiceCalls.find((c) => /BunkerWeb sit in front/.test(c.q));
		expect(q?.def).toBe(1);
		expect(q?.q).toMatch(/not found on this server/);
	});

	it('the BunkerWeb option runs the guided installer, never the wizard text', async () => {
		choices.push(2, 9);
		const runBunkerWeb = vi.fn(async () => 0);
		await harden({ runBunkerWeb });
		expect(runBunkerWeb).toHaveBeenCalledTimes(1);
		expect(out).not.toMatch(/will set\s+MORPHIT_RELAY_TRUSTED_PROXY_IPS/);
		expect(out).not.toMatch(/sudo cp -r ops\/bunkerweb/);
		expect(out).not.toMatch(/Step \d+ of \d+/);
	});

	it('backups already set up by the install: shows them and changes nothing', async () => {
		const env = 'BACKUP_DIR=/nonexistent-dir\nDB_HOST=127.0.0.1\nDB_PASSWORD=s3cret\n';
		writeFileSync(join(root, 'etc', 'backup.env'), env);
		choices.push(3, 9);
		await harden();
		expect(out).toMatch(/already set up on this server/);
		expect(out).not.toMatch(/sudo install .*backup\.env/);
		expect(readFileSync(join(root, 'etc', 'backup.env'), 'utf8')).toBe(env);
	});

	it("no backups yet: the morphit user's own folder, created before the timer starts", async () => {
		const passwd = join(root, 'passwd');
		writeFileSync(
			passwd,
			'root:x:0:0::/root:/bin/sh\nmorphit:x:999:999::/var/lib/morphit:/usr/sbin/nologin\n'
		);
		choices.push(3, 9);
		yesNo.push(true);
		await harden({ passwdPath: passwd });
		expect(out).toContain('sudo install -d -m 700 -o morphit -g morphit /var/lib/morphit/backups');
		expect(out).toMatch(/ReadWritePaths=\/var\/lib\/morphit\/backups/);
		expect(out).not.toMatch(/morphit-ops init/);
		expect(out).not.toMatch(/Step \d+ of \d+/);
	});

	it('seed, canary and automated-hardening options: real values, which machine, no placeholders', async () => {
		choices.push(5, 6, 8, 9);
		await harden({ serviceState: () => 'active' });
		expect(out).toContain(`sh ${root}/ops/ipfs/morphit-ipfs-seed.sh v1.2.3`);
		expect(out).not.toMatch(/vX\.Y\.Z|<cid>|YOUR_KEY_ID/);
		expect(out).not.toMatch(/gpg [^\n]*\| sudo tee/);
		expect(out).toMatch(/On THIS server[^\n]*\n[^\n]*sudo bash scripts\/canary\/setup\.sh/);
		expect(out).toMatch(/on YOUR computer/);
		expect(out).toMatch(/ansible-playbook -i inventory\/hosts\.yml playbook\.yml --tags hardening/);
	});

	it('a backup folder the commands cannot carry is refused: no command built from it, nothing written', async () => {
		const passwd = join(root, 'passwd');
		writeFileSync(passwd, 'morphit:x:999:999::/var/lib/morphit:/usr/sbin/nologin\n');
		typed.set('Backup directory', "/srv/my backups';touch /tmp/x;'");
		choices.push(3, 9);
		yesNo.push(true);
		await harden({ passwdPath: passwd });
		expect(out).toMatch(/✗ The backup folder .* has characters the commands/);
		expect(out).toContain('sudo morphit-ops harden');
		for (const l of out.split('\n'))
			if (/^\s+(sudo|printf) /.test(l)) expect(l).not.toContain('touch');
		expect(out).not.toMatch(/sudo install -d -m 700 -o morphit -g morphit \/srv/);
		expect(out).not.toMatch(/ReadWritePaths=\/srv/);
		expect(existsSync(join(root, 'ops', 'backup', 'backup.env'))).toBe(false);
	});

	it('a plain backup folder outside the home still gets its commands', async () => {
		const passwd = join(root, 'passwd');
		writeFileSync(passwd, 'morphit:x:999:999::/var/lib/morphit:/usr/sbin/nologin\n');
		typed.set('Backup directory', '/srv/morphit-backups_1.0');
		choices.push(3, 9);
		yesNo.push(true);
		await harden({ passwdPath: passwd });
		expect(out).toContain('sudo install -d -m 700 -o morphit -g morphit /srv/morphit-backups_1.0');
		expect(out).toMatch(/ReadWritePaths=\/srv\/morphit-backups_1\.0/);
	});

	describe('seed this release to IPFS', () => {
		function hiddenOnlyNode(): void {
			const envRoot = mkdtempSync(join(tmpdir(), 'morphit-harden-env-'));
			mkdirSync(join(envRoot, 'etc', 'morphit'), { recursive: true });
			writeFileSync(
				join(envRoot, 'etc', 'morphit', 'indexer.env'),
				'MORPHIT_INDEXER_RPC_ENDPOINTS=\n'
			);
			vi.stubEnv('MORPHIT_ENV_ROOT', envRoot);
		}

		it('hidden-only, no local copy: says the next upgrade seeds it — no command that cannot work, no "anchored CID" claim', async () => {
			hiddenOnlyNode();
			choices.push(5, 9);
			await harden({ serviceState: () => 'active' });
			expect(out).not.toMatch(/morphit-ipfs-seed\.sh/);
			expect(out).not.toMatch(/anchored CID|matches the release/);
			expect(out).toMatch(/needs a local copy of the/);
			expect(out).toContain('sudo morphit-ops upgrade');
		});

		it('hidden-only with the bundled copy: the command stages it, and says the CID is not cross-checked', async () => {
			hiddenOnlyNode();
			mkdirSync(join(root, '.canonical-release'));
			writeFileSync(join(root, '.canonical-release', 'morphit-v1.2.3.tar.gz'), 'x');
			choices.push(5, 9);
			await harden({ serviceState: () => 'active' });
			expect(out).toContain(
				`MORPHIT_SEED_HIDDEN_ONLY=1 MORPHIT_STAGE_TARBALL=${root}/.canonical-release/morphit-v1.2.3.tar.gz sh ${root}/ops/ipfs/morphit-ipfs-seed.sh v1.2.3`
			);
			expect(out).toMatch(/NOT\s+cross-checked/);
			expect(out).not.toMatch(/anchored CID|matches the release/);
		});

		it('no release-info.json: names the file it really looked for', async () => {
			const install = mkdtempSync(join(tmpdir(), 'morphit-harden-install-'));
			vi.stubEnv('MORPHIT_INSTALL_DIR', install);
			choices.push(5, 9);
			await harden({ serviceState: () => 'active' });
			expect(out.replace(/\s+/g, ' ')).toContain(`${install}/release-info.json`);
			expect(out).not.toContain(`no release-info.json in`);
		});
	});
});
