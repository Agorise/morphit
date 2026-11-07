/**
 * Morphit indexer — accounts' Blurt profile pictures, fetched by THIS instance
 * (v1.23.3; the /witnesses page's pictures since v1.23.0).
 *
 * Owner, 2026-11-06: a Blurt account's profile picture should show across the
 * site — profile page, orderbook, chat, feedback — when the visitor has turned
 * pictures on, unless the account set a Morphit avatar (that one wins,
 * everywhere, federation-wide: it is on chain). This module is the picture
 * half: the URL an account set in its Blurt profile, and the picture behind it.
 *
 * Every page's Content-Security-Policy lets the browser load images from its
 * own instance only, and the FAQ promises the browser contacts nothing else.
 * So the picture is fetched HERE, by fetchPublicBytes — the federation probe's
 * guarded fetch (https only, every DNS record public, connection pinned,
 * redirects refused, body capped) — checked to BE a PNG, JPEG, GIF or WebP by
 * its first bytes (never SVG: it can carry script), and served by this
 * instance. Nobody but this instance learns who looked.
 *   - Not a general-purpose image proxy: the only URL fetched for an account
 *     is the one that account put in its own Blurt profile (or the Blurt image
 *     proxy's copy of that account's picture).
 *   - The URL is read from the chain (get_accounts, the requests of a moment
 *     batched into one call) and kept an hour; "no picture" is kept too.
 *   - Cached per (account, URL), bounded in bytes: a new picture (a new URL)
 *     shows after the next read; the same URL is fetched again once a day. A
 *     failure is remembered for an hour.
 *   - When the picture's own host fails, the Blurt image proxy's copy
 *     (imgp.blurt.blog, allowed to redirect within its own origin).
 *   - Never on a hidden-only instance (clearnetRefused): it must not reach
 *     clearnet at all.
 *   - Fetched only when a visitor's page asks for one: nothing is fetched while
 *     nobody looks, and a visitor's page asks only after he turned pictures on.
 */

import type { BlurtClient } from '$blurt/client';
import { clearnetRefused } from '$indexer/hiddenServiceDispatcher';
import { fetchPublicBytes, resolvePublicIpCares } from '$indexer/federationProbe';
import { profileImageUrl } from '$indexer/witnessRanking';
import { logger } from '$log';

const log = logger('account-pictures');

/** An account's picture URL is read from the chain again after this. */
export const PICTURE_URL_TTL_MS = 60 * 60_000;
/** At most this many accounts' URLs are kept (oldest first out). */
export const PICTURE_URL_CACHE_MAX = 20_000;
/** Accounts whose URL is wanted within this window share one get_accounts. */
export const PICTURE_URL_BATCH_WAIT_MS = 25;
/** get_accounts takes at most this many names. */
export const PICTURE_URL_BATCH_MAX = 100;
/** A picture is fetched again after this. */
export const AVATAR_TTL_MS = 24 * 60 * 60_000;
/** A failed picture is not tried again before this. */
export const AVATAR_FAIL_TTL_MS = 60 * 60_000;
/** Largest picture accepted. */
export const AVATAR_MAX_BYTES = 1024 * 1024;
/** All cached pictures together, at most (oldest dropped first). */
export const AVATAR_CACHE_MAX_BYTES = 48 * 1024 * 1024;
/** Pictures fetched at once, at most. */
export const AVATAR_FETCH_CONCURRENCY = 4;
/** Fetches waiting for a slot, at most (review, v1.23.3: any account can be
 *  asked for now, so the queue is no longer bounded by the witness list). A
 *  request beyond it gets "no picture now" — no failure is noted, so the next
 *  page asks again. */
export const AVATAR_QUEUE_MAX = 64;
/** Failures remembered, at most (oldest first out). */
export const AVATAR_FAILED_MAX = 10_000;
/** One picture fetch, at most — the DNS lookup and (for the Blurt image proxy)
 *  its redirects included. A picture is at most two of them: its own host, then
 *  the proxy (v1.23.2). */
export const AVATAR_FETCH_TIMEOUT_MS = 10_000;
/** Largest width or height accepted (a small file can declare a huge image
 *  that a browser would then have to allocate). */
