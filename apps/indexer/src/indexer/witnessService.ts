/**
 * Morphit indexer — the /witnesses page's data (v1.23.0): the ranked witness
 * list, the "missed in 24 h" samples, and the witnesses' pictures.
 *
 * THE LIST is read from the chain (get_witnesses_by_vote, paged) at most once
 * a minute whatever the number of visitors, coalesced, and ranked by
 * witnessRanking.ts.
 *
 * MISSED IN 24 H. The chain keeps only each witness's running total of missed
 * blocks. Every SAMPLE_EVERY_MS this indexer writes the total of every
 * producing witness to witness_missed_samples (local only, never in a
 * snapshot), and keeps a little over a day of them; the flag is the current
 * total minus the one a day ago. An instance that has watched for less says
 * so ("in 5 h"), and one that has watched for under an hour says nothing.
 *
 * PICTURES, through this instance (owner, 2026-11-05). Every page's
 * Content-Security-Policy lets the browser load images from its own instance
 * only, and the FAQ promises the browser contacts nothing else. So a witness's
 * picture is fetched HERE, by fetchPublicBytes — the federation probe's
 * guarded fetch (https only, every DNS record public, connection pinned,
 * redirects refused, body capped; v1.23.1: when that host fails, the Blurt
 * image proxy's copy, which may redirect within its own origin) — checked to BE
 * a PNG, JPEG, GIF or WebP by
 * its first bytes (never SVG: it can carry script), and served from
 * /v1/witnesses/avatar/<owner>. Nobody but this instance learns who looked.
 *   - Only for an account in the current witness list: the endpoint is no
 *     general-purpose image proxy.
 *   - Cached per (witness, picture URL): a witness who sets a new picture
 *     (a new URL) is picked up at the next accounts read (ACCOUNTS_TTL_MS); the
 *     same URL is fetched again once a day, so a picture replaced in place
 *     shows within a day (the owner's "check for image differences once per
 *     day"). A failure is remembered for an hour.
 *   - Never on a hidden-only instance (clearnetRefused): it must not reach
 *     clearnet at all, so the list says `avatars: false` and the page offers
 *     no "display" link there (owner: "zero clearnet instances should not
 *     have that display link at all").
 *   - Fetched only when a visitor asks for one (the page's "display" link):
 *     nothing is fetched while nobody looks.
 */

import { createHash } from 'node:crypto';

import type { BlurtClient, ChainAccount } from '$blurt/client';
import type { Database } from '$db/pool';
import { clearnetRefused } from '$indexer/hiddenServiceDispatcher';
import { fetchPublicBytes, resolvePublicIpCares } from '$indexer/federationProbe';
import {
	MAX_WITNESS_VOTES,
	MISSED_WINDOW_MS,
	isProducingWitness,
	profileImageUrl,
	rankWitnesses,
	type MissedSample,
	type RankedWitness,
	type RankingChainState,
	type RawWitness
} from '$indexer/witnessRanking';
import { isAccountName } from '$api/shared';
import { logger } from '$log';

const log = logger('witnesses');

/** The list is read from the chain at most this often. */
export const LIST_TTL_MS = 60_000;
/** How often the missed totals are written down. */
export const SAMPLE_EVERY_MS = 10 * 60_000;
/** Samples older than this are deleted (a day, plus room for a late tick). */
export const SAMPLE_KEEP_MS = 26 * 60 * 60_000;
/** Witness accounts' metadata (picture URLs) is read again after this. */
export const ACCOUNTS_TTL_MS = 60 * 60_000;
/** get_witnesses_by_vote answers at most this many per call. */
export const WITNESS_PAGE = 1000;
/** Pages read at most (5000 witnesses; Blurt has a few hundred). */
export const WITNESS_PAGES_MAX = 5;
/** Accounts per get_accounts call (100 ≈ 240 KB). */
export const ACCOUNTS_BATCH = 100;
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
/** One picture fetch, at most — the DNS lookup and (for the Blurt image proxy)
 *  its redirects included. A picture is at most two of them: its own host, then
 *  the proxy (v1.23.1). */
export const AVATAR_FETCH_TIMEOUT_MS = 10_000;
/** Largest width or height accepted (a small file can declare a huge image
 *  that a browser would then have to allocate). */
export const AVATAR_MAX_SIDE = 4096;
/** (v1.23.1) When a witness's picture cannot be fetched from its own host, the
 *  Blurt image proxy's copy of that account's picture. Many pictures were on
 *  hosts that have since gone (on 2026-11-05 img.blurt.world went with the
 *  blurt.world domain, and images.blurt.buzz does not exist); the proxy still
 *  serves them. Asked only for a witness that set a picture (so a witness with
 *  none keeps the plain head, not the proxy's default), through the same
 *  guarded fetch, and allowed to redirect only within its own origin. */
