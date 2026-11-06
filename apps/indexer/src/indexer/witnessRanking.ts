/**
 * Morphit indexer — Blurt witness ranking for the /witnesses page (v1.23.0).
 *
 * PURE: no I/O, no clock of its own (`nowMs` is passed in), so every rule here
 * is pinned by unit tests (test/indexer/witnessRanking.test.ts).
 *
 * WHAT THE PAGE IS FOR
 * Blurt's own wallet lists witnesses by vote rank only. The owner asked for a
 * list that encourages votes for the witnesses that have produced blocks the
 * longest, missing the fewest, on a current version — whatever their rank.
 * Those three things make the STARS (0 to 5, in thirds), and the list is
 * ordered by them.
 *
 * THE STARS
 *     stars = 5 × time × reliability × version, rounded DOWN to a third
 *   - time        = weeks since the witness was created ÷ 260 (five years),
 *                   at most 1;
 *   - reliability = 1 ÷ (1 + missed blocks per week ÷ 50): a witness missing
 *                   50 blocks a week keeps half, one missing 456 (seen on the
 *                   chain) about a tenth;
 *   - version     = 1 on the newest major.minor any producing witness runs
 *                   (0.9.0 counts the same as 0.9.1 — the owner: "nearly the
 *                   same thing"), 0.75 a whole version behind (0.8.x).
 * The factors MULTIPLY, so a long-running witness that misses a lot does not
 * ride its age to the top (an additive first draft put a witness missing 456
 * blocks a week above most others). Only a PRODUCING witness gets stars: one
 * whose signing key is set and that produced a block in the last 30 days. A
 * switched-off or idle witness has missed nothing lately simply because it is
 * no longer scheduled, and must not top the list on age.
 *
 * TRUST
 * Everything comes from one RPC node's answer (the indexer's read pool), like
 * the stats page. It is a display, not consensus: a lying node could reorder
 * the list but cannot cast or change anyone's vote, which the user signs.
 */

/** Most stars a witness can have. */
export const STARS_MAX = 5;
/** Weeks of producing that earn the full time factor (five years). */
export const FULL_TIME_WEEKS = 260;
/** Missed blocks per week that halve the reliability factor. */
export const MISSES_PER_WEEK_HALVING = 50;
/** Version factor for a witness a whole major.minor behind the newest. */
export const OLDER_VERSION_FACTOR = 0.75;
/** A witness is "producing" when its last block is at most this many blocks
 *  old: 30 days of 3-second blocks. */
export const PRODUCING_WINDOW_BLOCKS = 30 * 24 * 60 * 20;
/** Most witnesses one account can vote for on Blurt. */
export const MAX_WITNESS_VOTES = 30;
/** The window of the "missed in 24 h" flag. */
export const MISSED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A shorter history than this says nothing yet (just after a first start). */
export const MISSED_MIN_WINDOW_MS = 60 * 60 * 1000;
/** A major.minor counts as the newest only when at least this many producing
 *  witnesses run it (v1.23.0 review): the chain copies whatever version a
 *  witness's block header claims, so ONE witness reporting "0.255.0" would
 *  otherwise put every other witness a version behind and itself on top. */
export const NEWEST_VERSION_QUORUM = 3;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The witness fields this module reads, as get_witnesses_by_vote returns them. */
export interface RawWitness {
	readonly owner: string;
	readonly created: string;
	readonly url: string;
	readonly votes: string | number;
	readonly total_missed: number;
	readonly last_confirmed_block_num: number;
	readonly signing_key: string;
	readonly running_version: string;
}

/** The dynamic global properties fields used to turn votes into BP. */
export interface RankingChainState {
	readonly head_block_number: number;
	readonly total_vesting_fund_blurt: string;
	readonly total_vesting_shares: string;
}

/** A witness's total missed blocks at an earlier moment (witness_missed_samples). */
export interface MissedSample {
	readonly sampledAtMs: number;
	readonly totalMissed: number;
}

export interface RankedWitness {
	readonly owner: string;
	/** Vote rank, 1 = most votes. */
	readonly rank: number;
	/** The witness's own link (announcement, site), http(s) only; null when absent or unsafe. */
	readonly url: string | null;
	readonly created: string;
	readonly weeks: number;
	readonly total_missed: number;
	/** Blocks missed in the last 24 h (or in `missed_window_hours` when this
	 *  instance has watched for less); null when it has not watched long enough. */
	readonly missed_recent: number | null;
	readonly missed_window_hours: number | null;
	readonly version: string;
	/** A whole major.minor behind the newest a producing witness runs. */
	readonly version_behind: boolean;
	/** Votes received, in BLURT Power. */
	readonly votes_bp: number;
	/** BP more needed to pass the witness one rank up; null for rank 1. */
	readonly needs_bp: number | null;
	readonly producing: boolean;
	/** Signing key cleared: the witness switched itself off. */
	readonly disabled: boolean;
	readonly score: number;
	/** 0..5 in thirds. */
	readonly stars: number;
}

