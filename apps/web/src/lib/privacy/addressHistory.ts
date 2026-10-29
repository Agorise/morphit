/* Client-side address-reuse history.
 *
 *  Remembers WHICH addresses the user has shared from this device through
 *  Morphit, so the address-share modal can warn when one is about to be
 *  shared again. It cannot say what they were, when, or for which order.
 *
 *  Privacy posture: client-side only, never transmitted. And what is kept is
 *  not the address: each entry is HMAC-SHA256(per-install salt, asset ‖ 0 ‖
 *  address), truncated to 16 bytes. Someone who reads this browser's storage
 *  learns how many addresses were shared and can test whether a GIVEN address
 *  was; they cannot read the addresses back, nor tell when they were shared or
 *  for which orders (no timestamps, no order ids are stored).
 *
 *  Older builds stored the addresses in plaintext with timestamps and order
 *  ids (`morphit.address-history.v1`). That record is converted to the hashed
 *  form and deleted the first time this module runs with storage available
 *  (the app boot does it as soon as it sees one).
 *
 *  Storage shape (`morphit.address-history.v2`):
 *  ```json
 *  { "v": 2, "salt": "<base64, 32 bytes>", "tags": ["<32 hex>", …] }
 *  ```
 *  Bounded: at most 200 tags (oldest dropped).
 *
 *  Best-effort throughout: a failure means "no history", never a blocked share.
 */
import { sodium, ensureSodium, sodiumSumo } from '$crypto/sodium';

export const ADDRESS_HISTORY_KEY = 'morphit.address-history.v2';
/** Plaintext addresses, timestamps and order ids written by older builds. */
export const LEGACY_ADDRESS_HISTORY_KEY = 'morphit.address-history.v1';
const MAX_ENTRIES = 200;
const TAG_BYTES = 16;

interface AddressHistoryFile {
	readonly v: 2;
	readonly salt: string;
	readonly tags: readonly string[];
}

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

function readFile(): AddressHistoryFile | null {
	const s = storage();
	if (s === null) return null;
	try {
		const raw = s.getItem(ADDRESS_HISTORY_KEY);
		if (raw === null) return null;
		const f = JSON.parse(raw) as Partial<AddressHistoryFile>;
		if (
			f?.v === 2 &&
			typeof f.salt === 'string' &&
			Array.isArray(f.tags) &&
			f.tags.every((t) => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t))
		) {
			return f as AddressHistoryFile;
		}
	} catch {
		/* corrupt: treated as empty */
	}
	return null;
}

function writeFile(f: AddressHistoryFile): void {
	try {
		storage()?.setItem(ADDRESS_HISTORY_KEY, JSON.stringify(f));
	} catch {
		/* full / private mode: best-effort */
	}
}

/** The file, created with a fresh per-install salt when there is none. */
async function fileForWrite(): Promise<AddressHistoryFile> {
	const existing = readFile();
	if (existing !== null) return existing;
	await ensureSodium();
	return {
		v: 2,
		salt: sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL),
		tags: []
	};
}

/** One spelling per address where the format ignores case, so the same
 *  address written another way is still "shared before" (v1.21.17): a bech32
 *  Bitcoin or Litecoin address (`bc1…` = `BC1…`), a Bitcoin Cash address
 *  (with or without `bitcoincash:`), an EVM address (`0x…`, checksummed or
 *  not). Anything else is compared as written: Monero and base58 addresses
 *  are case-sensitive. */
export function canonicalAddress(address: string): string {
	const a = address.trim();
	if (/^(bc1|tb1|bcrt1|ltc1|tltc1)[0-9a-z]+$/i.test(a)) return a.toLowerCase();
	if (/^0x[0-9a-f]{40}$/i.test(a)) return a.toLowerCase();
	const cash = /^(?:bitcoincash:)?([qp][0-9a-z]{41})$/i.exec(a);
	if (cash) return cash[1]!.toLowerCase();
	return a;
}

