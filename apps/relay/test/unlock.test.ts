/**
 * Tests for unlockActiveKey. Uses an injected prompt to avoid
 * touching real stdin. Covers plaintext pass-through, envelope
 * decryption, retry-on-wrong-passphrase, lockout, malformed
 * envelope, and the "both fields undefined" internal error.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { unlockActiveKey, UnlockError } from '$config/unlock';
import { encryptEnvelope } from '$crypto/keyEnvelope';
import { PassphrasePromptError } from '$crypto/promptPassphrase';
import type { Config } from '$config';

const SAMPLE_WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const RIGHT_PW = 'correct-horse-battery-staple';

function baseConfig(): Config {
	return {
		listenHost: '127.0.0.1',
		listenPort: 8080,
		publicOrigin: 'https://relay.morphit.io',
		blurtRpcEndpoints: ['https://rpc.blurt.blog'],
		relayAccount: 'morphit-relay',
		relayActiveKeyWif: undefined,
		relayActiveKeyEnvelope: undefined,
		allowedOrigins: ['https://morphit.io'],
		availabilityRatePerMin: 60,
		createRatePerHour: 5,
		createRatePerDay: 2,
		maxRequestBodyBytes: 64 * 1024,
		signupEnabled: true,
		signupDailyCeiling: 50,
		signupCeilingPersistPath: null,
		dataDir: null,
		createSpacingMinutes: 60,
		altchaTriggerCount: 3,
		altchaMaxnumber: 100_000,
		inviteHmacSecret: undefined,
		altchaHmacSecret: undefined,
		highValueNamePolicy: 'off' as const,
		highValueShortNameThreshold: 4,
		sequentialDetectorEnabled: false,
		sequentialWindowMs: 3_600_000,
		sequentialThreshold: 2,
		sequentialMinPrefix: 3,
		trustedProxyIps: '',
		databaseUrl: 'postgres://test',
		queuePollIntervalMs: 60_000,
		queueBatchSize: 20,
		queueMaxRetries: 10,
		verboseHealth: false,
		accountCreationFeeBlurt: 100,
		vapidPublicKey: undefined,
		vapidPrivateKey: undefined,
		vapidSubject: undefined,
		pushEnabled: false,
		pushPollIntervalMs: 30_000,
		pushBatchSize: 50,
		pushMaxAgeSeconds: 3600,
		pushMaxConsecutiveFailures: 5,
		pushRequireSigned: false
	};
}

describe('unlockActiveKey — plaintext fast path', () => {
	it('returns UnlockedConfig without calling the prompt', async () => {
		const cfg: Config = { ...baseConfig(), relayActiveKeyWif: SAMPLE_WIF };
		const prompt = vi.fn();
		const result = await unlockActiveKey(cfg, prompt);
		expect(result.relayActiveKeyWif).toBe(SAMPLE_WIF);
		expect(result.relayActiveKeyEnvelope).toBeUndefined();
		expect(prompt).not.toHaveBeenCalled();
	});
});

describe('unlockActiveKey — envelope decryption', () => {
	it('decrypts the envelope and returns UnlockedConfig with the WIF', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		const prompt = vi.fn(async () => RIGHT_PW);

		const result = await unlockActiveKey(cfg, prompt);

		expect(result.relayActiveKeyWif).toBe(SAMPLE_WIF);
		expect(result.relayActiveKeyEnvelope).toBeUndefined();
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it('wrong-then-right passphrase: retries and succeeds', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		let callCount = 0;
		const prompt = vi.fn(async () => {
			callCount++;
			return callCount === 1 ? 'wrong-pw-one' : RIGHT_PW;
		});

		const result = await unlockActiveKey(cfg, prompt);

		expect(result.relayActiveKeyWif).toBe(SAMPLE_WIF);
		expect(prompt).toHaveBeenCalledTimes(2);
		// The second prompt invocation should have the retry text
		// (a specific string distinction the helper makes).
		const calls = prompt.mock.calls as unknown as Array<[{ prompt: string; minLength: number }]>;
		const secondCall = calls[1]?.[0];
		expect(secondCall).toBeDefined();
		expect(secondCall!.prompt).toContain('Wrong passphrase');
	});

	it('3 wrong passphrases → UnlockError after MAX_ATTEMPTS', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		const prompt = vi.fn(async () => 'always-wrong');

		await expect(unlockActiveKey(cfg, prompt)).rejects.toBeInstanceOf(UnlockError);
		// Exactly MAX_ATTEMPTS (3) tries.
		expect(prompt).toHaveBeenCalledTimes(3);
	});

	it('malformed envelope: fails immediately, no retry', async () => {
		// An envelope with an unsupported version doesn't benefit
		// from a retry — the second passphrase attempt would hit
		// the same shape error.
		const cfg: Config = {
			...baseConfig(),
			relayActiveKeyEnvelope: {
				v: 999,
				kdf: 'scrypt',
				kdf_params: { N: 131072, r: 8, p: 1, salt: 'AAAA' },
				cipher: 'aes-256-gcm',
				iv: 'AAAA',
				ct: 'AAAA'
			}
		};
		const prompt = vi.fn(async () => 'whatever');

		await expect(unlockActiveKey(cfg, prompt)).rejects.toBeInstanceOf(UnlockError);
		// Prompt was called exactly once (the 1st attempt). The
		// version mismatch was detected and did NOT retry.
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it('TTY not available: prompt error is fatal and wraps in UnlockError', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		const prompt = vi.fn(async () => {
			throw new PassphrasePromptError('stdin is not a TTY', 'no_tty');
		});

		await expect(unlockActiveKey(cfg, prompt)).rejects.toBeInstanceOf(UnlockError);
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it('prompt timeout / cancellation: fatal, wraps in UnlockError', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		const prompt = vi.fn(async () => {
			throw new PassphrasePromptError('cancelled by operator', 'cancelled');
		});

		await expect(unlockActiveKey(cfg, prompt)).rejects.toBeInstanceOf(UnlockError);
	});
});

describe('unlockActiveKey — non-interactive env passphrase (systemd)', () => {
	const ENV_KEY = 'MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE';
	afterEach(() => {
		delete process.env[ENV_KEY];
	});

	it('uses the env passphrase and never prompts', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		process.env[ENV_KEY] = RIGHT_PW;
		const prompt = vi.fn();

		const result = await unlockActiveKey(cfg, prompt);

		expect(result.relayActiveKeyWif).toBe(SAMPLE_WIF);
		expect(result.relayActiveKeyEnvelope).toBeUndefined();
		expect(prompt).not.toHaveBeenCalled();
	});

	it('wrong env passphrase is fatal and never falls back to the prompt', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		process.env[ENV_KEY] = 'wrong-from-env';
		const prompt = vi.fn(async () => RIGHT_PW);

		await expect(unlockActiveKey(cfg, prompt)).rejects.toBeInstanceOf(UnlockError);
		// A service has no TTY — a bad env passphrase must NOT silently
		// fall through to an interactive prompt that would then hang.
		expect(prompt).not.toHaveBeenCalled();
	});

	it('empty env passphrase falls through to the interactive prompt', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		process.env[ENV_KEY] = '';
		const prompt = vi.fn(async () => RIGHT_PW);

		const result = await unlockActiveKey(cfg, prompt);

		expect(result.relayActiveKeyWif).toBe(SAMPLE_WIF);
		expect(prompt).toHaveBeenCalledTimes(1);
	});
});

describe('unlockActiveKey — credential file (systemd-creds, enforced path)', () => {
	const ENV_FILE_KEY = 'MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE';
	const ENV_KEY = 'MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE';
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'morphit-relay-cred-'));
	});
	afterEach(() => {
		delete process.env[ENV_FILE_KEY];
		delete process.env[ENV_KEY];
		rmSync(tmp, { recursive: true, force: true });
	});

	it('reads the passphrase from the credential file and never prompts', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		const file = join(tmp, 'relay_passphrase');
		writeFileSync(file, `${RIGHT_PW}\n`); // a trailing newline is tolerated
		process.env[ENV_FILE_KEY] = file;
		const prompt = vi.fn();

		const result = await unlockActiveKey(cfg, prompt);

		expect(result.relayActiveKeyWif).toBe(SAMPLE_WIF);
		expect(result.relayActiveKeyEnvelope).toBeUndefined();
		expect(prompt).not.toHaveBeenCalled();
	});

	it('takes precedence over the plaintext env var', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		const file = join(tmp, 'relay_passphrase');
		writeFileSync(file, RIGHT_PW);
		process.env[ENV_FILE_KEY] = file;
		process.env[ENV_KEY] = 'wrong-would-fail-if-this-were-used';
		const prompt = vi.fn();

		const result = await unlockActiveKey(cfg, prompt);

		expect(result.relayActiveKeyWif).toBe(SAMPLE_WIF);
		expect(prompt).not.toHaveBeenCalled();
	});

	it('unreadable credential file is fatal, with no fall-back prompt', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, RIGHT_PW);
		const cfg: Config = { ...baseConfig(), relayActiveKeyEnvelope: env };
		process.env[ENV_FILE_KEY] = join(tmp, 'does-not-exist');
		const prompt = vi.fn(async () => RIGHT_PW);

		await expect(unlockActiveKey(cfg, prompt)).rejects.toBeInstanceOf(UnlockError);
		expect(prompt).not.toHaveBeenCalled();
	});
});

describe('unlockActiveKey — internal error states', () => {
	it('both WIF and envelope undefined → internal UnlockError', async () => {
		const cfg: Config = baseConfig();
		const prompt = vi.fn();

		await expect(unlockActiveKey(cfg, prompt)).rejects.toThrow(
			/both relayActiveKeyWif and relayActiveKeyEnvelope are undefined/
		);
		expect(prompt).not.toHaveBeenCalled();
	});
});
