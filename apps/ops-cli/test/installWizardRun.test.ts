/**
 * The REAL guided install (runAnsibleInstall), run end to end with only what
 * touches the machine stood in: the prompts answer from a table, the playbook
 * "succeeds", every command it runs is recorded instead of run, and files under
 * /opt/morphit, /etc/morphit and /var/lib/morphit land in a temporary folder.
 *
 * It replaces tests that matched the wizard's source text, which a rewrite that
 * kept the text but broke the behaviour passed (review, 2026-10-12: ten such
 * rewrites — resume ignored, fast-sync never offered, the canary always "Later",
 * a Tor-only node listed as a bare https://, … — all passed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as realFs from 'node:fs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { ROOT, S } = vi.hoisted(() => {
	const fs = require('node:fs') as typeof import('node:fs');
	const os = require('node:os') as typeof import('node:os');
	const path = require('node:path') as typeof import('node:path');
	const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-run-'));
	process.env.HOME = path.join(ROOT, 'home');
	fs.mkdirSync(process.env.HOME, { recursive: true });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const S: any = {};
	return { ROOT, S };
});
const redirect = (p: unknown): unknown =>
	typeof p === 'string' && /^\/(opt\/morphit|etc\/morphit|var\/lib\/morphit)/.test(p)
		? join(ROOT, 'sys', p)
		: p;

vi.mock('node:fs', async (orig) => {
	const fs = (await orig()) as typeof import('node:fs');
	const wrap =
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		<F extends (...a: any[]) => any>(f: F) =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(...a: any[]) =>
				f(redirect(a[0]), ...a.slice(1));
	const out = {
		...fs,
		existsSync: wrap(fs.existsSync),
		readFileSync: wrap(fs.readFileSync),
		writeFileSync: wrap(fs.writeFileSync),
		rmSync: wrap(fs.rmSync),
		mkdirSync: wrap(fs.mkdirSync),
		chownSync: () => undefined
	};
	return { ...out, default: out };
});

vi.mock('node:child_process', async (orig) => {
	const cp = (await orig()) as typeof import('node:child_process');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const spawnSync = (cmd: string, args: string[] = [], opts: any = {}) => {
		S.spawned.push({ cmd, args, env: opts?.env, stdio: opts?.stdio });
		const r = S.spawnResult(cmd, args);
		return { stdout: '', stderr: '', pid: 1, output: [], signal: null, status: 0, ...r };
	};
	const out = { ...cp, spawnSync };
	return { ...out, default: out };
});

vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as typeof import('../src/init/prompt.ts');
	const ask = async (q: string, def?: string): Promise<string> => {
		S.asked.push(q);
		for (const [re, a] of S.answers as [RegExp, string | Error][]) {
			if (re.test(q)) {
				if (a instanceof Error) throw a;
				return a;
			}
		}
		return def ?? '';
	};
	return {
		...real,
		ask,
		askPassword: async () => '',
		askChoice: async (q: string, choices: readonly string[], def?: number) => {
			S.asked.push(`[choice] ${q} :: ${choices.join(' | ')}`);
			for (const [re, i] of S.choices as [RegExp, number | Error][]) {
				if (re.test(q) || re.test(choices.join('|'))) {
					if (i instanceof Error) throw i;
					return i;
				}
			}
			return def ?? 0;
		},
		step: (n: number, t: number, title: string) => {
			S.steps.push(title);
			real.step(n, t, title);
		},
		examples: () => undefined
	};
});
vi.mock('../src/init/steps.ts', async () => {
	const { step } = await import('../src/init/prompt.ts');
	return {
		stepRelayAccount: async () => {
			step(0, 0, "Your relay's Blurt account");
			return { name: 'vigil-relay' };
		},
		stepActiveKey: async () => {
			step(0, 0, 'Active key');
			return { mode: 'plaintext', plaintextWif: '5KTESTWIF' };
		},
		stepFeesAccount: async () => {
			step(0, 0, 'Fees account');
			return 'vigil-fees';
		}
	};
});
vi.mock('../src/init/systemCheck.ts', () => ({
	checkDomainPointsHere: async () => {
		S.duringDnsCheck?.();
		return { ok: true, note: '' };
	}
}));
vi.mock('../src/init/saveSecrets.ts', () => ({
	promptSaveSecrets: async (secrets: unknown) => {
		S.secrets = secrets;
		if (S.saveAbort instanceof Error) throw S.saveAbort;
	}
}));
vi.mock('../src/init/assembleInstall.ts', async (orig) => ({
	...(await orig<typeof import('../src/init/assembleInstall.ts')>()),
	assembleInstall: async () => {
		S.order.push('playbook');
		S.progressAtPlaybook = realFs.existsSync(
			join(process.env.HOME!, '.morphit-install-progress.json')
		);
		return S.playbook;
	},
	currentInstallRestartCommand: () => 'cd /root/morphit && sudo bash morphit-setup.sh'
}));
vi.mock('../src/init/reachabilityRevert.ts', () => ({
	armReachabilityRevert: () => {
		S.order.push('arm');
		return { armed: false };
	},
	confirmReachabilityOrRevert: async () => {
		S.order.push('confirm');
		if (S.sshAnswer instanceof Error) throw S.sshAnswer;
	}
}));
vi.mock('../src/lib/torOnlyRekey.ts', () => ({
	offerTorOnlyRekey: async () => void (S.rekeyOffered = true),
	readPriorIdentity: () => null
}));
vi.mock('../src/lib/spinRun.ts', () => ({
	runSpinning: async () => ({ status: 0, stdout: '', stderr: '', error: null }),
	showOutput: () => undefined,
	sleepMs: async () => undefined,
	systemctlSpinning: async (_l: string, args: string[]) => {
		S.systemctl.push(args.join(' '));
		return { status: 0, error: null };
	}
}));
vi.mock('../src/commands/fastSync.ts', () => ({
	FAST_SYNC_REPLACED_UNUSABLE: 4,
	fastSyncFromChain: () => {
		S.fastSyncCalls++;
		S.duringFastSync?.();
		return S.fastSyncRc;
	},
	stopIndexerAndWait: async () => true,
	// The stop/restore/start itself is tested in installFastSync.test.ts; here
	// only that the indexer is started again unless the restore must not be
	// served.
	withServicesStopped: async (
		_running: unknown,
		restore: () => number | Promise<number>
	): Promise<number> => {
		S.systemctl.push('stop morphit-indexer');
		let rc = 1;
		try {
			rc = await restore();
			return rc;
		} finally {
			if (rc !== 4) S.systemctl.push('start morphit-indexer');
		}
	},
	serviceActive: () => false,
	localIndexerHealthBase: () => 'http://127.0.0.1:8081'
}));
vi.mock('../src/init/installSummary.ts', async (orig) => {
	const real = (await orig()) as typeof import('../src/init/installSummary.ts');
	return {
		...real,
		collectInstallSummary: async () => S.summaryRows,
		readLocalIndexerHealth: async () => {
			S.healthReads++;
			S.duringHealthRead?.();
			return { ...S.health, synced: false, fxOk: true };
		},
		printInstallSummary: () => void (S.reviewShown = true)
	};
});

const { runAnsibleInstall } = await import('../src/init/runAnsibleInstall.ts');
const { abortError } = await import('../src/init/prompt.ts');
const { describeInstallError } = await import('../src/init/assembleInstall.ts');

function rows(online: boolean): unknown[] {
	return [
		{ label: 'Marketplace database (PostgreSQL)', ok: true },
		{ label: 'Signup relay — service', ok: true },
		{ label: 'Blurt RPC connectivity', ok: online ? true : null },
		{ label: 'Website (front end)', ok: true },
		{ label: 'PGP contact key (/pgp_keys.asc)', ok: false }
	];
}
const sys = (p: string): string => join(ROOT, 'sys', p);
const firstOnlineEnv = (): string =>
	realFs.readFileSync(sys('/etc/morphit/first-online.env'), 'utf8');
const spawnedArgs = (re: RegExp) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	S.spawned.filter((s: any) => re.test([s.cmd, ...s.args].join(' ')));
/** Call the SIGINT listeners the wizard added (a Ctrl+C), not the runner's. */
function ctrlC(baseline: Set<unknown>): void {
	for (const l of process.listeners('SIGINT')) if (!baseline.has(l)) (l as () => void)();
}

