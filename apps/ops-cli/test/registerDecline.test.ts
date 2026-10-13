/**
 * `register` says what happened through its exit code: declining its own
 * "Publish this registration on-chain now?" is REGISTER_DECLINED (5), and a
 * Ctrl+C at it stops with an AbortError, which the CLI maps to the same code —
 * never 0, and never a failure the install wizard would queue for an unattended
 * retry that then claims the permanent tag (review, 2026-10-12).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

let answer: boolean | Error = false;
let defaults: boolean[] = [];
let passphrase: string | Error = '';
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	askYesNo: async (_q: string, defaultYes: boolean) => {
		defaults.push(defaultYes);
		if (answer instanceof Error) throw answer;
		return answer;
	},
	askPassword: async () => {
		if (passphrase instanceof Error) throw passphrase;
		return passphrase;
	}
}));
const { runRegister, REGISTER_DECLINED } = await import('../src/commands/register.ts');
const { abortError } = await import('../src/init/prompt.ts');

afterEach(() => {
	defaults = [];
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function env(): void {
	vi.stubEnv('MORPHIT_RELAY_ACCOUNT', 'vigil-relay');
	vi.stubEnv('MORPHIT_RELAY_ACTIVE_KEY_FILE', '/nonexistent/keystore');
	vi.stubEnv('MORPHIT_INSTANCE_NAME', 'Vigilante Trading');
	vi.stubEnv('MORPHIT_INSTANCE_ORIGIN', 'https://vigilante.trading');
	vi.stubEnv('MORPHIT_INSTANCE_OPERATOR_TAG', 'vigilantetrading');
	vi.stubEnv('MORPHIT_INDEXER_URL', 'http://127.0.0.1:9');
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

describe('register at its own confirmation', () => {
	it('no: REGISTER_DECLINED, nothing published', async () => {
		env();
		answer = false;
		expect(await runRegister({ flags: {}, positional: [] })).toBe(REGISTER_DECLINED);
	}, 60_000);

	it('Ctrl+C: an AbortError (the CLI maps it to REGISTER_DECLINED)', async () => {
		env();
		answer = abortError();
		await expect(runRegister({ flags: {}, positional: [] })).rejects.toMatchObject({
			name: 'AbortError'
		});
	}, 60_000);
});

describe('register --default-yes (the wizard and edit, right after "yes, list it")', () => {
	it('its confirmation defaults to yes; without the flag, to no', async () => {
		env();
		answer = false;
		await runRegister({ flags: { 'default-yes': 'true' }, positional: [] });
		await runRegister({ flags: {}, positional: [] });
		expect(defaults).toEqual([true, false]);
	}, 60_000);
});

describe('Ctrl+C at the keystore passphrase', () => {
	it('is a stop (AbortError, mapped to REGISTER_DECLINED), never "failed to load the key" (1)', async () => {
		const { mkdtempSync, writeFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const { tmpdir } = await import('node:os');
		env();
		const ks = join(mkdtempSync(join(tmpdir(), 'reg-ks-')), 'keystore.json');
		writeFileSync(ks, '{"v":1}');
		vi.stubEnv('MORPHIT_RELAY_ACTIVE_KEY_FILE', ks);
		answer = true;
		passphrase = abortError();
		// A 1 would be queued for the unattended finisher, which then claims the
		// permanent tag the operator just stopped short of (review, 2026-10-12).
		await expect(runRegister({ flags: {}, positional: [] })).rejects.toMatchObject({
			name: 'AbortError'
		});
	}, 60_000);
});