export const AVATAR_PROXY_ORIGIN = 'https://imgp.blurt.blog';
/** The proxy answers with its resized copy, possibly through a redirect or two
 *  (its imagehoster's /profileimage → /<size>/<url> → /p/<id> shape); one more
 *  for room. The whole chain shares one timeout (fetchPublicBytes). */
export const AVATAR_PROXY_REDIRECTS = 3;
export const avatarProxyUrl = (owner: string): string =>
	`${AVATAR_PROXY_ORIGIN}/profileimage/${owner}/64x64`;

export interface WitnessListBody {
	readonly network: 'morphit';
	readonly generated_at: string;
	readonly head_block: number;
	/** Newest version a producing witness runs ("0.9.1"). */
	readonly newest_version: string | null;
	/** This instance serves the witnesses' pictures (false on a hidden-only one). */
	readonly avatars: boolean;
	readonly max_votes: number;
	readonly producing_window_days: number;
	readonly missed_window_hours: number;
	readonly witnesses: readonly (RankedWitness & {
		/** This instance's path to the picture, or null when there is none to show. */
		readonly avatar: string | null;
	})[];
}

export interface WitnessVotesBody {
	readonly account: string;
	readonly votes: readonly string[];
	/** The account votes through this proxy; its own votes do not count then. */
	readonly proxy: string | null;
	readonly max_votes: number;
}

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