export const AVATAR_MAX_SIDE = 4096;
/** (v1.23.2) When an account's picture cannot be fetched from its own host, the
 *  Blurt image proxy's copy of that account's picture. Many pictures were on
 *  hosts that have since gone (on 2026-11-05 img.blurt.world went with the
 *  blurt.world domain, and images.blurt.buzz does not exist); the proxy still
 *  serves them. Asked only for an account that set a picture (so one with
 *  none keeps its identicon, not the proxy's default), through the same
 *  guarded fetch, and allowed to redirect only within its own origin. */
export const AVATAR_PROXY_ORIGIN = 'https://imgp.blurt.blog';
/** The proxy answers with its resized copy, possibly through a redirect or two
 *  (its imagehoster's /profileimage → /<size>/<url> → /p/<id> shape); one more
 *  for room. The whole chain shares one timeout (fetchPublicBytes). */
export const AVATAR_PROXY_REDIRECTS = 3;
export const avatarProxyUrl = (owner: string): string =>
	`${AVATAR_PROXY_ORIGIN}/profileimage/${owner}/64x64`;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** The picture's real type, from its first bytes; null when it is not a PNG,
 *  JPEG, GIF or WebP (an SVG, an HTML error page, anything else). PURE. */
export function sniffImageType(b: Uint8Array): ImageType | null {
	if (
		b.length >= 8 &&
		b[0] === 0x89 &&
		b[1] === 0x50 &&
		b[2] === 0x4e &&
		b[3] === 0x47 &&
		b[4] === 0x0d &&
		b[5] === 0x0a &&
		b[6] === 0x1a &&
		b[7] === 0x0a
	)
		return 'image/png';
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (
		b.length >= 6 &&
		b[0] === 0x47 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x38 &&
		(b[4] === 0x37 || b[4] === 0x39) &&
		b[5] === 0x61
	)
		return 'image/gif';
	if (
		b.length >= 12 &&
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	)
		return 'image/webp';
	return null;
}

/** The width and height a picture declares in its header, or null when the
 *  header cannot be read (then the picture is refused). PURE. */
export function imageDimensions(b: Uint8Array, type: ImageType): { w: number; h: number } | null {
	const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
	const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
	const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
	const u32be = (i: number) =>
		((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
	if (type === 'image/png') {
		// The first chunk is IHDR: width and height, 4 bytes each.
		if (b.length < 24 || String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR')
			return null;
		return { w: u32be(16), h: u32be(20) };
	}
	if (type === 'image/gif') {
		if (b.length < 10) return null;
		return { w: u16le(6), h: u16le(8) };
	}
	if (type === 'image/webp') {
		if (b.length < 30) return null;
		const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
		if (chunk === 'VP8 ') return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
		if (chunk === 'VP8L') {
			if (b[20] !== 0x2f) return null;
			return {
				w: 1 + (((b[22]! & 0x3f) << 8) | b[21]!),
				h: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6))
			};
		}
		if (chunk === 'VP8X') return { w: 1 + u24le(24), h: 1 + u24le(27) };
		return null;
	}
	// JPEG: walk the segments to the first start-of-frame.
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return null;
		const m = b[i + 1]!;
		if (m === 0xff) {
			i++;
			continue;
		}
		if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
			i += 2;
			continue;
		}
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
			return { w: u16be(i + 7), h: u16be(i + 5) };
		}
		if (m === 0xd9 || m === 0xda) return null;
		i += 2 + u16be(i + 2);
	}
	return null;
}

export interface CachedPicture {
	readonly bytes: Uint8Array;
	readonly type: ImageType;
	readonly at: number;
}

export interface AccountPicturesDeps {
	readonly blurt: Pick<BlurtClient, 'getAccounts'>;
	readonly now?: () => number;
	/** Whether this instance may reach clearnet (false on a hidden-only one). */
	readonly allowed?: () => boolean;
	readonly fetchImage?: (
		url: string,
		opts?: { readonly sameOriginRedirects?: number }
	) => Promise<{ readonly bytes: Uint8Array }>;
}

