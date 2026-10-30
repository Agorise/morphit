/**
 * `--check-config` (what `morphit-ops doctor` runs) says how the relay's
 * encrypted key is unlocked. It said "will prompt for passphrase at start" —
 * not what happens: the shipped unit (ops/systemd/morphit-relay.service, which
 * Ansible installs too) has systemd decrypt the sealed credential
 * /etc/morphit/relay_passphrase.cred at every start (LoadCredentialEncrypted=)
 * and the relay reads the passphrase from that file — no prompt; without the
 * credential the service does not start. The real entry point is run.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encryptEnvelope } from '../src/crypto/keyEnvelope.ts';

const RELAY = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'relay-check-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function checkConfig(keyContent: string): { code: number | null; out: string } {
	const keyFile = join(dir, 'relay.keystore');
	writeFileSync(keyFile, keyContent);
	chmodSync(keyFile, 0o600);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '',
		HOME: dir,
		MORPHIT_RELAY_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/morphit_test',
		MORPHIT_RELAY_ACCOUNT: 'example-relay',
		MORPHIT_RELAY_ACTIVE_KEY_FILE: keyFile,
		MORPHIT_RELAY_BLURT_RPC: 'https://rpc.example.org'
	};
	const r = spawnSync(
		join(RELAY, '..', '..', 'node_modules', '.bin', 'tsx'),
		['src/main.ts', '--check-config'],
		{
			cwd: RELAY,
			env,
			encoding: 'utf8',
			timeout: 60_000,
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
	return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('relay --check-config: how the active key is unlocked', () => {
	it('an encrypted key: unlocked from the sealed credential at every start, no prompt', () => {
		const wif = '5J' + 'a'.repeat(50);
		const r = checkConfig(JSON.stringify(encryptEnvelope(wif, 'correct horse battery')));
		expect(r.code, r.out).toBe(0);
		const line = r.out.split('\n').find((l) => l.includes('[check-config]')) ?? '';
		expect(line).toMatch(/encrypted/);
		expect(line).toContain('/etc/morphit/relay_passphrase.cred');
		expect(line).toMatch(/no prompt/);
		expect(line).not.toMatch(/will prompt/);
		// What it says matches the unit it describes.
		const unit = readFileSync(
			join(RELAY, '..', '..', 'ops', 'systemd', 'morphit-relay.service'),
			'utf8'
		);
		expect(unit).toMatch(
			/^LoadCredentialEncrypted=relay_passphrase:\/etc\/morphit\/relay_passphrase\.cred$/m
		);
		expect(unit).toMatch(
			/MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE="\$\{CREDENTIALS_DIRECTORY\}\/relay_passphrase"/
		);
	});

	it('a plaintext key: says plaintext', () => {
		const r = checkConfig('5J' + 'a'.repeat(50));
		expect(r.code, r.out).toBe(0);
		expect(r.out).toMatch(/\[check-config\] relay config OK \(active key: plaintext\)/);
	});
});