beforeEach(() => {
	S.answers = [
		[/Instance title/, 'Vigilante Trading'],
		[/web address/, 'vigilante.trading'],
		[/Your email address/, 'ops@vigilante.trading'],
		[/Type YES/, 'YES']
	];
	S.choices = [];
	S.asked = [];
	S.spawned = [];
	S.spawnResult = () => ({ status: 0 });
	S.summaryRows = rows(true);
	S.health = { reachable: true, rpcOk: true };
	S.healthReads = 0;
	S.fastSyncCalls = 0;
	S.fastSyncRc = 0;
	S.duringFastSync = null;
	S.duringHealthRead = null;
	S.duringDnsCheck = null;
	S.steps = [];
	S.systemctl = [];
	S.playbook = { ok: true };
	S.sshAnswer = null;
	S.secrets = null;
	S.saveAbort = null;
	S.rekeyOffered = false;
	S.reviewShown = false;
	S.progressAtPlaybook = null;
	S.order = [];
	realFs.rmSync(join(ROOT, 'sys'), { recursive: true, force: true });
	realFs.rmSync(join(process.env.HOME!, '.morphit-install-progress.json'), { force: true });
	mkdirSync(sys('/etc/morphit'), { recursive: true });
	mkdirSync(sys('/opt/morphit'), { recursive: true });
	writeFileSync(sys('/etc/morphit/first-online.env'), 'MORPHIT_AUTO_REGISTER=no\n');
});