export class AccountPictures {
	private readonly now: () => number;
	readonly allowed: () => boolean;
	private readonly fetchImage: NonNullable<AccountPicturesDeps['fetchImage']>;
	/** account → { url (null: none set), read at }. */
	private readonly urls = new Map<string, { readonly url: string | null; readonly at: number }>();
	private pendingNames = new Set<string>();
	private pendingBatch: Promise<void> | null = null;
	private readonly pictures = new Map<string, CachedPicture>(); // `${account}\n${url}`
	private pictureBytes = 0;
	private readonly failed = new Map<string, number>();
	private readonly inFlight = new Map<string, Promise<CachedPicture | null>>();
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(private readonly deps: AccountPicturesDeps) {
		this.now = deps.now ?? Date.now;
		this.allowed = deps.allowed ?? (() => !clearnetRefused());
		this.fetchImage =
			deps.fetchImage ??
			((url, o) =>
				fetchPublicBytes(url, {
					...(o?.sameOriginRedirects ? { sameOriginRedirects: o.sameOriginRedirects } : {}),
					timeoutMs: AVATAR_FETCH_TIMEOUT_MS,
					maxBytes: AVATAR_MAX_BYTES,
					accept: 'image/png,image/jpeg,image/gif,image/webp',
					userAgent: 'morphit-indexer/account-picture',
					// c-ares with its own timeout: a host the account chose must not
					// hold the thread pool every other lookup needs (review, v1.23.0).
					resolve: (host) => resolvePublicIpCares(host)
				}));
	}

	/** What a fresh read of the chain said (the witness list reads its
	 *  witnesses' URLs in bulk). `null`: the account sets no picture. */
	noteUrl(account: string, url: string | null): void {
		this.urls.delete(account);
		this.urls.set(account, { url, at: this.now() });
		while (this.urls.size > PICTURE_URL_CACHE_MAX) {
			this.urls.delete(this.urls.keys().next().value!);
		}
	}

	/** The picture URL an account set in its Blurt profile (null: none, or
	 *  the chain could not be read). Reads within a moment share one call. */
	async urlOf(account: string): Promise<string | null> {
		const kept = this.urls.get(account);
		if (kept && this.now() - kept.at < PICTURE_URL_TTL_MS) return kept.url;
		this.pendingNames.add(account);
		if (this.pendingBatch === null) {
			this.pendingBatch = new Promise<void>((resolve) => {
				const t = setTimeout(resolve, PICTURE_URL_BATCH_WAIT_MS);
				t.unref?.();
			}).then(async () => {
				const names = [...this.pendingNames];
				this.pendingNames = new Set();
				this.pendingBatch = null;
				for (let i = 0; i < names.length; i += PICTURE_URL_BATCH_MAX) {
					const batch = names.slice(i, i + PICTURE_URL_BATCH_MAX);
					try {
						const accounts = await this.deps.blurt.getAccounts(batch, { userFacing: false });
						for (const name of batch) {
							const acc = accounts.get(name);
							this.noteUrl(
								name,
								acc === undefined
									? null
									: profileImageUrl(
											acc as unknown as {
												posting_json_metadata?: unknown;
												json_metadata?: unknown;
											}
										)
							);
						}
					} catch (err) {
						// Not known now: nothing noted, asked again next time.
						log.warn('picture_urls_read_failed', { n: batch.length }, err);
					}
				}
			});
		}
		await this.pendingBatch;
		return this.urls.get(account)?.url ?? null;
	}

	/** An account's picture, or null when there is none to show (or this
	 *  instance may not fetch it). */
	async pictureOf(account: string): Promise<CachedPicture | null> {
		if (!this.allowed()) return null;
		const url = await this.urlOf(account);
		if (url === null) return null;
		return this.picture(account, url);
	}

	private async acquire(): Promise<void> {
		if (this.active < AVATAR_FETCH_CONCURRENCY) {
			this.active++;
			return;
		}
		// The releasing fetch hands its slot straight over (the count stays):
		// counting down and then up a microtask later let a new caller in
		// between, one over the limit (review, v1.23.0).
		await new Promise<void>((resolve) => this.queue.push(resolve));
	}

	private release(): void {
		const next = this.queue.shift();
		if (next) next();
		else this.active--;
	}

	private remember(key: string, v: CachedPicture): void {
		const old = this.pictures.get(key);
		if (old) {
			this.pictureBytes -= old.bytes.byteLength;
			this.pictures.delete(key);
		}
		// Drop every older picture of this account (a changed URL).
		const owner = key.slice(0, key.indexOf('\n'));
		for (const [k, c] of this.pictures) {
			if (k.startsWith(`${owner}\n`)) {
				this.pictureBytes -= c.bytes.byteLength;
				this.pictures.delete(k);
			}
		}
		this.pictures.set(key, v);
		this.pictureBytes += v.bytes.byteLength;
		for (const [k, c] of this.pictures) {
			if (this.pictureBytes <= AVATAR_CACHE_MAX_BYTES) break;
			if (k === key) continue;
			this.pictureBytes -= c.bytes.byteLength;
			this.pictures.delete(k);
		}
	}

