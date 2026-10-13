/**
 * The guided install remembers its non-secret answers, so a run stopped
 * part-way (Ctrl+C, a dropped connection, a failed install) does not ask them
 * all again — and never writes a secret to disk.
 *
 * 2026-10-12, a live install: Ctrl+C at step 11 sent the operator back to step 1.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stepsShown = 0;
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	step: () => void stepsShown++
}));

const { collectInstallInputs } = await import('../src/init/collectInstallInputs.ts');
const ip = await import('../src/init/installProgress.ts');
const { offerResume } = await import('../src/init/runAnsibleInstall.ts');

const KNOWN = {
	operatorAccount: 'vigil-relay',
	operatorTag: 'vigil-relay',
	feesAccount: 'vigil-fees',
	keystorePath: '/etc/morphit/relay.keystore'
} as const;
const AGE = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';
const TOKEN = 'syt_c2VjcmV0_bottoken_123';
const DDNS = 'https://njal.la/update/?h=trade.example.org&k=SECRETKEY&a={ip}';

type Asked = string[];
function deps(asked: Asked, remembered: object[], saved?: object) {
	return {
		ask: (async (q: string, def?: string) => {
			asked.push(q);
			if (/Instance title/.test(q)) return 'Vigilante Trading';
			if (/web address/.test(q)) return 'vigilante.trading';
			if (/description/.test(q)) return 'No-KYC trading';
			if (/Matrix account or room/.test(q)) return '@ops:matrix.org';
			if (/email/i.test(q)) return 'ops@vigilante.trading';
			if (/dynamic-DNS/.test(q)) return DDNS;
			if (/age public key/i.test(q)) return AGE;
			if (/homeserver/.test(q)) return 'https://matrix.org';
			if (/Send alerts to/.test(q)) return '@ops:matrix.org';
			return def ?? '';
		}) as never,
		askChoice: (async () => 0) as never,
		askSecret: (async () => TOKEN) as never,
		examples: () => {},
		print: () => {},
		dnsCheck: async () => ({ ok: true, note: '' }),
		remember: (a: object) => void remembered.push(a),
		...(saved ? { saved } : {})
	} as never;
}

describe('the guided install remembers its answers', () => {
	it('a fresh run remembers each non-secret answer as it is given — and no secret', async () => {
		const asked: Asked = [];
		const remembered: object[] = [];
		const res = await collectInstallInputs(
			{ mode: 'home', torOnly: false, ...KNOWN },
			deps(asked, remembered)
		);
		const all = Object.assign({}, ...remembered);
		expect(all).toEqual({
			domain: 'vigilante.trading',
			instanceName: 'Vigilante Trading',
			instanceTagline: 'No-KYC trading',
			matrixAddress: '@ops:matrix.org',
			acmeEmail: 'ops@vigilante.trading',
			backupAgeRecipient: AGE
		});
		const text = JSON.stringify(remembered);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain('SECRETKEY');
		expect(text).not.toContain((res as { indexerDbPassword: string }).indexerDbPassword);
	});

	it('a resumed run reuses them, asking only the secret steps, with the same step count', async () => {
		const first: Asked = [];
		const remembered: object[] = [];
		stepsShown = 0;
		const a = await collectInstallInputs(
			{ mode: 'home', torOnly: false, ...KNOWN },
			deps(first, remembered)
		);
		const freshSteps = stepsShown;

		const again: Asked = [];
		stepsShown = 0;
		const b = await collectInstallInputs(
			{ mode: 'home', torOnly: false, ...KNOWN },
			deps(again, [], Object.assign({}, ...remembered))
		);
		expect(stepsShown).toBe(freshSteps);
		// Only the alerts step (its token is never saved) and the DDNS URL.
		expect(again.every((q) => /homeserver|Send alerts to|dynamic-DNS/.test(q))).toBe(true);
		expect(again.some((q) => /dynamic-DNS/.test(q))).toBe(true);
		const pick = (r: object) => {
			const { indexerDbPassword: _p, ...rest } = r as Record<string, unknown>;
			return rest;
		};
		expect(pick(b)).toEqual(pick(a));
		// A new database password every run.
		expect((b as { indexerDbPassword: string }).indexerDbPassword).not.toBe(
			(a as { indexerDbPassword: string }).indexerDbPassword
		);
	});

	it('a skipped optional answer is remembered as skipped', async () => {
		const asked: Asked = [];
		await collectInstallInputs(
			{ mode: 'vps', torOnly: false, ...KNOWN },
			deps(asked, [], {
				domain: 'vigilante.trading',
				instanceName: 'Vigilante Trading',
				instanceTagline: '',
				matrixAddress: '',
				acmeEmail: 'ops@vigilante.trading',
				backupAgeRecipient: ''
			})
		).then((r) => {
			const res = r as unknown as Record<string, unknown>;
			expect(res.instanceTagline).toBeUndefined();
			expect(res.contactUrl).toBeUndefined();
			expect(res.backupAgeRecipient).toBeUndefined();
		});
		expect(asked.some((q) => /description|age public key|Matrix account or room/.test(q))).toBe(
			false
		);
	});

	it('a saved answer that no longer passes its check is asked again', async () => {
		const asked: Asked = [];
		const res = await collectInstallInputs(
			{ mode: 'vps', torOnly: false, ...KNOWN },
			deps(asked, [], { domain: 'not a domain', acmeEmail: 'nope', backupAgeRecipient: 'age1bad' })
		);
		expect(asked.some((q) => /web address/.test(q))).toBe(true);
		expect(asked.some((q) => /email/i.test(q))).toBe(true);
		expect(asked.some((q) => /age public key/i.test(q))).toBe(true);
		expect((res as { domain: string }).domain).toBe('vigilante.trading');
	});
});

describe('the progress file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-install-progress-'));
	const path = join(dir, 'progress.json');

	it('is written 0600, merges answers, and reads back only known fields', () => {
		ip.rememberInstallAnswers({ mode: 'vps', relayAccount: 'vigil-relay' }, path);
		ip.rememberInstallAnswers({ domain: 'vigilante.trading' }, path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(ip.loadInstallProgress(path)?.answers).toEqual({
			mode: 'vps',
			relayAccount: 'vigil-relay',
			domain: 'vigilante.trading'
		});
	});

	it('anything else in the file — a key, a token — is never read back or written again', () => {
		const raw = JSON.parse(readFileSync(path, 'utf8'));
		raw.answers.activeKey = '5KSECRETWIF';
		raw.answers.matrixAlertToken = TOKEN;
		raw.answers.ddnsUpdateUrl = DDNS;
		raw.answers.mode = 'mainframe';
		writeFileSync(path, JSON.stringify(raw));
		const back = ip.loadInstallProgress(path)!.answers as Record<string, unknown>;
		expect(back).toEqual({ relayAccount: 'vigil-relay', domain: 'vigilante.trading' });
		// Even handed one by a caller, a secret is not written.
		ip.rememberInstallAnswers(
			{ feesAccount: 'vigil-fees', activeKey: '5KSECRETWIF', matrixAlertToken: TOKEN } as never,
			path
		);
		const text = readFileSync(path, 'utf8');
		expect(text).not.toContain('5KSECRETWIF');
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain('SECRETKEY');
	});

	it('a broken or foreign file is ignored, and clear removes it', () => {
		writeFileSync(path, '{not json');
		expect(ip.loadInstallProgress(path)).toBeNull();
		writeFileSync(path, JSON.stringify({ version: 2, answers: { domain: 'x.org' } }));
		expect(ip.loadInstallProgress(path)).toBeNull();
		ip.clearInstallProgress(path);
		expect(existsSync(path)).toBe(false);
	});
});

describe('the next run', () => {
	const saved = {
		answers: {
			instanceName: 'Vigilante Trading',
			relayAccount: 'vigil-relay',
			domain: 'vigilante.trading'
		},
		savedAt: new Date().toISOString()
	};

	it('offers the saved answers and returns them on yes', async () => {
		const out: string[] = [];
		let cleared = false;
		const a = await offerResume({
			load: () => saved,
			clear: () => void (cleared = true),
			askYesNo: async () => true,
			print: (s) => void out.push(s)
		});
		expect(a).toEqual(saved.answers);
		expect(cleared).toBe(false);
		expect(out.join('\n')).toContain('Vigilante Trading');
		expect(out.join('\n')).toMatch(/active key/);
	});

	it('on no, deletes them and starts fresh', async () => {
		let cleared = false;
		const a = await offerResume({
			load: () => saved,
			clear: () => void (cleared = true),
			askYesNo: async () => false,
			print: () => {}
		});
		expect(a).toEqual({});
		expect(cleared).toBe(true);
	});

	it('with nothing saved, asks nothing', async () => {
		const a = await offerResume({
			load: () => null,
			askYesNo: async () => {
				throw new Error('asked');
			},
			print: () => {}
		});
		expect(a).toEqual({});
	});
});