function where(mode: 'home' | 'vps', torOnly: boolean): void {
	S.choices.push([/Where will this node run/, mode === 'home' ? 0 : 1]);
	S.choices.push([/How will people reach/, torOnly ? 1 : 0]);
	if (mode === 'home') S.answers.push([/dynamic-DNS/, 'https://example.org/update?ip={ip}']);
}

async function install(): Promise<{ rc: number; out: string; errs: string[] }> {
	const lines: string[] = [];
	const errs: string[] = [];
	const log = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
	const err = vi.spyOn(console, 'error').mockImplementation((...a) => void errs.push(a.join(' ')));
	const wr = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	try {
		const repo = mkdtempSync(join(ROOT, 'release-'));
		const rc = await runAnsibleInstall({ repoRoot: repo, keystorePath: join(ROOT, 'ks') });
		return { rc, out: lines.join('\n'), errs };
	} finally {
		log.mockRestore();
		err.mockRestore();
		wr.mockRestore();
	}
}

describe('a fresh VPS, online', () => {
	it('every step runs, and the step count it announced is right', async () => {
		where('vps', false);
		const { rc, errs } = await install();
		expect(rc).toBe(0);
		expect(errs.filter((e) => /internal: wizard showed/.test(e))).toEqual([]);
		expect(S.reviewShown).toBe(true);
	});

	it('fast-sync is offered and runs (the indexer started again after it)', async () => {
		where('vps', false);
		await install();
		expect(S.fastSyncCalls).toBe(1);
		expect(S.systemctl).toContain('start morphit-indexer');
	});

	it('the canary, "here": same-box setup for the served site, first publish not deferred', async () => {
		where('vps', false);
		S.choices.push([/Here on this server/, 0]);
		await install();
		const setup = spawnedArgs(/canary\/setup\.sh/);
		expect(setup).toHaveLength(1);
		expect(setup[0].env).toMatchObject({
			MORPHIT_CANARY_MODE: 'local',
			MORPHIT_CANARY_SERVE_DIR: '/opt/morphit/apps/web/build',
			MORPHIT_CANARY_INSTANCE_ORIGIN: 'https://vigilante.trading',
			MORPHIT_CANARY_DEFER_FIRST_REFRESH: ''
		});
	});

	it('the canary, "on my own computer" or "later": nothing runs here', async () => {
		where('vps', false);
		S.choices.push([/Here on this server/, 1]);
		await install();
		expect(spawnedArgs(/canary\/setup\.sh/)).toHaveLength(0);
	});

	it('listing: asked with the permanent tag, registered at once with the instance identity, Enter there lists it', async () => {
		where('vps', false);
		await install();
		expect(S.asked.find((q: string) => /List this instance/.test(q))).toMatch(
			/vigil-relay.*permanent/
		);
		const reg = spawnedArgs(/morphit-ops register/);
		expect(reg).toHaveLength(1);
		expect(reg[0].args).toEqual(['register', '--default-yes']);
		expect(reg[0].env).toMatchObject({
			MORPHIT_RELAY_ACCOUNT: 'vigil-relay',
			MORPHIT_INSTANCE_ORIGIN: 'https://vigilante.trading',
			MORPHIT_INSTANCE_NAME: 'Vigilante Trading'
		});
		expect(firstOnlineEnv()).toMatch(/MORPHIT_AUTO_REGISTER=no/);
	});

	it('listing: declined at register’s question, or stopped there with Ctrl+C, is NOT queued', async () => {
		for (const r of [{ status: 5 }, { status: 130 }, { status: null, signal: 'SIGINT' }]) {
			where('vps', false);
			S.spawnResult = (cmd: string, args: string[]) => (args[0] === 'register' ? r : { status: 0 });
			await install();
			expect(firstOnlineEnv(), JSON.stringify(r)).toMatch(/MORPHIT_AUTO_REGISTER=no/);
			writeFileSync(sys('/etc/morphit/first-online.env'), 'MORPHIT_AUTO_REGISTER=no\n');
			S.choices = [];
		}
	});

	it('listing: a register that fails is queued for first-online', async () => {
		where('vps', false);
		S.spawnResult = (cmd: string, args: string[]) =>
			args[0] === 'register' ? { status: 1 } : { status: 0 };
		await install();
		expect(firstOnlineEnv()).toMatch(/^MORPHIT_AUTO_REGISTER=yes$/m);
		expect(spawnedArgs(/^systemctl enable --now morphit-first-online\.timer$/)).toHaveLength(1);
	});

	it('branding: its own step, the installed command, on this terminal', async () => {
		where('vps', false);
		await install();
		const b = spawnedArgs(/morphit-ops branding setup/);
		expect(b).toHaveLength(1);
		expect(b[0].cmd).toBe('/usr/local/bin/morphit-ops');
		expect(b[0].stdio).toBe('inherit');
		expect(S.steps.indexOf('Brand your instance (optional)')).toBe(
			S.steps.indexOf('Review your node') - 1
		);
	});
});

