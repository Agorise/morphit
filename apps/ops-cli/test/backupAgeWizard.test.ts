/**
 * The install wizard offers to encrypt the daily database backups with an age
 * public key: without one they are
 * written in plain text and kept for weeks.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const av = await import('../src/init/ansibleVars.ts');
const { collectInstallInputs } = await import('../src/init/collectInstallInputs.ts');

// The X25519 recipient from age's own documentation.
const RECIPIENT = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

const validate = (s: string): true | string =>
	(av as unknown as { validateAgeRecipient: (s: string) => true | string }).validateAgeRecipient(s);

async function wizard(
	answer: string
): Promise<{ res: Record<string, unknown>; asked: string[]; out: string }> {
	const asked: string[] = [];
	const out: string[] = [];
	const res = await collectInstallInputs(
		{
			mode: 'vps',
			torOnly: false,
			operatorAccount: 'opacct',
			operatorTag: 'optag',
			feesAccount: 'feesacct',
			keystorePath: '/etc/morphit/relay.keystore'
		},
		{
			ask: (async (q: string, def?: string) => {
				asked.push(q);
				if (/age public key/i.test(q)) return answer;
				if (/Instance title/.test(q)) return 'Morphit Test';
				if (/web address/.test(q)) return 'trade.example.org';
				if (/email/i.test(q)) return 'me@example.org';
				return def ?? '';
			}) as never,
			askChoice: (async () => 0) as never,
			askSecret: (async () => '') as never,
			examples: () => {},
			print: (s: string) => void out.push(s),
			dnsCheck: async () => ({ ok: true, note: '' })
		} as never
	);
	return { res: res as unknown as Record<string, unknown>, asked, out: out.join('\n') };
}

describe('backup encryption in the install wizard', () => {
	it('asks for an age public key and passes it to the install', async () => {
		const { res, asked, out } = await wizard(RECIPIENT);
		expect(
			asked.some((q) => /age public key/i.test(q)),
			'the wizard never offered backup encryption'
		).toBe(true);
		expect(out).toMatch(/plain text/i);
		expect(res.backupAgeRecipient).toBe(RECIPIENT);
		const vars = av.buildAnsibleVars(res as never);
		expect(vars.morphit_backup_age_recipient).toBe(RECIPIENT);
		expect(av.validateInstallInputs(res as never)).toEqual([]);
	});

	it('Enter keeps plain-text backups and sets nothing', async () => {
		const { res } = await wizard('');
		expect(res.backupAgeRecipient).toBeUndefined();
		expect(av.buildAnsibleVars(res as never).morphit_backup_age_recipient).toBeUndefined();
	});

	it('accepts only an age public key, and refuses a pasted SECRET key', () => {
		expect(validate(RECIPIENT)).toBe(true);
		expect(validate(`AGE-SECRET-KEY-1${'Q'.repeat(58)}`)).toMatch(/secret/i);
		expect(validate('age1notakey')).not.toBe(true);
		expect(validate(`${RECIPIENT} ; rm -rf /`)).not.toBe(true);
		const base = {
			mode: 'vps',
			torOnly: true,
			domain: '',
			instanceName: 'Morphit Test',
			operatorAccount: 'opacct',
			operatorTag: 'optag',
			feesAccount: 'feesacct',
			keystorePath: '/etc/morphit/relay.keystore',
			indexerDbPassword: 'x'.repeat(32),
			acmeEmail: '',
			autoRegister: false
		};
		expect(av.validateInstallInputs(base as never)).toEqual([]);
		expect(
			av.validateInstallInputs({ ...base, backupAgeRecipient: 'nope' } as never).join('\n')
		).toMatch(/age/);
	});

	it('a key from this machine’s age-keygen is accepted (when age is installed)', () => {
		const r = spawnSync('age-keygen', [], { encoding: 'utf8' });
		if (r.status !== 0) return;
		const pub = /public key: (age1\S+)/.exec(`${r.stderr}${r.stdout}`)?.[1] ?? '';
		expect(validate(pub)).toBe(true);
	});
});
