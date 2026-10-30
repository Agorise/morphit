/**
 * The release hashes @morphit published on chain, read so that no RPC node
 * and no local service decides them.
 *
 * `morphit-ops upgrade` used to take the expected SHA-256 from whoever served
 * it: the Forgejo primary's `.sha256` on the clearnet path, and the local
 * indexer's `/v1/release` on the hidden and offline paths. Neither is an
 * anchor: a primary that is taken over serves its own hash, and `/v1/release`
 * repeats whatever the indexer stored from one RPC node.
 *
 * This reads the `morphit_release_v1` op for one version the way
 * apps/indexer/src/blurt/snapshotOpTrust.ts reads snapshot ops:
 *   1. find the op for that version in @morphit's account history;
 *   2. fetch the block that holds it and find the transaction by its
 *      RECOMPUTED id, so a node cannot pair a real id with altered content;
 *   3. require that the transaction's signature recovers to the PINNED
 *      posting key. That is the check no node can fake without the key.
 * The hashes returned come from the transaction in the block, never from the
 * history answer.
 *
 * `read` is the only way out of this module. ops-cli passes chainRead
 * (lib/chainAccess.ts): this node's own indexer first, and on a hidden-only
 * node nothing else. Because of step 3, which node answered does not matter
 * for authenticity; a node that withholds the op only makes the anchor
 * unavailable, and the caller then needs a signed tarball instead.
 *
 * v1.21.18 — WHAT WAS WRONG on a hidden-only node (morphitlat, v1.21.16). Step
 * 1 asked for the newest 1000 positions of @morphit's history in ONE read.
 * Over Tor/I2P, through the node's own indexer: the chain head (995 bytes)
 * took 7.9 s, the newest 10 positions (23,646 bytes) 33.7 s, and the newest
 * 100 or 1000 never came within 240 s. (Each @morphit op is large — a release
 * op is 3-4 KB — and every op it broadcasts also takes a second position, the
 * chain's fee for it, which the condenser API leaves out of the answer.) The
 * read could never arrive, so every upgrade of a hidden-only node stopped with
 * "@morphit's signed record could not be read".
 *
 * NOW, two cheaper ways to the same op, each checked exactly as before:
 *   - a HINT: this node's indexer already applied the release op, and its
 *     `/v1/release` names the block and transaction it came from. That one
 *     block (about 5 KB) is read and checked like any history entry — the hint
 *     only says where to look, never what is true;
 *   - the history in SMALL PAGES (`pageSize`), newest first, walking back page
 *     by page until the record is found or `maxPages` pages are read. A
 *     candidate that fails its check (a forgery, a block a node does not have
 *     yet) no longer ends the walk: older pages are still read, and the fault
 *     decides only when nothing verifies.
 */
import { cryptoUtils, Signature } from '@beblurt/dblurt';

export const RELEASE_OP_ID = 'morphit_release_v1';

/** One read-only condenser call. */
export type CondenserRead = (method: string, params: readonly unknown[]) => Promise<unknown>;

/**
 * How a read that goes over Tor/I2P (this node's indexer on a hidden-only node)
 * walks the history, from the morphitlat measurement above:
 *   - 10 positions per page: about 6 ops, 21-24 KB, which came in 33.7 s (20
 *     positions are about 41 KB, nearly twice that, and the indexer gives
 *     each Tor/I2P node 25 s for a read relayed for someone waiting on it);
 *   - 120 s per read: one slow node the indexer gives up on, then the next
 *     node's full answer;
 *   - 10 pages (110 positions, about 55 ops of @morphit's): its whole history
 *     (356 positions, April to October 2026) holds 31 ops that are not release
 *     records, of 13 kinds — community, transfer, morphit_rpc_v1,
 *     account_update, indexer_snapshot_v1, account_create, notify,
 *     transfer_to_vesting, referral, comment, comment_options, vote,
 *     chain_snapshot_v1 — and never more than one between two releases. So
 *     the newest record is found even after more ops since a release than
 *     @morphit has ever made in all.
 * A clearnet read keeps 1000 positions and 4 pages: one such read holds the
 * whole history today (182 entries, 510 KB on 29 October 2026), and small pages
 * would multiply the requests by every source it asks (this node's indexer and
 * each configured node).
 */
export const RECORD_PAGE_SIZE_HIDDEN = 10;
export const RECORD_MAX_PAGES_HIDDEN = 10;
export const RECORD_READ_TIMEOUT_HIDDEN_MS = 120_000;

