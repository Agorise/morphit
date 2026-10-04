/**
 * The Matrix alert bot on a tor-only node:
 * a tor-only node never talks to the clearnet, so its bot may only use a
 * homeserver on this machine or a .onion one, reached through Tor.
 *
 *  - the install wizard offers no clearnet homeserver (it used to default to
 *    https://matrix.org) and the vars builder refuses one;
 *  - `morphit-ops matrix setup` refuses one before any login, and writes the
 *    tor-only flag and Tor route for the bot;
 *  - the bot's readiness says "do not run" for a clearnet homeserver once the
 *    flag is set (so an upgrade does not start it again);
 *  - the upgrade heal for installed boxes stops a clearnet bot unless the
 *    operator types KEEP-CLEARNET, and records the decision.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	buildAnsibleVars,
	validateInstallInputs,
	type AnsibleInstallInputs
} from '../src/init/ansibleVars.ts';
import { collectInstallInputs } from '../src/init/collectInstallInputs.ts';
import { matrixBotReadiness, parseMatrixBotEnvText } from '../src/lib/matrixBot.ts';

const ONION = `http://${'a'.repeat(56)}.onion`;

function inputs(over: Partial<AnsibleInstallInputs>): AnsibleInstallInputs {
	return {
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
		matrixAlertHomeserver: 'https://matrix.org',
		matrixAlertToken: 'syt_secret',
		matrixAlertMxid: '@me:example.org',
		...over
	} as AnsibleInstallInputs;
}

describe('install vars on a tor-only node', () => {
	it('a clearnet homeserver does not switch the bot on, and is reported', () => {
		const v = buildAnsibleVars(inputs({}));
		expect(v.enable_matrix_bot, 'tor-only node got a clearnet Matrix bot').toBeUndefined();
		expect(validateInstallInputs(inputs({})).join('\n')).toMatch(
			/homeserver https:\/\/matrix\.org/
		);
	});

	it('a .onion homeserver switches it on, through Tor', () => {
		const v = buildAnsibleVars(inputs({ matrixAlertHomeserver: ONION }));
		expect(v.enable_matrix_bot).toBe(true);
		expect(v.matrix_bot_tor_only).toBe(true);
		expect(v.matrix_bot_socks_proxy).toBe('socks5h://127.0.0.1:9050');
		expect(validateInstallInputs(inputs({ matrixAlertHomeserver: ONION })).join('\n')).not.toMatch(
			/homeserver/
		);
	});

	it('a clearnet node keeps matrix.org, with no Tor settings', () => {
		const v = buildAnsibleVars(inputs({ torOnly: false, domain: 'trade.example.com' }));
		expect(v.enable_matrix_bot).toBe(true);
		expect(v.matrix_bot_tor_only).toBeUndefined();
	});
});

describe('the install wizard on a tor-only node', () => {
	async function run(answers: Record<string, string>, torOnly = true) {
		const asked: string[] = [];
		const out: string[] = [];
		const res = await collectInstallInputs(
			{
				mode: 'vps',
				torOnly,
				operatorAccount: 'opacct',
				operatorTag: 'optag',
				feesAccount: 'feesacct',
				keystorePath: '/etc/morphit/relay.keystore'
			},
			{
				ask: (async (q: string, def?: string) => {
					asked.push(q);
					for (const [re, a] of Object.entries(answers)) if (new RegExp(re).test(q)) return a;
					if (/Instance title/.test(q)) return 'Morphit Test';
					if (/email/i.test(q)) return 'me@example.org';
					return def ?? '';
				}) as never,
				askChoice: (async () => 0) as never,
				askSecret: (async () => 'syt_secret') as never,
				examples: () => {},
				print: (s: string) => void out.push(s),
				dnsCheck: async () => ({ ok: true, note: '' })
			}
		);
		return { res, asked, out: out.join('\n') };
	}

	it('pressing Enter at the homeserver does not give a clearnet bot', async () => {
		const { res } = await run({ 'Send alerts': '@me:example.org' });
		expect(res.matrixAlertHomeserver, 'defaulted to a clearnet homeserver').toBeUndefined();
		expect(buildAnsibleVars(res).enable_matrix_bot).toBeUndefined();
	});

	it('matrix.org is refused; a .onion is taken', async () => {
		const seq = ['https://matrix.org', ONION];
		const asked: string[] = [];
		const prints: string[] = [];
		const r = await collectInstallInputs(
			{
				mode: 'vps',
				torOnly: true,
				operatorAccount: 'opacct',
				operatorTag: 'optag',
				feesAccount: 'feesacct',
				keystorePath: '/etc/morphit/relay.keystore'
			},
			{
				ask: (async (q: string, def?: string) => {
					asked.push(q);
					if (/Alert bot homeserver/.test(q)) return seq.shift() ?? '';
					if (/Send alerts/.test(q)) return '@me:example.org';
					if (/Instance title/.test(q)) return 'Morphit Test';
					return def ?? '';
				}) as never,
				askChoice: (async () => 0) as never,
				askSecret: (async () => 'syt_secret') as never,
				examples: () => {},
				print: (s: string) => void prints.push(s),
				dnsCheck: async () => ({ ok: true, note: '' })
			}
		);
		expect(prints.join('\n')).toMatch(/clearnet homeserver/);
		expect(r.matrixAlertHomeserver).toBe(ONION);
		expect(buildAnsibleVars(r).matrix_bot_tor_only).toBe(true);
	});
});

describe('bot readiness', () => {
	const env = (extra: string) =>
		({
			exists: true,
			...parseMatrixBotEnvText(
				`MORPHIT_MATRIX_BOT_ALERT_MXID=@me:example.org\nMORPHIT_MATRIX_BOT_ACCESS_TOKEN=syt_x\n${extra}`
			)
		}) as Parameters<typeof matrixBotReadiness>[0];

	it('does not run a clearnet homeserver on a node flagged tor-only', () => {
		const r = matrixBotReadiness(
			env('MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\nMORPHIT_MATRIX_BOT_TOR_ONLY=1\n')
		);
		expect(r.run).toBe(false);
	});

	it('runs a .onion homeserver with a Tor route, and anything without the flag', () => {
		expect(
			matrixBotReadiness(
				env(
					`MORPHIT_MATRIX_BOT_HOMESERVER=${ONION}\nMORPHIT_MATRIX_BOT_TOR_ONLY=1\nMORPHIT_MATRIX_BOT_SOCKS_PROXY=socks5h://127.0.0.1:9050\n`
				)
			).run
		).toBe(true);
		expect(matrixBotReadiness(env('MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n')).run).toBe(
			true
		);
	});
});

describe('morphit-ops matrix setup on a tor-only node', () => {
	async function setup(homeserver: string) {
		const { configureMatrixAlerts } = await import('../src/commands/matrix.ts');
		const mint = vi.fn(async () => 'syt_minted');
		const writeCreds = vi.fn(() => true);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const answers = ['@me:example.org', homeserver, 'syt_pasted'];
		const rc = await configureMatrixAlerts(false, {
			isTTY: true,
			torOnly: () => true,
			torSocks: () => '127.0.0.1:9150',
			ask: async () => answers.shift() ?? '',
			askChoice: async () => 0,
			askPassword: async () => 'pw',
			mint: mint as never,
			writeCreds: writeCreds as never,
			writeConfig: () => true,
			sync: () => ({ action: 'enable-restart', ok: true }),
			selfTest: async () => ({ ok: true }) as never
		} as never);
		return { rc, mint, writeCreds };
	}

	it('refuses a clearnet homeserver before any login', async () => {
		const { rc, mint, writeCreds } = await setup('https://matrix.org');
		expect(rc).toBe(1);
		expect(mint, 'logged in to a clearnet homeserver from a tor-only node').not.toHaveBeenCalled();
		expect(writeCreds).not.toHaveBeenCalled();
	});

	it('takes a .onion homeserver with a pasted token and writes the Tor route', async () => {
		const { mint, writeCreds } = await setup(ONION);
		expect(mint).not.toHaveBeenCalled();
		expect(writeCreds).toHaveBeenCalledTimes(1);
		const extra = (writeCreds.mock.calls[0] as unknown[])[3] as Record<string, string>;
		expect(extra).toMatchObject({
			MORPHIT_MATRIX_BOT_HOMESERVER: ONION,
			MORPHIT_MATRIX_BOT_TOR_ONLY: '1',
			MORPHIT_MATRIX_BOT_SOCKS_PROXY: 'socks5h://127.0.0.1:9150'
		});
	});
});