describe('a chain connection that takes a while', () => {
	it('is waited for: fast-sync is offered once the indexer reaches the chain', async () => {
		where('vps', false);
		S.health = { reachable: true, rpcOk: false };
		S.duringHealthRead = () => {
			if (S.healthReads === 3) S.health = { reachable: true, rpcOk: true };
		};
		await install();
		expect(S.fastSyncCalls).toBe(1);
	});
});

describe('offline', () => {
	it('fast-sync is not tried, the canary is deferred, the listing is queued', async () => {
		where('vps', false);
		S.health = { reachable: true, rpcOk: false };
		S.summaryRows = rows(false);
		S.choices.push([/Here on this server/, 0]);
		await install();
		expect(S.fastSyncCalls).toBe(0);
		expect(spawnedArgs(/canary\/setup\.sh/)[0].env.MORPHIT_CANARY_DEFER_FIRST_REFRESH).toBe('1');
		expect(spawnedArgs(/morphit-ops register/)).toHaveLength(0);
		expect(firstOnlineEnv()).toMatch(/^MORPHIT_AUTO_REGISTER=yes$/m);
	});
});

describe('a Tor-only node whose .onion is not in its settings yet', () => {
	it('is never listed as a bare https:// — queued; the canary finds the origin itself', async () => {
		where('vps', true);
		S.choices.push([/Here on this server/, 0]);
		await install();
		expect(S.rekeyOffered).toBe(true);
		expect(spawnedArgs(/morphit-ops register/)).toHaveLength(0);
		expect(firstOnlineEnv()).toMatch(/^MORPHIT_AUTO_REGISTER=yes$/m);
		expect(spawnedArgs(/canary\/setup\.sh/)[0].env).not.toHaveProperty(
			'MORPHIT_CANARY_INSTANCE_ORIGIN'
		);
	});

	it('with its onion saved: listed under http://<onion>', async () => {
		where('vps', true);
		const onion = `${'a'.repeat(56)}.onion`;
		writeFileSync(
			sys('/opt/morphit/morphit.config.env'),
			`MORPHIT_INSTANCE_TOR_ADDRESS=${onion}\n`
		);
		await install();
		expect(spawnedArgs(/morphit-ops register/)[0].env.MORPHIT_INSTANCE_ORIGIN).toBe(
			`http://${onion}`
		);
	});

	it('at home: no bare https:// handed to the canary either', async () => {
		where('home', true);
		await install();
		expect(spawnedArgs(/canary\/setup\.sh/)[0].env).not.toHaveProperty(
			'MORPHIT_CANARY_INSTANCE_ORIGIN'
		);
	});
});