/** Where this node's indexer says the current release op is. */
export interface ReleaseRecordHint {
	readonly blockNum: number;
	readonly trxId: string;
}

/**
 * The hint in a `/v1/release` answer (`source_block_num`, `source_trx_id`), when
 * it is about `tag` and well formed; otherwise null. PURE. A hint is only a
 * place to look: the op found there passes the same checks as one listed in the
 * history, so a wrong hint only costs one block read.
 */
export function releaseRecordHint(release: unknown, tag: string): ReleaseRecordHint | null {
	if (!release || typeof release !== 'object') return null;
	const r = release as { version?: unknown; source_block_num?: unknown; source_trx_id?: unknown };
	if (typeof r.version !== 'string' || bare(r.version) !== bare(tag)) return null;
	const blockNum = r.source_block_num;
	const trx = typeof r.source_trx_id === 'string' ? r.source_trx_id.toLowerCase() : '';
	if (typeof blockNum !== 'number' || !Number.isSafeInteger(blockNum) || blockNum <= 0) return null;
	if (!TRX_ID_RE.test(trx) || /^0+$/.test(trx)) return null;
	return { blockNum, trxId: trx };
}

export interface ReleaseAnchor {
	/** Version as published, without a leading "v". */
	readonly version: string;
	/** SHA-256 of the slim release tarball `morphit-vX.Y.Z.tar.gz`. */
	readonly sourceSha256: string;
	/** SHA-256 of the self-contained `morphit-vX.Y.Z-offline.tar.gz`, if published. */
	readonly offlineSha256: string | null;
	readonly ipfsCid: string | null;
	readonly ipnsName: string | null;
	readonly gpgFingerprint: string | null;
	readonly blockNum: number;
	readonly trxId: string;
}

export type ReleaseAnchorResult =
	| { readonly ok: true; readonly anchor: ReleaseAnchor }
	| {
			readonly ok: false;
			readonly reason: string;
			/** A source ANSWERED and its history did not list the record, or
			 *  listed it while its block was not there yet (as opposed to no
			 *  source being readable at all): what a record not yet in a node's
			 *  history, or a node behind the chain, looks like. */
			readonly notListed?: boolean;
			/** v1.21.6: no source could be read at all (no answer, or an error
			 *  instead of a history) — as opposed to an answer without the
			 *  record. Over Tor/I2P that is often only a slow moment. */
			readonly unreadable?: boolean;
			/** v1.21.6 review: some answer named a record that failed its check
			 *  (signed by another key, or no valid hash) — a fault, never "only a
			 *  wait", even when another round had no answer. Set only by
			 *  {@link findSignedReleaseAnchor}. */
			readonly invalid?: boolean;
	  };

interface TxLike {
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: ReadonlyArray<readonly [string, Record<string, unknown>]>;
	readonly extensions?: readonly unknown[];
	readonly signatures?: readonly string[];
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,110})$/;
const IPNS_RE = /^k51[a-z0-9]{50,70}$/;
const FPR_RE = /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/;
const TRX_ID_RE = /^[0-9a-f]{40}$/;

const bare = (v: string): string => v.trim().replace(/^v/, '');

/** The id the chain gives this transaction, recomputed from its content. */
export function transactionIdOf(tx: unknown): string | null {
	try {
		const t = tx as TxLike;
		return cryptoUtils.generateTrxId({
			ref_block_num: t.ref_block_num,
			ref_block_prefix: t.ref_block_prefix,
			expiration: t.expiration,
			operations: t.operations,
			extensions: t.extensions ?? []
		} as never);
	} catch {
		return null;
	}
}

/** Every public key the transaction's signatures recover to. */
export function recoverSigningKeys(tx: unknown, chainIdHex: string): string[] {
	const t = tx as TxLike;
	if (!t || !Array.isArray(t.signatures)) return [];
	let digest: Buffer;
	try {
		digest = cryptoUtils.transactionDigest(
			{
				ref_block_num: t.ref_block_num,
				ref_block_prefix: t.ref_block_prefix,
				expiration: t.expiration,
				operations: t.operations,
				extensions: t.extensions ?? []
			} as never,
			Buffer.from(chainIdHex, 'hex')
		);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const s of t.signatures.slice(0, 8)) {
		try {
			out.push(Signature.fromString(s).recover(digest).toString());
		} catch {
			/* a malformed signature proves nothing */
		}
	}
	return out;
}

