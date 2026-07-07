// Mint a fresh I2P destination by invoking i2pd offline.
//
// Tor's onion is a lone ed25519 pubkey, so init/torOnion.ts mints it in
// Node.  An I2P destination bundles an encryption key (ElGamal — not in
// Node's crypto) + a signing key + a certificate, so we let i2pd — the
// authoritative implementation — generate it, then derive the advertised
// address from the keyfile it produced.  i2pd writes the keyfile at startup
// (local, before any network tunnel is attempted), so this works fully
// offline: we run i2pd against a throwaway datadir, wait for the keyfile,
// kill it, and keep the bytes.
//
// The returned keyfile is what the caller installs into i2pd's real keyfile
// path (like generateOnionV3 returns the Tor HS files to install).  Pins
// signaturetype = 7 so the KeysAndCert stays the 391-byte shape our
// derivation + smoke expect.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { i2pB32FromKeyfile, I2pKeyfileError, I2P_KEYS_AND_CERT_LEN } from './i2pDestination.ts';

/** Where the i2pd package installs its reseed/family certificates.  A
 *  throwaway datadir has none, and without them i2pd's router init stalls
 *  and never reaches the clients subsystem that mints the tunnel keyfile —
 *  so we seed the temp datadir from the first path that exists. */
const I2PD_CERT_PATHS = ['/usr/share/i2pd/certificates', '/var/lib/i2pd/certificates'];

function findI2pdCertificates(): string | null {
	for (const p of I2PD_CERT_PATHS) if (existsSync(p)) return p;
	return null;
}

/** Keyfile name inside the throwaway datadir (also the conventional name we
 *  install on the host). */
export const I2P_KEYFILE_NAME = 'morphit-web.dat';

export interface I2pDestinationResult {
	/** `<b32>.b32.i2p` — the advertised address. */
	readonly b32: string;
	/** The i2pd private-keys file (SENSITIVE — install 0600, never commit). */
	readonly keyfile: Buffer;
}

/** The i2pd server-tunnel stanza we write to the host's tunnels.conf.  Points
 *  the given local web port at an I2P HTTP server tunnel backed by `keys`.
 *  Admins edit or delete this stanza to change/remove the address. */
export function i2pTunnelStanza(keysFilename: string, webPort: number): string {
	return (
		`[morphit-web]\n` +
		`type = http\n` +
		`host = 127.0.0.1\n` +
		`port = ${webPort}\n` +
		`signaturetype = 7\n` +
		`keys = ${keysFilename}\n`
	);
}

/** True if an i2pd binary is invocable (so the wizard can decide whether to
 *  mint now or leave I2P for the operator to enable later). */
export function i2pdAvailable(i2pdBin = 'i2pd'): boolean {
	try {
		const r = spawnSync(i2pdBin, ['--version'], { timeout: 5000 });
		return r.status === 0;
	} catch {
		return false;
	}
}

/** Mint a fresh I2P destination.  Resolves with the b32 + keyfile bytes;
 *  rejects if i2pd is unavailable or didn't produce a usable keyfile in
 *  time.  Uses a throwaway datadir that is always cleaned up. */
export async function generateI2pDestination(
	i2pdBin = 'i2pd',
	timeoutMs = 45000
): Promise<I2pDestinationResult> {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-i2p-'));
	const tun = join(dir, 'tunnels.conf');
	const keyPath = join(dir, I2P_KEYFILE_NAME);
	writeFileSync(tun, i2pTunnelStanza(I2P_KEYFILE_NAME, 8080), { mode: 0o600 });
	// Seed certificates so router init reaches the clients subsystem promptly.
	const certs = findI2pdCertificates();
	if (certs) {
		try {
			cpSync(certs, join(dir, 'certificates'), { recursive: true });
		} catch {
			/* best-effort — i2pd may still find them on its own */
		}
	}

	const child = spawn(
		i2pdBin,
		[
			`--datadir=${dir}`,
			`--tunconf=${tun}`,
			'--http.enabled=false',
			'--httpproxy.enabled=false',
			'--socksproxy.enabled=false',
			'--sam.enabled=false',
			'--upnp.enabled=false',
			'--log=file',
			`--logfile=${join(dir, 'i2pd.log')}`
		],
		{ stdio: 'ignore' }
	);

	try {
		const keyfile = await new Promise<Buffer>((resolve, reject) => {
			let settled = false;
			let lastSize = -1;
			const settle = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearInterval(poll);
				fn();
			};
			// ENOENT here means i2pd isn't installed.
			child.on('error', (e: NodeJS.ErrnoException) =>
				settle(() =>
					reject(
						e.code === 'ENOENT'
							? new I2pKeyfileError(`i2pd binary not found (${i2pdBin})`)
							: e
					)
				)
			);
			const deadline = Date.now() + timeoutMs;
			const poll = setInterval(() => {
				if (existsSync(keyPath)) {
					// i2pd writes the file then fills it; wait for the size to
					// stabilise at >= the Destination length before reading, so we
					// never hash a half-written keyfile.
					const size = statSync(keyPath).size;
					if (size >= I2P_KEYS_AND_CERT_LEN && size === lastSize) {
						settle(() => resolve(readFileSync(keyPath)));
						return;
					}
					lastSize = size;
				}
				if (Date.now() > deadline) {
					settle(() =>
						reject(new I2pKeyfileError('i2pd did not produce a keyfile in time'))
					);
				}
			}, 200);
		});
		const b32 = i2pB32FromKeyfile(keyfile); // validates the format too
		return { b32, keyfile };
	} finally {
		child.kill('SIGKILL');
		rmSync(dir, { recursive: true, force: true });
	}
}