describe('the step counts', () => {
	for (const [mode, tor] of [
		['home', false],
		['home', true],
		['vps', true]
	] as const) {
		it(`${mode}${tor ? ', Tor-only' : ''}: as announced`, async () => {
			where(mode, tor);
			const { rc, errs } = await install();
			expect(rc).toBe(0);
			expect(errs.filter((e) => /internal: wizard showed/.test(e))).toEqual([]);
		});
	}
});

describe('resuming an interrupted install', () => {
	it('the saved answers are offered and reused, kept until the playbook ran, then removed', async () => {
		where('vps', false);
		writeFileSync(
			join(process.env.HOME!, '.morphit-install-progress.json'),
			JSON.stringify({
				version: 1,
				savedAt: new Date().toISOString(),
				answers: {
					mode: 'vps',
					torOnly: false,
					domain: 'vigilante.trading',
					instanceName: 'Vigilante Trading'
				}
			}),
			{ mode: 0o600 }
		);
		S.answers.unshift([/Reuse your saved answers/, 'y']);
		await install();
		expect(S.asked.some((q: string) => /Reuse your saved answers/.test(q))).toBe(true);
		expect(S.asked.some((q: string) => /web address/.test(q))).toBe(false);
		expect(S.progressAtPlaybook).toBe(true);
		expect(realFs.existsSync(join(process.env.HOME!, '.morphit-install-progress.json'))).toBe(
			false
		);
		// The password is new on every run: the save screen says so.
		expect(S.secrets[0].note).toMatch(/NEW password/);
	});

	it('"start fresh" over an earlier run, or a re-install: the save screen says the password is new', async () => {
		where('vps', false);
		writeFileSync(
			join(process.env.HOME!, '.morphit-install-progress.json'),
			JSON.stringify({
				version: 1,
				savedAt: new Date().toISOString(),
				answers: { mode: 'vps', torOnly: false, domain: 'vigilante.trading' }
			}),
			{ mode: 0o600 }
		);
		S.answers.unshift([/Reuse your saved answers/, 'n']);
		await install();
		// Before: nothing said, and the operator kept the earlier run's password.
		expect(S.secrets[0].note).toMatch(/NEW password/);

		S.choices = [];
		where('vps', false);
		writeFileSync(sys('/etc/morphit/indexer.env'), 'MORPHIT_INDEXER_CHAIN_ID=x\n');
		await install();
		expect(S.secrets[0].note).toMatch(/NEW password/);
	});

	it('a fresh run says nothing about a new password', async () => {
		where('vps', false);
		await install();
		expect(S.secrets[0].note).toBeUndefined();
	});
});