/** The release payload in a custom_json op body, when it is a release op
 *  authorised by `signer` for `version`; otherwise null. */
function releasePayloadOf(
	op: unknown,
	signer: string,
	version: string
): Record<string, unknown> | null {
	if (!Array.isArray(op) || op[0] !== 'custom_json') return null;
	const c = op[1] as Record<string, unknown> | undefined;
	if (!c || c.id !== RELEASE_OP_ID || typeof c.json !== 'string') return null;
	const auths = Array.isArray(c.required_posting_auths) ? c.required_posting_auths : [];
	if (!auths.some((a) => typeof a === 'string' && a.toLowerCase() === signer)) return null;
	let p: unknown;
	try {
		p = JSON.parse(c.json);
	} catch {
		return null;
	}
	if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
	const v = (p as { version?: unknown }).version;
	if (typeof v !== 'string' || bare(v) !== version) return null;
	return p as Record<string, unknown>;
}

interface Candidate {
	readonly blockNum: number;
	readonly trxId: string;
	readonly seq: number;
}

/** Release-op candidates for `version` in one history page, newest first. */
export function releaseCandidates(history: unknown, signer: string, version: string): Candidate[] {
	if (!Array.isArray(history)) return [];
	const out: Candidate[] = [];
	for (const entry of history) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const seq = Number(entry[0]);
		const h = entry[1] as { block?: unknown; trx_id?: unknown; op?: unknown } | undefined;
		if (!h) continue;
		const blockNum = Number(h.block);
		const trxId = typeof h.trx_id === 'string' ? h.trx_id : '';
		if (
			!Number.isInteger(blockNum) ||
			blockNum <= 0 ||
			!TRX_ID_RE.test(trxId) ||
			/^0+$/.test(trxId)
		)
			continue;
		if (releasePayloadOf(h.op, signer, version) === null) continue;
		out.push({ blockNum, trxId, seq: Number.isFinite(seq) ? seq : -1 });
	}
	return out.sort((a, b) => b.seq - a.seq);
}

/** Lowest sequence number in a history page, or null. */
function lowestSeq(history: unknown): number | null {
	if (!Array.isArray(history)) return null;
	let low: number | null = null;
	for (const e of history) {
		if (!Array.isArray(e)) continue;
		const s = Number(e[0]);
		if (Number.isInteger(s) && (low === null || s < low)) low = s;
	}
	return low;
}

/** Highest sequence number in a history page, or null. */
function highestSeq(history: unknown): number | null {
	if (!Array.isArray(history)) return null;
	let high: number | null = null;
	for (const e of history) {
		if (!Array.isArray(e)) continue;
		const s = Number(e[0]);
		if (Number.isInteger(s) && (high === null || s > high)) high = s;
	}
	return high;
}

/** Turn a verified payload into an anchor; null when its hashes are malformed. */
function anchorFrom(
	payload: Record<string, unknown>,
	version: string,
	c: Candidate
): ReleaseAnchor | null {
	const d = payload.distribution as Record<string, unknown> | null | undefined;
	if (!d || typeof d !== 'object') return null;
	const src = typeof d.source_sha256 === 'string' ? d.source_sha256 : '';
	if (!SHA256_RE.test(src)) return null;
	const off =
		typeof d.offline_sha256 === 'string' && SHA256_RE.test(d.offline_sha256)
			? d.offline_sha256
			: null;
	const cid = typeof d.ipfs_cid === 'string' && CID_RE.test(d.ipfs_cid) ? d.ipfs_cid : null;
	const ipns = typeof d.ipns_name === 'string' && IPNS_RE.test(d.ipns_name) ? d.ipns_name : null;
	const fpr =
		typeof d.gpg_fingerprint === 'string' && FPR_RE.test(d.gpg_fingerprint)
			? d.gpg_fingerprint.toUpperCase()
			: null;
	return {
		version,
		sourceSha256: src,
		offlineSha256: off,
		ipfsCid: cid,
		ipnsName: ipns,
		gpgFingerprint: fpr,
		blockNum: c.blockNum,
		trxId: c.trxId
	};
}

/**
 * The verified on-chain release record for `tag`, or why there is none.
 * Never throws: a read that fails is a reason, not an exception.
 */