/** The tag of an address as written. Exported for tests only. */
export async function tagFor(salt: string, asset: string, address: string): Promise<string> {
	await ensureSodium();
	const key = sodium.from_base64(salt, sodium.base64_variants.ORIGINAL);
	const msg = sodium.from_string(`${asset.toUpperCase()}\u0000${address}`);
	const mac = sodiumSumo().crypto_auth_hmacsha256(msg, key);
	return sodium.to_hex(mac.subarray(0, TAG_BYTES));
}

function withTag(f: AddressHistoryFile, tag: string): AddressHistoryFile {
	const tags = [...f.tags.filter((t) => t !== tag), tag];
	return { ...f, tags: tags.length > MAX_ENTRIES ? tags.slice(tags.length - MAX_ENTRIES) : tags };
}

/** True when an older build's plaintext history is still in storage. */
export function hasLegacyAddressHistory(): boolean {
	try {
		return storage()?.getItem(LEGACY_ADDRESS_HISTORY_KEY) != null;
	} catch {
		return false;
	}
}

/** Convert an older build's plaintext history to the hashed form and delete
 *  it. Idempotent; a no-op when there is none. */
export async function migrateLegacyAddressHistory(): Promise<void> {
	const s = storage();
	if (s === null) return;
	let raw: string | null;
	try {
		raw = s.getItem(LEGACY_ADDRESS_HISTORY_KEY);
	} catch {
		return;
	}
	if (raw === null) return;
	try {
		const parsed = JSON.parse(raw) as { entries?: unknown };
		const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
		let f = await fileForWrite();
		for (const e of entries) {
			const asset = (e as { asset?: unknown })?.asset;
			const address = (e as { address?: unknown })?.address;
			if (typeof asset === 'string' && typeof address === 'string') {
				f = withTag(f, await tagFor(f.salt, asset, canonicalAddress(address)));
			}
		}
		writeFile(f);
	} catch {
		/* unreadable legacy record: dropped below */
	}
	try {
		s.removeItem(LEGACY_ADDRESS_HISTORY_KEY);
	} catch {
		/* best-effort */
	}
}

/** Remember that `address` (of `asset`) was shared from this device. */
export async function recordAddressShare(asset: string, address: string): Promise<void> {
	if (storage() === null) return;
	try {
		await migrateLegacyAddressHistory();
		const f = await fileForWrite();
		writeFile(withTag(f, await tagFor(f.salt, asset, canonicalAddress(address))));
	} catch {
		/* best-effort: the share itself is never blocked */
	}
}

/**
 * Send a share with `send`, and remember the address only once it was sent.
 * A share that failed is not a reuse: recording it first made the retry warn
 * "you shared this address before". Recording is best-effort and never fails
 * the share; a failed send rethrows.
 */
export async function shareAddress(
	asset: string,
	address: string,
	send: () => Promise<void> | void
): Promise<void> {
	await send();
	void recordAddressShare(asset, address);
}

/** Was `address` (of `asset`) shared from this device before? */
export async function wasSharedBefore(asset: string, address: string): Promise<boolean> {
	try {
		await migrateLegacyAddressHistory();
		const f = readFile();
		if (f === null || f.tags.length === 0) return false;
		// The canonical spelling, and as written (what an older build recorded).
		return (
			f.tags.includes(await tagFor(f.salt, asset, canonicalAddress(address))) ||
			f.tags.includes(await tagFor(f.salt, asset, address))
		);
	} catch {
		return false;
	}
}

/** How many addresses are remembered (Settings → Privacy). */
export function addressHistoryCount(): number {
	return readFile()?.tags.length ?? 0;
}

/** Forget the whole history (Settings → Privacy "Forget address history"),
 *  including an older build's plaintext record. */
export function clearAddressHistory(): void {
	const s = storage();
	if (s === null) return;
	for (const k of [ADDRESS_HISTORY_KEY, LEGACY_ADDRESS_HISTORY_KEY]) {
		try {
			s.removeItem(k);
		} catch {
			/* best-effort */
		}
	}
}