/** The version tag in a picture's path: changes when the witness's picture URL does. PURE. */
export function avatarVersion(url: string): string {
	return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

function isRawWitness(v: unknown): v is RawWitness {
	if (typeof v !== 'object' || v === null) return false;
	const w = v as Record<string, unknown>;
	return (
		typeof w.owner === 'string' &&
		isAccountName(w.owner) &&
		typeof w.total_missed === 'number' &&
		typeof w.last_confirmed_block_num === 'number' &&
		(typeof w.votes === 'string' || typeof w.votes === 'number')
	);
}

interface CachedAvatar {
	readonly bytes: Uint8Array;
	readonly type: ImageType;
	readonly at: number;
}

export interface WitnessServiceDeps {
	readonly blurt: Pick<BlurtClient, 'callCondenser' | 'getDynamicGlobalProperties' | 'getAccounts'>;
	/** Writes the samples. */
	readonly db: Pick<Database, 'query'>;
	/** Reads the samples (the API pool). */
	readonly apiDb: Pick<Database, 'query'>;
	readonly now?: () => number;
	/** Whether this instance may reach clearnet (false on a hidden-only one). */
	readonly avatarsAllowed?: () => boolean;
	readonly fetchImage?: (
		url: string,
		opts?: { readonly sameOriginRedirects?: number }
	) => Promise<{ readonly bytes: Uint8Array }>;
}

export class WitnessService {
	private readonly now: () => number;
	private readonly avatarsAllowed: () => boolean;
	private readonly fetchImage: (
		url: string,
		opts?: { readonly sameOriginRedirects?: number }
	) => Promise<{ readonly bytes: Uint8Array }>;
	private list: { readonly at: number; readonly body: WitnessListBody } | null = null;
	private listInFlight: Promise<WitnessListBody> | null = null;
	private pictures = new Map<string, string>(); // owner → picture URL
	private picturesAt = 0;
	private picturesInFlight: Promise<void> | null = null;
	private readonly avatars = new Map<string, CachedAvatar>(); // `${owner}\n${url}`
	private avatarBytes = 0;
	private readonly avatarFailed = new Map<string, number>();
	private readonly avatarInFlight = new Map<string, Promise<CachedAvatar | null>>();
	private avatarActive = 0;
	private readonly avatarQueue: Array<() => void> = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;

	constructor(private readonly deps: WitnessServiceDeps) {
		this.now = deps.now ?? Date.now;
		this.avatarsAllowed = deps.avatarsAllowed ?? (() => !clearnetRefused());
		this.fetchImage =
			deps.fetchImage ??
			((url, o) =>
				fetchPublicBytes(url, {
					...(o?.sameOriginRedirects ? { sameOriginRedirects: o.sameOriginRedirects } : {}),
					timeoutMs: AVATAR_FETCH_TIMEOUT_MS,
					maxBytes: AVATAR_MAX_BYTES,
					accept: 'image/png,image/jpeg,image/gif,image/webp',
					userAgent: 'morphit-indexer/witness-avatar',
					// c-ares with its own timeout: a host the witness chose must not
					// hold the thread pool every other lookup needs (review, v1.23.0).
					resolve: (host) => resolvePublicIpCares(host)
				}));
	}

	/** Write the missed totals every SAMPLE_EVERY_MS (first one shortly after start). */
	start(): void {
		if (this.timer !== null || this.stopped) return;
		const first = setTimeout(() => void this.sample(), 30_000);
		first.unref?.();
		this.timer = setInterval(() => void this.sample(), SAMPLE_EVERY_MS);
		this.timer.unref?.();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}

	/** Read every witness in vote order, page by page. */
	async readWitnesses(): Promise<RawWitness[]> {
		const out: RawWitness[] = [];
		const seen = new Set<string>();
		let start = '';
		for (let page = 0; page < WITNESS_PAGES_MAX; page++) {
			const res = await this.deps.blurt.callCondenser<unknown>(
				'get_witnesses_by_vote',
				[start, WITNESS_PAGE],
				{
					userFacing: false
				}
			);
			if (!Array.isArray(res)) throw new Error('get_witnesses_by_vote returned unexpected shape');
			let added = 0;
			for (const w of res) {
				if (!isRawWitness(w) || seen.has(w.owner)) continue;
				seen.add(w.owner);
				out.push(w);
				added++;
			}
			// A full page continues from its last witness (which the next page repeats).
			if (res.length < WITNESS_PAGE || added === 0) break;
			start = out[out.length - 1]!.owner;
		}
		return out;
	}

	private chainState(dgp: unknown): RankingChainState {
		const d = dgp as Record<string, unknown>;
		if (
			typeof d.head_block_number !== 'number' ||
			typeof d.total_vesting_fund_blurt !== 'string' ||
			typeof d.total_vesting_shares !== 'string'
		) {
			throw new Error('dynamic global properties: unexpected shape');
		}
		return {
			head_block_number: d.head_block_number,
			total_vesting_fund_blurt: d.total_vesting_fund_blurt,
			total_vesting_shares: d.total_vesting_shares
		};
	}

	/** Write the missed totals of the producing witnesses; drop samples over a day old. */
	async sample(): Promise<void> {
		if (this.stopped) return;
		try {
			const [raw, dgp] = await Promise.all([
				this.readWitnesses(),
				this.deps.blurt.getDynamicGlobalProperties()
			]);
			const head = this.chainState(dgp).head_block_number;
			const producing = raw.filter((w) => isProducingWitness(w, head));
			const at = new Date(this.now()).toISOString();
			if (producing.length > 0) {
				await this.deps.db.query(
					`INSERT INTO witness_missed_samples (owner, sampled_at, total_missed)
					 SELECT o, $1::timestamptz, m FROM UNNEST($2::text[], $3::bigint[]) AS t(o, m)
					 ON CONFLICT (owner, sampled_at) DO NOTHING`,
					[
						at,
						producing.map((w) => w.owner),
						producing.map((w) => Math.max(0, Math.floor(w.total_missed)))
					]
				);
			}
			await this.deps.db.query(
				`DELETE FROM witness_missed_samples WHERE sampled_at < $1::timestamptz`,
				[new Date(this.now() - SAMPLE_KEEP_MS).toISOString()]
			);
		} catch (err) {
			log.warn('sample_failed', {}, err);
		}
	}

	/** Each witness's baseline samples: the latest at least 24 h old, and the oldest. */
	private async readSamples(): Promise<
		Map<string, { atOrBefore24h: MissedSample | null; oldest: MissedSample | null }>
	> {
		const out = new Map<
			string,
			{ atOrBefore24h: MissedSample | null; oldest: MissedSample | null }
		>();
		const cutoff = new Date(this.now() - MISSED_WINDOW_MS).toISOString();
		const entry = (o: string) => {
			let e = out.get(o);
			if (!e) out.set(o, (e = { atOrBefore24h: null, oldest: null }));
			return e;
		};
		const toSample = (r: {
			sampled_at: Date | string;
			total_missed: string | number;
		}): MissedSample => ({
			sampledAtMs: new Date(r.sampled_at).getTime(),
			totalMissed: Number(r.total_missed)
		});
		type Row = { owner: string; sampled_at: Date | string; total_missed: string | number };
		const before = await this.deps.apiDb.query<Row>(
			`SELECT DISTINCT ON (owner) owner, sampled_at, total_missed FROM witness_missed_samples
			 WHERE sampled_at <= $1::timestamptz ORDER BY owner, sampled_at DESC`,
			[cutoff]
		);
		for (const r of before.rows) entry(r.owner).atOrBefore24h = toSample(r);
		const oldest = await this.deps.apiDb.query<Row>(
			`SELECT DISTINCT ON (owner) owner, sampled_at, total_missed FROM witness_missed_samples
			 ORDER BY owner, sampled_at ASC`
		);
		for (const r of oldest.rows) entry(r.owner).oldest = toSample(r);
		return out;
	}

	/** Refresh the witnesses' picture URLs (at most once an hour; never on a hidden-only instance). */
	private async refreshPictures(owners: readonly string[]): Promise<void> {
		if (!this.avatarsAllowed()) return;
		if (this.picturesAt > 0 && this.now() - this.picturesAt < ACCOUNTS_TTL_MS) return;
		if (this.picturesInFlight) return this.picturesInFlight;
		this.picturesInFlight = (async () => {
			try {
				const next = new Map<string, string>();
				for (let i = 0; i < owners.length; i += ACCOUNTS_BATCH) {
					const batch = owners.slice(i, i + ACCOUNTS_BATCH);
					const accounts = await this.deps.blurt.getAccounts(batch, { userFacing: false });
					for (const [name, acc] of accounts) {
						const url = profileImageUrl(
							acc as unknown as { posting_json_metadata?: unknown; json_metadata?: unknown }
						);
						if (url !== null) next.set(name, url);
					}
				}
				this.pictures = next;
				this.picturesAt = this.now();
				// Forget pictures and failures of URLs no longer current.
				const current = new Set([...next].map(([o, u]) => `${o}\n${u}`));
				for (const [k, c] of this.avatars) {
					if (!current.has(k)) {
						this.avatarBytes -= c.bytes.byteLength;
						this.avatars.delete(k);
					}
				}
				for (const k of this.avatarFailed.keys()) if (!current.has(k)) this.avatarFailed.delete(k);
			} catch (err) {
				log.warn('pictures_read_failed', {}, err);
			} finally {
				this.picturesInFlight = null;
			}
		})();
		return this.picturesInFlight;
	}

	/** The ranked list (cached LIST_TTL_MS, one read at a time). */
	async getList(): Promise<WitnessListBody> {
		if (this.list !== null && this.now() - this.list.at < LIST_TTL_MS) return this.list.body;
		if (this.listInFlight) return this.listInFlight;
		this.listInFlight = (async () => {
			try {
				let raw: RawWitness[];
				let dgp: unknown;
				try {
					[raw, dgp] = await Promise.all([
						this.readWitnesses(),
						this.deps.blurt.getDynamicGlobalProperties()
					]);
				} catch (err) {
					// The chain cannot be read right now: the last list is better than
					// an error page (its generated_at says how old it is).
					if (this.list !== null) {
						log.warn('list_read_failed_serving_last', {
							reason: err instanceof Error ? err.message : String(err)
						});
						return this.list.body;
					}
					throw err;
				}
				const chain = this.chainState(dgp);
				let samples = new Map<
					string,
					{ atOrBefore24h: MissedSample | null; oldest: MissedSample | null }
				>();
				try {
					samples = await this.readSamples();
				} catch (err) {
					// No samples is "not known", never an error page.
					log.warn('samples_read_failed', {}, err);
				}
				const avatars = this.avatarsAllowed();
				const nowMs = this.now();
				const ranked = rankWitnesses(raw, chain, samples, nowMs);
				// Pictures of PRODUCING witnesses only (review, v1.23.0): anyone can
				// register a witness and point its picture anywhere; a producing one
				// has real votes behind it. The others are hidden by default anyway.
				if (avatars) {
					await this.refreshPictures(
						ranked.witnesses.filter((w) => w.producing).map((w) => w.owner)
					);
				}
				const body: WitnessListBody = {
					network: 'morphit',
					generated_at: new Date(nowMs).toISOString(),
					head_block: chain.head_block_number,
					newest_version: ranked.newestVersion,
					avatars,
					max_votes: MAX_WITNESS_VOTES,
					producing_window_days: 30,
					missed_window_hours: MISSED_WINDOW_MS / 3_600_000,
					witnesses: ranked.witnesses.map((w) => {
						const pic = avatars && w.producing ? this.pictures.get(w.owner) : undefined;
						return {
							...w,
							avatar:
								pic === undefined ? null : `/v1/witnesses/avatar/${w.owner}?v=${avatarVersion(pic)}`
						};
					})
				};
				this.list = { at: nowMs, body };
				return body;
			} finally {
				this.listInFlight = null;
			}
		})();
		return this.listInFlight;
	}

	/** An account's witness votes and proxy, from the chain. */
	async getVotes(account: string): Promise<WitnessVotesBody | null> {
		const map = await this.deps.blurt.getAccounts([account], { userFacing: true });
		const acc = map.get(account) as (ChainAccount & Record<string, unknown>) | undefined;
		if (acc === undefined) return null;
		const votes = Array.isArray(acc.witness_votes)
			? (acc.witness_votes as unknown[]).filter((v): v is string => typeof v === 'string')
			: [];
		const proxy = typeof acc.proxy === 'string' && acc.proxy.length > 0 ? acc.proxy : null;
		return { account, votes, proxy, max_votes: MAX_WITNESS_VOTES };
	}

	private async acquire(): Promise<void> {
		if (this.avatarActive < AVATAR_FETCH_CONCURRENCY) {
			this.avatarActive++;
			return;
		}
		// The releasing fetch hands its slot straight over (the count stays):
		// counting down and then up a microtask later let a new caller in
		// between, one over the limit (review, v1.23.0).
		await new Promise<void>((resolve) => this.avatarQueue.push(resolve));
	}

	private release(): void {
		const next = this.avatarQueue.shift();
		if (next) next();
		else this.avatarActive--;
	}

	private remember(key: string, v: CachedAvatar): void {
		const old = this.avatars.get(key);
		if (old) {
			this.avatarBytes -= old.bytes.byteLength;
			this.avatars.delete(key);
		}
		// Drop every older picture of this witness (a changed URL).
		const owner = key.slice(0, key.indexOf('\n'));
		for (const [k, c] of this.avatars) {
			if (k.startsWith(`${owner}\n`)) {
				this.avatarBytes -= c.bytes.byteLength;
				this.avatars.delete(k);
			}
		}
		this.avatars.set(key, v);
		this.avatarBytes += v.bytes.byteLength;
		for (const [k, c] of this.avatars) {
			if (this.avatarBytes <= AVATAR_CACHE_MAX_BYTES) break;
			if (k === key) continue;
			this.avatarBytes -= c.bytes.byteLength;
			this.avatars.delete(k);
		}
	}

	/** A witness's picture (cached a day), or null when there is none to show. */
	async getAvatar(
		owner: string
	): Promise<{ readonly bytes: Uint8Array; readonly type: ImageType } | null> {
		if (!this.avatarsAllowed()) return null;
		const list = await this.getList();
		if (!list.witnesses.some((w) => w.owner === owner && w.producing)) return null;
		const url = this.pictures.get(owner);
		if (url === undefined) return null;
		const key = `${owner}\n${url}`;
		const now = this.now();
		const hit = this.avatars.get(key);
		if (hit && now - hit.at < AVATAR_TTL_MS) {
			// Most recently used last (the cache drops the oldest first).
			this.avatars.delete(key);
			this.avatars.set(key, hit);
			return hit;
		}
		const failedAt = this.avatarFailed.get(key);
		if (failedAt !== undefined && now - failedAt < AVATAR_FAIL_TTL_MS) return hit ?? null;
		let p = this.avatarInFlight.get(key);
		if (!p) {
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
						// v1.23.1: the picture's own host failed (gone, down, not an
						// image): the Blurt image proxy's copy of that account's picture.
						if (onProxy) throw own;
						const proxied = avatarProxyUrl(owner);
						const ownWhy = own instanceof Error ? own.message : String(own);
						try {
							got = await load(proxied, { sameOriginRedirects: AVATAR_PROXY_REDIRECTS });
						} catch (px) {
							throw new Error(
								`${ownWhy}; ${AVATAR_PROXY_ORIGIN}: ${px instanceof Error ? px.message : String(px)}`
							);
						}
						log.info('avatar_via_proxy', { owner, reason: ownWhy });
					}
					const v: CachedAvatar = { bytes: got.bytes, type: got.type, at: this.now() };
					this.remember(key, v);
					this.avatarFailed.delete(key);
					return v;
				} catch (err) {
					log.info('avatar_unavailable', {
						owner,
						reason: err instanceof Error ? err.message : String(err)
					});
					const at = this.now();
					// Expired failures go when a new one is noted, so the map stays small.
					for (const [k, t] of this.avatarFailed)
						if (at - t >= AVATAR_FAIL_TTL_MS) this.avatarFailed.delete(k);
					this.avatarFailed.set(key, at);
					// A picture that fetched before keeps showing until it fetches again.
					return hit ?? null;
				} finally {
					this.release();
					this.avatarInFlight.delete(key);
				}
			})();
			this.avatarInFlight.set(key, p);
		}
		return p;
	}
}
