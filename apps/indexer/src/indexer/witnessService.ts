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
 * redirects refused, body capped; v1.23.2: when that host fails, the Blurt
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
import { AccountPictures, type ImageType } from '$indexer/accountPictures';
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
// The pictures' limits and helpers live with the shared picture fetcher
// (accountPictures.ts, v1.23.3); re-exported for the existing importers.
export {
	AVATAR_CACHE_MAX_BYTES,
	AVATAR_FAIL_TTL_MS,
	AVATAR_FETCH_CONCURRENCY,
	AVATAR_FETCH_TIMEOUT_MS,
	AVATAR_MAX_BYTES,
	AVATAR_MAX_SIDE,
	AVATAR_PROXY_ORIGIN,
	AVATAR_PROXY_REDIRECTS,
	AVATAR_TTL_MS,
	avatarProxyUrl,
	imageDimensions,
	sniffImageType,
	type ImageType
} from '$indexer/accountPictures';

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
	/** The instance's shared picture fetcher (v1.23.3; one cache for the
	 *  witnesses page and every other page). Made here when not given. */
	readonly pictures?: AccountPictures;
}

export class WitnessService {
	private readonly now: () => number;
	private readonly avatarsAllowed: () => boolean;
	private readonly accountPictures: AccountPictures;
	private list: { readonly at: number; readonly body: WitnessListBody } | null = null;
	private listInFlight: Promise<WitnessListBody> | null = null;
	private pictures = new Map<string, string>(); // owner → picture URL
	private picturesAt = 0;
	private picturesInFlight: Promise<void> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;

	constructor(private readonly deps: WitnessServiceDeps) {
		this.now = deps.now ?? Date.now;
		this.avatarsAllowed = deps.avatarsAllowed ?? (() => !clearnetRefused());
		this.accountPictures =
			deps.pictures ??
			new AccountPictures({
				blurt: deps.blurt,
				now: this.now,
				allowed: this.avatarsAllowed,
				...(deps.fetchImage ? { fetchImage: deps.fetchImage } : {})
			});
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
					// The same read serves every other page's pictures of these
					// accounts (v1.23.3).
					for (const name of batch) this.accountPictures.noteUrl(name, next.get(name) ?? null);
				}
				this.pictures = next;
				this.picturesAt = this.now();
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

	/** A witness's picture (cached a day), or null when there is none to show. */
	async getAvatar(
		owner: string
	): Promise<{ readonly bytes: Uint8Array; readonly type: ImageType } | null> {
		if (!this.avatarsAllowed()) return null;
		const list = await this.getList();
		if (!list.witnesses.some((w) => w.owner === owner && w.producing)) return null;
		const url = this.pictures.get(owner);
		if (url === undefined) return null;
		return this.accountPictures.picture(owner, url);
	}
}
