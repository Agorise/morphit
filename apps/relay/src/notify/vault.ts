/**
 * Offline notices — where a user's own addresses are sealed.
 *
 * A user who turns on Settings → Offline Notifications gives this instance an
 * address of hers: an email address, a Matrix ID, an XMPP address, a Session
 * ID, or (through the bot) a Telegram chat. If that list ever leaked it would
 * tie pseudonymous trading accounts to real-world identities, so:
 *
 *   - Every address is stored ENCRYPTED (AES-256-GCM), bound to its row (the
 *     account and the channel are the additional data, so a ciphertext copied
 *     to another row does not decrypt).
 *   - The key is a file in the relay's own state directory
 *     (/var/lib/morphit-relay, mode 0700, owned by the relay's user), never in
 *     the database. A database dump, a backup or a published snapshot holds
 *     ciphertext only; the backup leaves these tables out entirely anyway.
 *   - Every value is padded to a fixed size before it is sealed, so the
 *     length of a ciphertext does not tell how long the address is.
 *   - Lookups never need the address: a keyed hash (HMAC-SHA-256, a second key
 *     derived from the same file) lets the relay count codes sent to one
 *     address without being able to read it back.
 *   - Nothing here logs an address, a code or a key.
 *
 * Without the key file the stored addresses are unreadable — that is the
 * point: a copy of the data is useless without this one file. A relay whose
 * key file is missing, or not the one the addresses were sealed with (the
 * database remembers which: offline_notify_key), does NOT make a new one and
 * drop them; it keeps offline notices off and says so (store.ts
 * openSealedStore), until the file is put back or the operator starts over.
 */

import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	hkdfSync,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';
import {
	closeSync,
	statSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync
} from 'node:fs';
import { join } from 'node:path';

export const VAULT_KEY_FILE = 'offline-notify.key';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Version byte at the front of every sealed value, so a future key or
 *  algorithm change can tell old rows from new. */
const SEAL_V1 = 0x01;
/** Every sealed value is padded to this one size (bytes, including a
 *  two-byte length), so a short address and an unusually long one look
 *  alike in the database. The longest value sealed (an address of 254
 *  characters, each up to three bytes in UTF-8) fits. */
export const SEALED_PAD_BYTES = 1024;

function pad(plain: string): Buffer {
	const body = Buffer.from(plain, 'utf8');
	if (body.length + 2 > SEALED_PAD_BYTES) throw new RangeError('value too long to seal');
	const out = Buffer.alloc(SEALED_PAD_BYTES);
	out.writeUInt16BE(body.length, 0);
	body.copy(out, 2);
	return out;
}

function unpad(padded: Buffer): string | null {
	if (padded.length < 2) return null;
	const n = padded.readUInt16BE(0);
	if (n + 2 > padded.length) return null;
	return padded.subarray(2, 2 + n).toString('utf8');
}

/** Why the vault cannot be opened: the key file is not there, is another
 *  key, cannot be read (permissions), or cannot be made. */
export type VaultProblem = 'missing' | 'mismatch' | 'unreadable' | 'unwritable';

export class VaultUnavailableError extends Error {
	constructor(
		why: string,
		readonly kind: VaultProblem = 'unreadable'
	) {
		super(why);
		this.name = 'VaultUnavailableError';
	}
}

export interface Vault {
	/** Seal `plain` for (account, channel, purpose). */
	seal(plain: string, account: string, channel: string, purpose: string): Buffer;
	/** Open what {@link seal} produced for the same (account, channel, purpose);
	 *  null when it does not open (another row's value, a damaged value, or a
	 *  value sealed under another key). */
	open(sealed: Buffer, account: string, channel: string, purpose: string): string | null;
	/** Keyed hash, for looking a value up or counting it without storing it. */
	mac(...parts: string[]): Buffer;
	/** Constant-time comparison of two macs. */
	sameMac(a: Buffer | null | undefined, b: Buffer): boolean;
}