	/** The picture at `url` for `account` (cached a day), or null when there
	 *  is none to show. */
	async picture(account: string, url: string): Promise<CachedPicture | null> {
		if (!this.allowed()) return null;
		const key = `${account}\n${url}`;
		const now = this.now();
		const hit = this.pictures.get(key);
		if (hit && now - hit.at < AVATAR_TTL_MS) {
			// Most recently used last (the cache drops the oldest first).
			this.pictures.delete(key);
			this.pictures.set(key, hit);
			return hit;
		}
		const failedAt = this.failed.get(key);
		if (failedAt !== undefined && now - failedAt < AVATAR_FAIL_TTL_MS) return hit ?? null;
		let p = this.inFlight.get(key);
		if (!p) {
			// Every slot busy and the queue full: nothing now, nothing noted.
			if (this.active >= AVATAR_FETCH_CONCURRENCY && this.queue.length >= AVATAR_QUEUE_MAX) {
				return hit ?? null;
			}
			p = (async () => {
				await this.acquire();
				try {
					const load = async (
						from: string,
						o?: { readonly sameOriginRedirects?: number }
					): Promise<{ bytes: Uint8Array; type: ImageType }> => {
						const { bytes } = await this.fetchImage(from, o);
						const type = sniffImageType(bytes);
						if (type === null) throw new Error('not a PNG, JPEG, GIF or WebP');
						const dims = imageDimensions(bytes, type);
						if (dims === null) throw new Error('unreadable image header');
						if (dims.w < 1 || dims.h < 1 || dims.w > AVATAR_MAX_SIDE || dims.h > AVATAR_MAX_SIDE) {
							throw new Error(
								`image ${dims.w}×${dims.h} is larger than ${AVATAR_MAX_SIDE}px a side`
							);
						}
						return { bytes, type };
					};
					let got: { bytes: Uint8Array; type: ImageType };
					// A picture already on the proxy (in any form) gets the proxy's
					// redirects at once, and no second try from the same proxy.
					const onProxy = new URL(url).origin === AVATAR_PROXY_ORIGIN;
					try {
						got = await load(
							url,
							onProxy ? { sameOriginRedirects: AVATAR_PROXY_REDIRECTS } : undefined
						);
					} catch (own) {
						// v1.23.2: the picture's own host failed (gone, down, not an
						// image): the Blurt image proxy's copy of that account's picture.
						if (onProxy) throw own;
						const proxied = avatarProxyUrl(account);
						const ownWhy = own instanceof Error ? own.message : String(own);
						try {
							got = await load(proxied, { sameOriginRedirects: AVATAR_PROXY_REDIRECTS });
						} catch (px) {
							throw new Error(
								`${ownWhy}; ${AVATAR_PROXY_ORIGIN}: ${px instanceof Error ? px.message : String(px)}`
							);
						}
						log.info('avatar_via_proxy', { owner: account, reason: ownWhy });
					}
					const v: CachedPicture = { bytes: got.bytes, type: got.type, at: this.now() };
					this.remember(key, v);
					this.failed.delete(key);
					return v;
				} catch (err) {
					log.info('avatar_unavailable', {
						owner: account,
						reason: err instanceof Error ? err.message : String(err)
					});
					const at = this.now();
					// Expired failures go when a new one is noted, so the map stays small.
					// Kept in the order noted, so the expired ones are at the front.
					for (const [k, t] of this.failed) {
						if (at - t < AVATAR_FAIL_TTL_MS) break;
						this.failed.delete(k);
					}
					this.failed.delete(key);
					this.failed.set(key, at);
					while (this.failed.size > AVATAR_FAILED_MAX) {
						this.failed.delete(this.failed.keys().next().value!);
					}
					// A picture that fetched before keeps showing until it fetches again.
					return hit ?? null;
				} finally {
					this.release();
					this.inFlight.delete(key);
				}
			})();
			this.inFlight.set(key, p);
		}
		return p;
	}
}