describe('the SSH safety net', () => {
	it('armed before the playbook, confirmed (or reverted) only after it succeeded', async () => {
		where('vps', false);
		await install();
		expect(S.order).toEqual(['arm', 'playbook', 'confirm']);
	});
});

describe('when the install itself fails', () => {
	it('says how to start it again, and keeps the answers', async () => {
		where('vps', false);
		S.playbook = { ok: false, reason: 'The install stopped (Ansible exit 2).' };
		const { rc, out } = await install();
		expect(rc).toBe(1);
		// A failed run never asks about SSH, so a revert is never scheduled.
		expect(S.order).toEqual(['arm', 'playbook']);
		expect(out).toContain('cd /root/morphit && sudo bash morphit-setup.sh');
		expect(realFs.existsSync(join(process.env.HOME!, '.morphit-install-progress.json'))).toBe(true);
	});
});

describe('Ctrl+C while the questions are asked', () => {
	it('at a wait (the DNS check): says so, keeps the answers, how to start again, exit 130', async () => {
		where('vps', false);
		const baseline = new Set<unknown>(process.listeners('SIGINT'));
		S.duringDnsCheck = () => ctrlC(baseline);
		const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
		try {
			const lines: string[] = [];
			const log = vi
				.spyOn(console, 'log')
				.mockImplementation((...a) => void lines.push(a.join(' ')));
			try {
				await expect(install()).rejects.toThrow('exit 130');
			} finally {
				log.mockRestore();
			}
			expect(exit).toHaveBeenCalledWith(130);
		} finally {
			exit.mockRestore();
		}
		expect(S.order).not.toContain('playbook');
		expect(process.listeners('SIGINT').filter((l) => !baseline.has(l))).toEqual([]);
	});
});

describe('Ctrl+C at the password step, after the relay key was saved', () => {
	it('says the key was saved and where — never "nothing was installed or changed"', async () => {
		where('vps', false);
		S.saveAbort = abortError();
		const err = await install().then(
			() => null,
			(e: unknown) => e
		);
		expect(err).not.toBeNull();
		expect(S.order).not.toContain('playbook');
		const msg = describeInstallError(err, false, 'sudo morphit-ops install');
		expect(msg).toContain(
			`Your relay key was saved to ${join(ROOT, 'ks')}; nothing else was installed.`
		);
		expect(msg).not.toContain('Nothing was installed or changed');
	});
});

