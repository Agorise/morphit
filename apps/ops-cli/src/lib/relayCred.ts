/**
 * The relay's host-bound sealed unlock passphrase
 * (/etc/morphit/relay_passphrase.cred, `systemd-creds --with-key=host`), which
 * the relay unit loads (LoadCredentialEncrypted=relay_passphrase) to open its
 * encrypted active-key keystore with no one at the keyboard.
 *
 * Whoever writes a new keystore passphrase must re-seal it here, or the relay
 * cannot start (`edit-active-key` did not).
 * The new credential is written next to the old one and renamed over it only
 * after it decrypts back to the passphrase, so a failed seal leaves the old
 * credential in place. The passphrase only ever travels over pipes.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, renameSync, rmSync } from 'node:fs';

export const RELAY_CRED_PATH = '/etc/morphit/relay_passphrase.cred';

export function relayCredPath(): string {
	return process.env.MORPHIT_RELAY_CRED_FILE || RELAY_CRED_PATH;
}

export function sealRelayPassphrase(
	passphrase: string,
	credPath: string = relayCredPath()
): { ok: true } | { ok: false; reason: string } {
	const tmp = `${credPath}.new`;
	try {
		const enc = spawnSync(
			'systemd-creds',
			['encrypt', '--name=relay_passphrase', '--with-key=host', '-', tmp],
			{
				input: passphrase,
				stdio: ['pipe', 'ignore', 'pipe'],
				encoding: 'utf8'
			}
		);
		if (enc.error) return { ok: false, reason: 'systemd-creds is not available on this server' };
		if (enc.status !== 0 || !existsSync(tmp)) {
			return {
				ok: false,
				reason: (enc.stderr ?? '').trim() || `systemd-creds exited ${enc.status}`
			};
		}
		chmodSync(tmp, 0o600);
		const dec = spawnSync('systemd-creds', ['decrypt', '--name=relay_passphrase', tmp, '-'], {
			stdio: ['ignore', 'pipe', 'ignore'],
			encoding: 'utf8'
		});
		if (dec.status !== 0 || (dec.stdout ?? '').replace(/\r?\n$/, '') !== passphrase) {
			return { ok: false, reason: 'the new credential did not decrypt back to the passphrase' };
		}
		renameSync(tmp, credPath);
		return { ok: true };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** The one command that seals it by hand, for messages. */
export function manualSealCommand(credPath: string = relayCredPath()): string {
	return `echo -n '<your passphrase>' | sudo systemd-creds encrypt --name=relay_passphrase --with-key=host - ${credPath}`;
}