/** The chain's null signing key ("switched off"): the address prefix followed
 *  by ones. Blurt's is BLT1111111111111111111111111111111114T1Anm. */
export function isDisabledSigningKey(key: unknown): boolean {
	return typeof key !== 'string' || /^[A-Z]{3}1{30,}[1-9A-HJ-NP-Za-km-z]{0,6}$/.test(key);
}

/** Signing key set and a block produced within PRODUCING_WINDOW_BLOCKS of `head`. */
export function isProducingWitness(
	w: Pick<RawWitness, 'signing_key' | 'last_confirmed_block_num'>,
	head: number
): boolean {
	return (
		!isDisabledSigningKey(w.signing_key) &&
		typeof w.last_confirmed_block_num === 'number' &&
		w.last_confirmed_block_num > 0 &&
		head - w.last_confirmed_block_num <= PRODUCING_WINDOW_BLOCKS
	);
}

/** "0.9.1" → [0, 9, 1]; anything else → null. */
export function parseVersion(v: unknown): readonly [number, number, number] | null {
	if (typeof v !== 'string') return null;
	const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(v.trim());
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVersion(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
	return 0;
}

/** The newest version the producing witnesses run, judged by major.minor:
 *  the highest major.minor at least NEWEST_VERSION_QUORUM of them run (or, on
 *  a network with fewer producers, the one most of them run), and within it
 *  the highest patch reported. null when no version parses. PURE. */
export function newestVersionOf(
	producing: readonly Pick<RawWitness, 'running_version'>[]
): readonly [number, number, number] | null {
	const byMinor = new Map<string, { count: number; best: readonly [number, number, number] }>();
	for (const w of producing) {
		const v = parseVersion(w.running_version);
		if (v === null) continue;
		const k = `${v[0]}.${v[1]}`;
		const e = byMinor.get(k);
		if (!e) byMinor.set(k, { count: 1, best: v });
		else {
			e.count++;
			if (cmpVersion(v, e.best) > 0) e.best = v;
		}
	}
	if (byMinor.size === 0) return null;
	const groups = [...byMinor.values()];
	const quorate = groups.filter((g) => g.count >= NEWEST_VERSION_QUORUM);
	const pool =
		quorate.length > 0
			? quorate
			: groups.filter((g) => g.count === Math.max(...groups.map((x) => x.count)));
	return pool.reduce((a, b) => (cmpVersion(b.best, a.best) > 0 ? b : a)).best;
}

/** Chain timestamps carry no zone; they are UTC. NaN when unparseable. */
export function chainTimeMs(t: unknown): number {
	if (typeof t !== 'string' || t.length === 0) return NaN;
	return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
}

/** Round DOWN to a third of a star, within 0..STARS_MAX. */
export function starsFromScore(score: number): number {
	if (!Number.isFinite(score) || score <= 0) return 0;
	const thirds = Math.floor(score * 3 + 1e-9);
	return Math.min(STARS_MAX, thirds / 3);
}

/** The score behind the stars (see the header). 0 for a witness not producing. */
export function witnessScore(args: {
	readonly weeks: number;
	readonly totalMissed: number;
	readonly producing: boolean;
	readonly versionBehind: boolean;
}): number {
	if (!args.producing) return 0;
	const weeks = Math.max(0, args.weeks);
	const time = Math.min(weeks / FULL_TIME_WEEKS, 1);
	const perWeek = Math.max(0, args.totalMissed) / Math.max(weeks, 1);
	const reliability = 1 / (1 + perWeek / MISSES_PER_WEEK_HALVING);
	const version = args.versionBehind ? OLDER_VERSION_FACTOR : 1;
	return STARS_MAX * time * reliability * version;
}

/** An http(s) link a witness gave, safe to put in an href, or null. */
export function safeWitnessUrl(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const s = raw.trim();
	if (s.length === 0 || s.length > 512) return null;
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	if (u.username !== '' || u.password !== '') return null;
	if (u.hostname === '') return null;
	return u.href;
}

/** The profile picture an account set (posting metadata first, then the
 *  account metadata), as an https URL safe to fetch, or null. */
export function profileImageUrl(account: {
	readonly posting_json_metadata?: unknown;
	readonly json_metadata?: unknown;
}): string | null {
	for (const raw of [account.posting_json_metadata, account.json_metadata]) {
		if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 * 1024) continue;
		let meta: unknown;
		try {
			meta = JSON.parse(raw);
		} catch {
			continue;
		}
		const img = (meta as { profile?: { profile_image?: unknown } } | null)?.profile?.profile_image;
		if (typeof img !== 'string') continue;
		const s = img.trim();
		if (s.length === 0 || s.length > 2048) continue;
		let u: URL;
		try {
			u = new URL(s);
		} catch {
			continue;
		}
		if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') continue;
		const host = u.hostname.toLowerCase().replace(/\.$/, '');
		if (host === '' || /\.(onion|i2p|loki)$/.test(host)) continue;
		if (u.port !== '' && u.port !== '443') continue;
		return u.href;
	}
	return null;
}