export async function readSignedReleaseAnchor(
	read: CondenserRead,
	args: {
		readonly tag: string;
		readonly signer: string;
		readonly pinnedPubkey: string;
		readonly chainId: string;
		/** History positions per page (Blurt allows up to 1000 here). */
		readonly pageSize?: number;
		/** How many pages back to look before giving up. */
		readonly maxPages?: number;
		/** Where this node's indexer says the op is (see releaseRecordHint):
		 *  that block is checked first, before any history is read. */
		readonly hint?: ReleaseRecordHint | null;
	}
): Promise<ReleaseAnchorResult> {
	const version = bare(args.tag);
	const signer = args.signer.toLowerCase();
	const pageSize = Math.max(1, Math.min(1000, args.pageSize ?? 1000));
	const maxPages = Math.max(1, args.maxPages ?? 4);

	let lastWhy = '';
	// Some answer named a record for this version: a history entry, or the
	// hinted block when it was there to read. Until one does, the record is
	// "not listed" (or, when nothing could be read, "unreadable").
	let listed = false;
	// A listed record whose block the node answering did not have (a node a
	// few blocks behind, or a read that failed) is lag, like a record not
	// listed yet: the callers wait for it. A block that holds something else
	// signed, or nothing valid, is not.
	let lagging = false;
	// A listed record signed by another key: a forgery. It decides, even beside
	// a candidate whose block is missing — a node can list a second record and
	// withhold its block, and a forgery must never read as lag (v1.21.6
	// review). A record @morphit signed that lacks a usable hash is not an
	// attacker's (it needs the key), so it does not override a lagging block.
	// It decides only when NOTHING verifies: a forged entry on a newer page
	// does not stop the walk from reaching the genuine one on an older page.
	let fault: string | null = null;
	/** Candidates already checked in this read (the hint and the history name
	 *  the same op; a node that ignores `from` repeats its page). */
	const checked = new Set<string>();

	/** The anchor in candidate `c`, or null (and why, in the flags above). */
	const check = async (c: Candidate, fromHint: boolean): Promise<ReleaseAnchor | null> => {
		const key = `${c.blockNum}|${c.trxId}`;
		if (checked.has(key)) return null;
		let block: unknown;
		try {
			block = await read('get_block', [c.blockNum]);
		} catch (err) {
			lastWhy = `could not read block ${c.blockNum} (${err instanceof Error ? err.message : String(err)})`;
			// A hint whose block could not be read says nothing yet: the history
			// is read next, and may list the same op (then its block is asked
			// again). A listed record whose block failed is lag, as before.
			if (fromHint) return null;
			checked.add(key);
			lagging = true;
			return null;
		}
		checked.add(key);
		listed = true;
		const txs = (block as { transactions?: unknown } | null)?.transactions;
		const tx = Array.isArray(txs)
			? (txs.find((t) => transactionIdOf(t) === c.trxId) as TxLike | undefined)
			: undefined;
		if (tx === undefined) {
			lastWhy = `block ${c.blockNum} does not hold transaction ${c.trxId}`;
			lagging = true;
			return null;
		}
		if (!recoverSigningKeys(tx, args.chainId).includes(args.pinnedPubkey)) {
			lastWhy = `the release record in block ${c.blockNum} is not signed by @${signer}'s pinned posting key`;
			fault = lastWhy;
			return null;
		}
		let payload: Record<string, unknown> | null = null;
		for (const op of [...(tx.operations ?? [])].reverse()) {
			payload = releasePayloadOf(op, signer, version);
			if (payload !== null) break;
		}
		if (payload === null) {
			lastWhy = `the signed transaction in block ${c.blockNum} carries no release record for v${version}`;
			return null;
		}
		const anchor = anchorFrom(payload, version, c);
		if (anchor === null) {
			lastWhy = `the signed release record for v${version} has no valid source_sha256`;
			return null;
		}
		return anchor;
	};

	// 1. The hinted block: one small read instead of any history.
	const hint = args.hint ?? null;
	if (hint !== null && Number.isSafeInteger(hint.blockNum) && hint.blockNum > 0) {
		const trxId = hint.trxId.toLowerCase();
		if (TRX_ID_RE.test(trxId)) {
			const a = await check({ blockNum: hint.blockNum, trxId, seq: -1 }, true);
			if (a !== null) return { ok: true, anchor: a };
		}
	}

	// 2. The history, newest page first, each page's records checked before
	//    the next page is read.
	let from = -1;
	let readError: string | null = null;
	let reachedStart = false;
	// The history positions read: from the newest (`top`) down to `bottom`.
	// A page [from, limit] covers positions from-limit .. from.
	let top: number | null = null;
	let bottom: number | null = null;
	for (let page = 0; page < maxPages; page++) {
		const limit = from === -1 ? pageSize : Math.min(pageSize, from);
		let history: unknown;
		try {
			history = await read('get_account_history', [signer, from, limit]);
		} catch (err) {
			readError = err instanceof Error ? err.message : String(err);
			break;
		}
		for (const c of releaseCandidates(history, signer, version)) {
			listed = true;
			const a = await check(c, false);
			if (a !== null) return { ok: true, anchor: a };
		}
		const low = lowestSeq(history);
		// No entries (an empty history), the first position read, or an answer
		// that did not move back past `from` (a node that ignores it): stop.
		if (low === null || low <= 0 || (from !== -1 && low > from)) {
			reachedStart = low === null || low <= 0;
			break;
		}
		if (from === -1) top = highestSeq(history);
		bottom = Math.max(0, (from === -1 ? (top ?? low) : from) - limit);
		from = low - 1;
	}
	const depth = top !== null && bottom !== null ? top - bottom + 1 : null;
	if (!listed) {
		if (readError !== null) {
			return {
				ok: false,
				reason: `could not read @${signer}'s history (${readError})`,
				unreadable: true
			};
		}
		return {
			ok: false,
			reason:
				reachedStart || depth === null
					? `@${signer} has published no release record for v${version}`
					: `@${signer} has published no release record for v${version} in the newest ${depth} entries of its history`,
			notListed: true
		};
	}
	if (fault !== null) return { ok: false, reason: fault };
	return lagging ? { ok: false, reason: lastWhy, notListed: true } : { ok: false, reason: lastWhy };
}

