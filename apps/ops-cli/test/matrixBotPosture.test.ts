/**
 * Writing the Matrix bot's settings also writes its secret-free posture
 * (matrix-bot.posture), which the indexer reads for its clearnet check because
 * it cannot read the token-bearing matrix-bot.env (request).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeAlertMxid, writeMatrixCreds } from '../src/lib/matrixBot.ts';
import { selfHealSteps } from '../src/commands/upgrade.ts';
import { mkdirSync } from 'node:fs';

describe('matrix-bot.posture', () => {
	it('is written next to the env file, with no token, 0640', () => {
		const d = mkdtempSync(join(tmpdir(), 'mxpost-'));
		const env = join(d, 'matrix-bot.env');
		writeFileSync(
			env,
			'MORPHIT_MATRIX_BOT_HOMESERVER=http://abc.onion\nMORPHIT_MATRIX_BOT_ACCESS_TOKEN=SECRET-TOKEN\n'
		);
		expect(writeAlertMxid('@ops:abc.onion', env)).toBe(true);
		const post = readFileSync(join(d, 'matrix-bot.posture'), 'utf8');
		expect(post).toMatch(/^MORPHIT_MATRIX_BOT_ALERT_MXID=configured$/m);
		expect(post).toMatch(/^MORPHIT_MATRIX_BOT_HOMESERVER=http:\/\/abc\.onion$/m);
		expect(post).not.toMatch(/SECRET-TOKEN|@ops/);
		expect(statSync(join(d, 'matrix-bot.posture')).mode & 0o777).toBe(0o640);
	});

	it('follows a credentials write too', () => {
		const d = mkdtempSync(join(tmpdir(), 'mxpost-'));
		const env = join(d, 'matrix-bot.env');
		expect(writeMatrixCreds('@a:b.c', 'TOKEN-X', env)).toBe(true);
		const post = readFileSync(join(d, 'matrix-bot.posture'), 'utf8');
		expect(post).toMatch(/ALERT_MXID=configured/);
		expect(post).not.toMatch(/TOKEN-X/);
	});

	it('an upgrade writes it for a bot set up before it existed (self-heal phase)', async () => {
		const root = mkdtempSync(join(tmpdir(), 'mxpost-root-'));
		mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
		writeFileSync(
			join(root, 'etc', 'morphit', 'matrix-bot.env'),
			'MORPHIT_MATRIX_BOT_ALERT_MXID=@x:y.z\nMORPHIT_MATRIX_BOT_HOMESERVER=https://y.z\n'
		);
		const saved = process.env.MORPHIT_ENV_ROOT;
		process.env.MORPHIT_ENV_ROOT = root;
		try {
			await selfHealSteps().find(([n]) => n === 'the Matrix bot posture')![1]();
		} finally {
			if (saved === undefined) delete process.env.MORPHIT_ENV_ROOT;
			else process.env.MORPHIT_ENV_ROOT = saved;
		}
		expect(readFileSync(join(root, 'etc', 'morphit', 'matrix-bot.posture'), 'utf8')).toMatch(
			/HOMESERVER=https:\/\/y\.z/
		);
	});
});
