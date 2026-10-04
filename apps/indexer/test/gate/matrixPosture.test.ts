/**
 * The indexer no longer runs as root, so it cannot read the matrix bot's env
 * file (it holds the bot's access token). It reads the secret-free posture
 * file the installer writes, /etc/morphit/matrix-bot.posture, first, and the
 * bot's env only when that does not exist.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	currentMatrixBotPosture,
	matrixBotIsClean,
	_setMatrixBotEnvPathForTesting,
	_setMatrixBotPosturePathForTesting
} from '$indexer/clearnetGate';

const dir = mkdtempSync(join(tmpdir(), 'mxposture-'));
/** A path that exists but cannot be read as a file — what an unreadable
 *  0640 file looks like to a process outside its group (EISDIR, not ENOENT). */
const UNREADABLE = dir;

function posture(text: string | null): void {
	const p = join(dir, `posture-${Math.random()}`);
	if (text !== null) writeFileSync(p, text);
	_setMatrixBotPosturePathForTesting(p);
}

afterEach(() => {
	_setMatrixBotPosturePathForTesting(null);
	_setMatrixBotEnvPathForTesting(null);
});

describe('matrix bot posture for the clearnet gate', () => {
	it('posture says no bot: clean, even though the bot env is unreadable to us', () => {
		_setMatrixBotEnvPathForTesting(UNREADABLE);
		posture('MORPHIT_MATRIX_BOT_ALERT_MXID=\nMORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n');
		const p = currentMatrixBotPosture(Date.now() + 10 * 60_000);
		expect(p).toEqual({ state: 'inert' });
		expect(matrixBotIsClean(p)).toBe(true);
	});

	it('posture says a bot on a clearnet homeserver: not clean', () => {
		_setMatrixBotEnvPathForTesting(UNREADABLE);
		posture(
			'MORPHIT_MATRIX_BOT_ALERT_MXID=configured\nMORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n'
		);
		const p = currentMatrixBotPosture(Date.now() + 20 * 60_000);
		expect(p).toEqual({ state: 'active', homeserver: 'https://matrix.org' });
		expect(matrixBotIsClean(p)).toBe(false);
	});

	it('no posture file and an unreadable bot env: unknown, never clean', () => {
		_setMatrixBotEnvPathForTesting(UNREADABLE);
		posture(null);
		const p = currentMatrixBotPosture(Date.now() + 30 * 60_000);
		expect(p).toEqual({ state: 'unknown' });
		expect(matrixBotIsClean(p)).toBe(false);
	});
});