describe('Ctrl+C after the node is installed', () => {
	it('at a question: installed (0), what is left is listed, never "start the install again"', async () => {
		where('vps', false);
		S.answers.unshift([/List this instance/, abortError()]);
		const { rc, out } = await install();
		expect(rc).toBe(0);
		expect(out).toMatch(/Your node is installed and running/);
		expect(out).toContain('sudo morphit-ops register');
		expect(out).toContain('sudo morphit-ops branding setup');
		expect(out).not.toContain('morphit-ops fast-sync'); // done already
		expect(out).not.toMatch(/morphit-setup\.sh/);
		expect(realFs.existsSync(join(process.env.HOME!, '.morphit-install-progress.json'))).toBe(
			false
		);
	});

	it('at the SSH question: the same', async () => {
		where('vps', false);
		S.sshAnswer = abortError();
		const { rc, out } = await install();
		expect(rc).toBe(0);
		expect(out).toContain('sudo morphit-ops fast-sync');
		expect(S.fastSyncCalls).toBe(0);
	});

	it('during the restore: it stops the restore only — the wizard goes on to its other steps', async () => {
		where('vps', false);
		const baseline = new Set<unknown>(process.listeners('SIGINT'));
		S.duringFastSync = () => ctrlC(baseline);
		S.fastSyncRc = 1;
		const { rc, out } = await install();
		expect(rc).toBe(0);
		expect(S.systemctl).toContain('start morphit-indexer');
		expect(spawnedArgs(/morphit-ops register/)).toHaveLength(1);
		expect(out).not.toMatch(/Stopped — you pressed Ctrl\+C/);
	});

	it('while waiting for first-online to finish its run, before the restore: the indexer starts again', async () => {
		where('vps', false);
		const baseline = new Set<unknown>(process.listeners('SIGINT'));
		let looks = 0;
		S.spawnResult = (cmd: string, args: string[]) => {
			if (
				cmd === 'systemctl' &&
				args[0] === 'show' &&
				args.includes('morphit-first-online.service')
			) {
				if (++looks === 2) ctrlC(baseline);
				return { status: 0, stdout: 'activating\n' };
			}
			return { status: 0 };
		};
		const { rc, out } = await install();
		expect(rc).toBe(0);
		expect(S.fastSyncCalls).toBe(0);
		// It had been stopped for the restore: nothing was changed, so it runs again.
		expect(S.systemctl).toContain('start morphit-indexer');
		expect(out).toMatch(/Stopped — you pressed Ctrl\+C/);
	});

	it('during a wait (no child running): the wizard stops there and lists what is left', async () => {
		where('vps', false);
		const baseline = new Set<unknown>(process.listeners('SIGINT'));
		S.health = { reachable: true, rpcOk: false };
		S.duringHealthRead = () => ctrlC(baseline);
		const { rc, out } = await install();
		expect(rc).toBe(0);
		expect(out).toMatch(/Stopped — you pressed Ctrl\+C/);
		expect(out).toContain('sudo morphit-ops fast-sync');
		expect(S.fastSyncCalls).toBe(0);
	});

	it('leaves no Ctrl+C listener behind', async () => {
		where('vps', false);
		const before = process.listenerCount('SIGINT');
		await install();
		expect(process.listenerCount('SIGINT')).toBe(before);
	});
});

describe('a restore that replaced the database but did not pass its checks (exit 4)', () => {
	it('a Ctrl+C later on never calls it "running", and fast-sync stays on the list, first', async () => {
		where('vps', false);
		S.fastSyncRc = 4;
		S.choices.push([/Here on this server/, abortError()]);
		const { rc, out } = await install();
		expect(rc).toBe(0);
		expect(out).not.toMatch(/installed and running/);
		expect(out).toMatch(/indexer stays stopped until a fast-sync succeeds/);
		const list = out.slice(out.indexOf('any time later'));
		expect(list).toMatch(/Fast-sync:\s+sudo morphit-ops fast-sync/);
		expect(list.indexOf('fast-sync')).toBeLessThan(list.indexOf('register'));
		expect(list).toMatch(/List it \(after fast-sync\):\s+sudo morphit-ops register/);
	});

	it('the indexer stays stopped, and the node is not listed', async () => {
		where('vps', false);
		S.fastSyncRc = 4;
		const { out } = await install();
		expect(S.systemctl).not.toContain('start morphit-indexer');
		expect(spawnedArgs(/morphit-ops register/)).toHaveLength(0);
		expect(firstOnlineEnv()).toMatch(/MORPHIT_AUTO_REGISTER=no/);
		expect(out).toMatch(/Not listing it now/);
		// Never "installed and running" with the indexer stopped.
		expect(out).not.toMatch(/installed and running/);
		expect(out).toMatch(/indexer stays stopped until a\s+fast-sync succeeds/);
	});
});