/** Build a vault from 32 raw key bytes. PURE apart from the crypto. */
export function vaultFromKey(raw: Buffer): Vault {
	if (raw.length !== KEY_BYTES)
		throw new VaultUnavailableError('the offline-notify key has the wrong length');
	const encKey = Buffer.from(
		hkdfSync('sha256', raw, Buffer.alloc(0), 'morphit offline-notify seal v1', 32)
	);
	const macKey = Buffer.from(
		hkdfSync('sha256', raw, Buffer.alloc(0), 'morphit offline-notify mac v1', 32)
	);
	const aad = (account: string, channel: string, purpose: string): Buffer =>
		Buffer.from(`morphit-offline-notify\u0000${account}\u0000${channel}\u0000${purpose}`, 'utf8');
	return {
		seal(plain, account, channel, purpose) {
			const iv = randomBytes(IV_BYTES);
			const c = createCipheriv('aes-256-gcm', encKey, iv);
			c.setAAD(aad(account, channel, purpose));
			const body = Buffer.concat([c.update(pad(plain)), c.final()]);
			return Buffer.concat([Buffer.from([SEAL_V1]), iv, c.getAuthTag(), body]);
		},
		open(sealed, account, channel, purpose) {
			if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== SEAL_V1) return null;
			try {
				const iv = sealed.subarray(1, 1 + IV_BYTES);
				const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
				const d = createDecipheriv('aes-256-gcm', encKey, iv);
				d.setAAD(aad(account, channel, purpose));
				d.setAuthTag(tag);
				return unpad(
					Buffer.concat([d.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), d.final()])
				);
			} catch {
				return null;
			}
		},
		mac(...parts) {
			const h = createHmac('sha256', macKey);
			for (const p of parts) h.update(`${p.length}:${p}`, 'utf8');
			return h.digest();
		},
		sameMac(a, b) {
			return a !== null && a !== undefined && a.length === b.length && timingSafeEqual(a, b);
		}
	};
}

/**
 * The relay's vault: read the key file from `dataDir`, creating it (0600,
 * written to a side file, fsynced, renamed into place) when `create` allows —
 * only when no address was ever sealed (store.ts openSealedStore decides).
 * Throws {@link VaultUnavailableError} when the file is missing and may not be
 * made, or cannot be read or made — offline notices then stay off and the
 * relay says why.
 */
export function openVault(
	dataDir: string,
	opts: { create: boolean } = { create: true }
): { vault: Vault; created: boolean } {
	const path = join(dataDir, VAULT_KEY_FILE);
	// "Not there" and "cannot look" are different answers: a key file this
	// process may not read (the relay moved to another user, a directory's
	// permissions) is not a lost key, and must never be treated as one.
	let present: boolean;
	try {
		statSync(path);
		present = true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
			throw new VaultUnavailableError(
				`cannot read ${path}: ${(err as Error).message}`,
				'unreadable'
			);
		present = false;
	}
	if (present) {
		let raw: Buffer;
		try {
			raw = readFileSync(path);
		} catch (err) {
			throw new VaultUnavailableError(
				`cannot read ${path}: ${(err as Error).message}`,
				'unreadable'
			);
		}
		return { vault: vaultFromKey(raw), created: false };
	}
	if (!opts.create)
		throw new VaultUnavailableError(
			`${path} is missing, and the saved offline-notice addresses were sealed with it: put it back, or start over with \`sudo morphit-ops offline-notify\``,
			'missing'
		);
	try {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		const raw = randomBytes(KEY_BYTES);
		const tmp = `${path}.${process.pid}.tmp`;
		const fd = openSync(tmp, 'wx', 0o600);
		try {
			writeSync(fd, raw);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
		return { vault: vaultFromKey(raw), created: true };
	} catch (err) {
		throw new VaultUnavailableError(
			`cannot create ${path}: ${(err as Error).message}`,
			'unwritable'
		);
	}
}