/** Where and how long `findSignedReleaseAnchor` looks. */
export interface AnchorSearch {
	/** Readers asked in order, every round. The record is authenticated by its
	 *  signature, so a source only decides whether it is FOUND, never what it
	 *  says: one that lacks it or forges it just passes the turn to the next. */
	readonly sources: readonly CondenserRead[];
	/** How long to keep asking when no source holds the record yet (0: one
	 *  round). A record broadcast a minute ago may not be in a node's history
	 *  yet, and a node behind the chain answers without it. */
	readonly waitMs?: number;
	/** Pause between rounds. */
	readonly intervalMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	/** v1.21.6: told after every round that found nothing and will be followed
	 *  by another (the round just finished, and why it found nothing), so a
	 *  caller can say it is still asking. */
	readonly onRetry?: (round: number, reason: string) => void;
}

/**
 * The verified on-chain release record for `tag` from the first source that
 * holds it, asking every source each round until `waitMs` has passed. One
 * answer without the record proves nothing (morphit.io, 2026-10-08: the
 * v1.21.3 upgrade refused on one node's history). Never throws.
 */
export async function findSignedReleaseAnchor(
	search: AnchorSearch,
	args: Parameters<typeof readSignedReleaseAnchor>[1]
): Promise<ReleaseAnchorResult> {
	// A steady clock: a Tor time sync may step the wall clock while it waits.
	const now = search.now ?? (() => performance.now());
	const sleep = search.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const interval = Math.max(1, search.intervalMs ?? 10_000);
	const until = now() + Math.max(0, search.waitMs ?? 0);
	const started = now();
	const reasons = new Set<string>();
	let notListed = false;
	let unreadable = false;
	let invalid = false;
	let rounds = 0;
	for (;;) {
		rounds++;
		for (const read of search.sources) {
			// The first round asks every source; a later one starts none past the
			// deadline, so slow sources cannot stretch the promised wait.
			if (rounds > 1 && now() >= until) break;
			const r = await readSignedReleaseAnchor(read, args);
			if (r.ok) return r;
			reasons.add('reason' in r ? r.reason : 'unknown');
			const lag = 'notListed' in r && r.notListed === true;
			if (lag) notListed = true;
			const silent = 'unreadable' in r && r.unreadable === true;
			if (silent) unreadable = true;
			if (!lag && !silent) invalid = true;
		}
		if (now() + interval > until) break;
		search.onRetry?.(rounds, [...reasons].pop() ?? 'unknown');
		await sleep(interval);
	}
	const asked = `${search.sources.length} source${search.sources.length === 1 ? '' : 's'}`;
	const span = Math.round((now() - started) / 1000);
	const when = rounds > 1 ? `, asked ${rounds} times over ${span} s` : '';
	const head = reasons.size > 0 ? [...reasons].join('; ') : 'no source answered';
	return { ok: false, reason: `${head} (${asked}${when})`, notListed, unreadable, invalid };
}
