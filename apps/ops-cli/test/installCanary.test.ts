/**
 * The guided install asks where the warrant canary is signed — on a VPS too.
 *
 * 2026-10-12, a fresh VPS: the canary step was offered on home installs only,
 * so the VPS ended with no canary, no /pgp_keys.asc, and nothing said how.
 */
import { describe, expect, it } from 'vitest';
import { offerServerCanary } from '../src/init/runAnsibleInstall.ts';

function run(choice: number, rc = 0) {
	const ran: Array<Record<string, string>> = [];
	const out: string[] = [];
	return offerServerCanary({
		askChoice: async () => choice,
		runSetup: (env) => (ran.push(env), rc),
		print: (s) => void out.push(s),
		domain: 'vigilante.trading',
		operatorTag: 'vigilante'
	}).then((r) => ({ r, ran, out: out.join('\n') }));
}

describe('the warrant canary on a server install', () => {
	it('"here, automatically": runs the canary setup in same-box mode for the served site', async () => {
		const { r, ran } = await run(0);
		expect(r).toBe('here');
		expect(ran).toHaveLength(1);
		expect(ran[0]).toMatchObject({
			MORPHIT_CANARY_MODE: 'local',
			MORPHIT_CANARY_SERVE_DIR: '/opt/morphit/apps/web/build',
			MORPHIT_CANARY_OPERATOR_NAME: 'vigilante',
			MORPHIT_CANARY_OPERATOR_EMAIL: 'canary@vigilante.trading'
		});
	});

	it('a setup that does not finish says how to run it again', async () => {
		const { r, out } = await run(0, 1);
		expect(r).toBe('failed');
		expect(out).toContain('scripts/canary/setup.sh');
	});

	it('"on my own computer": runs nothing here, and says what to run there', async () => {
		const { r, ran, out } = await run(1);
		expect(r).toBe('own-computer');
		expect(ran).toHaveLength(0);
		expect(out).toContain('bash scripts/canary/setup.sh');
	});

	it('"later": runs nothing', async () => {
		const { r, ran } = await run(2);
		expect(r).toBe('later');
		expect(ran).toHaveLength(0);
	});
});

describe('the canary is never told the origin is a bare https://', () => {
	it('a real origin is passed on; none (a Tor-only node before its onion is saved) is left unset', async () => {
		const { canaryOriginEnv } = await import('../src/init/runAnsibleInstall.ts');
		expect(canaryOriginEnv('https://vigilante.trading')).toEqual({
			MORPHIT_CANARY_INSTANCE_ORIGIN: 'https://vigilante.trading'
		});
		expect(canaryOriginEnv(`http://${'a'.repeat(56)}.onion`)).toHaveProperty(
			'MORPHIT_CANARY_INSTANCE_ORIGIN'
		);
		expect(canaryOriginEnv(null)).toEqual({});
		expect(canaryOriginEnv('https://')).toEqual({});
	});
});