/** Blocks missed since the baseline sample: the latest sample at least 24 h
 *  old, or — when this instance has watched for less — the oldest one. */
export function missedRecently(
	samples: { readonly atOrBefore24h: MissedSample | null; readonly oldest: MissedSample | null },
	currentTotal: number,
	nowMs: number
): { readonly missed: number; readonly windowHours: number } | null {
	const base = samples.atOrBefore24h ?? samples.oldest;
	if (base === null) return null;
	const windowMs = nowMs - base.sampledAtMs;
	if (!(windowMs >= MISSED_MIN_WINDOW_MS)) return null;
	return {
		missed: Math.max(0, currentTotal - base.totalMissed),
		windowHours: Math.round(windowMs / 3_600_000)
	};
}

/** Votes (VESTS × 10⁶, as the chain reports them) → BLURT Power. */
export function votesToBp(votes: string | number, chain: RankingChainState): number {
	const vests = Number(votes) / 1e6;
	const fund = parseFloat(chain.total_vesting_fund_blurt);
	const shares = parseFloat(chain.total_vesting_shares);
	if (!Number.isFinite(vests) || !(fund > 0) || !(shares > 0)) return 0;
	return (vests * fund) / shares;
}

/** Rank, score and order the witnesses. `raw` must be in vote order (as
 *  get_witnesses_by_vote returns it). Producing witnesses come first, by score
 *  (then longest producing, then rank); the rest follow by rank. */
export function rankWitnesses(
	raw: readonly RawWitness[],
	chain: RankingChainState,
	samples: ReadonlyMap<
		string,
		{ readonly atOrBefore24h: MissedSample | null; readonly oldest: MissedSample | null }
	>,
	nowMs: number
): { readonly witnesses: readonly RankedWitness[]; readonly newestVersion: string | null } {
	const head = chain.head_block_number;
	const producingOf = (w: RawWitness): boolean => isProducingWitness(w, head);

	const newest = newestVersionOf(raw.filter(producingOf));

	const bps = raw.map((w) => votesToBp(w.votes, chain));
	const out: RankedWitness[] = raw.map((w, i) => {
		const createdMs = chainTimeMs(w.created);
		const weeks = Number.isFinite(createdMs)
			? Math.max(0, Math.floor((nowMs - createdMs) / WEEK_MS))
			: 0;
		const v = parseVersion(w.running_version);
		const versionBehind =
			newest !== null &&
			v !== null &&
			(v[0] < newest[0] || (v[0] === newest[0] && v[1] < newest[1]));
		const producing = producingOf(w);
		const totalMissed = Number.isFinite(w.total_missed) ? Math.max(0, w.total_missed) : 0;
		const score = witnessScore({ weeks, totalMissed, producing, versionBehind });
		const recent = producing
			? missedRecently(
					samples.get(w.owner) ?? { atOrBefore24h: null, oldest: null },
					totalMissed,
					nowMs
				)
			: null;
		return {
			owner: w.owner,
			rank: i + 1,
			url: safeWitnessUrl(w.url),
			created: typeof w.created === 'string' ? w.created : '',
			weeks,
			total_missed: totalMissed,
			missed_recent: recent?.missed ?? null,
			missed_window_hours: recent?.windowHours ?? null,
			version: typeof w.running_version === 'string' ? w.running_version : '',
			version_behind: versionBehind,
			votes_bp: bps[i]!,
			needs_bp: i === 0 ? null : Math.max(0, bps[i - 1]! - bps[i]!),
			producing,
			disabled: isDisabledSigningKey(w.signing_key),
			score,
			stars: starsFromScore(score)
		};
	});

	out.sort((a, b) => {
		if (a.producing !== b.producing) return a.producing ? -1 : 1;
		if (!a.producing) return a.rank - b.rank;
		return b.score - a.score || b.weeks - a.weeks || a.rank - b.rank;
	});
	return {
		witnesses: out,
		newestVersion: newest === null ? null : `${newest[0]}.${newest[1]}.${newest[2]}`
	};
}
