/**
 * The "no clearnet Matrix" leg reads the alert bot's REAL config
 * (v1.18.0 deep-deep, M3).
 *
 * The leg used to read `MORPHIT_INSTANCE_MATRIX_HOMESERVER`, which no installer,
 * playbook or ops-cli command sets. The bot's real settings are in
 * /etc/morphit/matrix-bot.env (`MORPHIT_MATRIX_BOT_ALERT_MXID`,
 * `MORPHIT_MATRIX_BOT_HOMESERVER`, default https://matrix.org, no Tor routing).
 * So a tor-only node running the alert bot reported `clearnet_eliminated: true`
 * while the bot talked to matrix.org from the home IP.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	clearnetLegsFromConfig,
	computeClearnetEliminated,
	_setMatrixBotEnvPathForTesting
} from '$indexer/clearnetGate';

const HIDDEN_ONLY = {
	blurtRpcEndpoints: [],
	hiddenRpcEndpoints: [`http://${'a'.repeat(56)}.onion`],
	instanceTorAddress: `${'b'.repeat(56)}.onion`,
	instanceI2pB32Address: `${'c'.repeat(52)}.b32.i2p`
};

let dir = '';
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'm3-'));
});
afterEach(() => {
	_setMatrixBotEnvPathForTesting(null);
	rmSync(dir, { recursive: true, force: true });
});

function botEnv(text: string | null): void {
	const p = join(dir, 'matrix-bot.env');
	if (text !== null) writeFileSync(p, text);
	_setMatrixBotEnvPathForTesting(p);
}
const clean = (): boolean => clearnetLegsFromConfig(HIDDEN_ONLY, true).matrixClean;

describe('M3 — matrixClean follows the bot, not an unset variable', () => {
	it('a bot with an alert MXID and the default homeserver (matrix.org) is NOT clean', () => {
		botEnv('MORPHIT_MATRIX_BOT_ACCESS_TOKEN=syt_x\nMORPHIT_MATRIX_BOT_ALERT_MXID=@op:matrix.org\n');
		expect(clean()).toBe(false);
		expect(computeClearnetEliminated(clearnetLegsFromConfig(HIDDEN_ONLY, true))).toBe(false);
	});

	it('an explicit clearnet homeserver is NOT clean', () => {
		botEnv(
			'MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\nMORPHIT_MATRIX_BOT_ALERT_MXID=@op:matrix.org\n'
		);
		expect(clean()).toBe(false);
	});

	it('an onion homeserver is NOT clean either: the bot has no Tor route, so it asks the system resolver', () => {
		botEnv(
			`MORPHIT_MATRIX_BOT_HOMESERVER=https://${'d'.repeat(56)}.onion\nMORPHIT_MATRIX_BOT_ALERT_MXID=@op:x\n`
		);
		expect(clean()).toBe(false);
	});

	it('a homeserver on this box (loopback) is clean', () => {
		botEnv(
			'MORPHIT_MATRIX_BOT_HOMESERVER=http://127.0.0.1:8008\nMORPHIT_MATRIX_BOT_ALERT_MXID=@op:local\n'
		);
		expect(clean()).toBe(true);
	});

	it('no alert MXID: the bot exits at start, so it is clean', () => {
		botEnv('MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\nMORPHIT_MATRIX_BOT_ALERT_MXID=\n');
		expect(clean()).toBe(true);
	});

	it('no bot env file at all is clean', () => {
		botEnv(null);
		expect(clean()).toBe(true);
		expect(computeClearnetEliminated(clearnetLegsFromConfig(HIDDEN_ONLY, true))).toBe(true);
	});

	it('an env file that cannot be read is NOT clean (unknown is not clean)', () => {
		_setMatrixBotEnvPathForTesting(dir); // a directory: reading it fails with EISDIR
		expect(clean()).toBe(false);
	});
});
