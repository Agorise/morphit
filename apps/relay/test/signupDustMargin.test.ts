/**
 * v1.21.13: each new account gets 4 BLURT to start (SIGNUP_DUST_BLURT — enough
 * to save every profile field once, two settings saves, the first order and
 * about seven short messages; see src/blurt/signupDust.ts). The relay must not
 * start a signup it cannot finish: it needs the chain's account fee PLUS the
 * starter BLURT, with a little to spare.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/index.ts';
import { HealthService } from '../src/api/health.ts';
import { SIGNUP_DUST_BLURT } from '../src/blurt/signupDust.ts';
import type { BlurtClient } from '../src/blurt/client.ts';

const KEYS = [
	'MORPHIT_RELAY_ACCOUNT',
	'MORPHIT_RELAY_ACTIVE_KEY_FILE',
	'MORPHIT_RELAY_DATABASE_URL',
	'MORPHIT_RELAY_INVITE_HMAC_SECRET',
	'MORPHIT_RELAY_ALTCHA_HMAC_SECRET'
];
const saved: Record<string, string | undefined> = {};
let dir = '';
beforeEach(async () => {
	for (const k of KEYS) saved[k] = process.env[k];
	dir = mkdtempSync(join(tmpdir(), 'relay-dust-margin-'));
	const keyFile = join(dir, 'active.key');
	const { PrivateKey } = await import('@beblurt/dblurt');
	writeFileSync(keyFile, PrivateKey.fromSeed('relay-dust-margin-test').toString());
	chmodSync(keyFile, 0o400);
	process.env.MORPHIT_RELAY_ACCOUNT = 'morphit-relay';
	process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE = keyFile;
	process.env.MORPHIT_RELAY_DATABASE_URL =
		'postgres://relay:a-real-password-here@localhost:5432/morphit';
	process.env.MORPHIT_RELAY_INVITE_HMAC_SECRET = 'i'.repeat(64);
	process.env.MORPHIT_RELAY_ALTCHA_HMAC_SECRET = 'a'.repeat(64);
});
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(dir, { recursive: true, force: true });
});

async function canAccept(balance: string): Promise<boolean> {
	const blurt = {
		getAccount: async () => ({ balance }),
		getChainProperties: async () => ({ account_creation_fee: '100.000 BLURT' }),
		endpointSnapshot: () => []
	} as unknown as BlurtClient;
	const svc = new HealthService(loadConfig(), blurt, process.hrtime.bigint());
	await (svc as unknown as { refresh(): Promise<void> }).refresh();
	return svc.canAcceptCreation();
}

describe('the starter BLURT', () => {
	it('is 4 BLURT', () => {
		expect(SIGNUP_DUST_BLURT).toBe(4);
	});
	it('the relay accepts a signup only when it holds the account fee plus the starter BLURT and a margin', async () => {
		expect(await canAccept(`${100 + SIGNUP_DUST_BLURT}.000 BLURT`)).toBe(false);
		expect(await canAccept(`${100 + SIGNUP_DUST_BLURT}.999 BLURT`)).toBe(false);
		expect(await canAccept(`${100 + SIGNUP_DUST_BLURT + 1}.000 BLURT`)).toBe(true);
	});
});
