/**
 * Blocks seen at the chain HEAD (v1.21.14 full chat audit, S-L2).
 *
 * WHY. The block list is written only by the durable handler, 45-63 s after
 * the block op. Until then every fast route — the head tailer, the federation
 * intake, local delivery — read a block list that did not have it yet, so a
 * sender blocked a moment ago was still shown live and still notified: the fast
 * path was briefly NOT a subset of durable admission, in exactly the case the
 * user acted on.
 *
 * WHAT. The head tailer hands every head-block `morphit_block_v1` op here.
 * One signed by the blocker's posting key (checked like a chat op's) is
 * remembered IN MEMORY for HEAD_BLOCK_TTL_MS, which covers the durable lag.
 * Only "block" is honoured early: an "unblock" seen at the head clears an
 * earlier head "block" but never overrides the durable list, so the fast path
 * can only ever be stricter than the durable one, never looser.
 *
 * A BLOCKER WHOSE KEY NEEDS THE CHAIN (no row here, or an unconfirmed key):
 * the signature cannot be checked at once — the check starts a background key
 * read. Such a block is PENDING: for HEAD_BLOCK_PENDING_MS the pair is held
 * back like a block (stricter, never looser — the durable path still
 * delivers), and the tailer looks at the op again on its recheck schedule; a
 * verified block is then recorded, an unverifiable one dropped (`final`). A
 * block whose blocker's key IS on file and did not sign it is not held
 * ('unverified'): it is only looked at again, in case the key was rotated.
 * Before, nothing ever looked at it again, so the blocked sender stayed live
 * (independent review of the audit fixes, finding 7).
 */
import type { BlockTransaction } from '$blurt/client';

export const HEAD_BLOCK_TTL_MS = 15 * 60 * 1000;
export const HEAD_BLOCK_MAX = 5_000;
/** How long an unverified head block holds its pair back while its blocker's
 *  key is read (longer than the tailer's recheck schedule). */
export const HEAD_BLOCK_PENDING_MS = 10_000;
/** Head blocks one BLOCKER may hold in each map (v1.21.14 review A, F6). The
 *  maps are first-in-first-out under HEAD_BLOCK_MAX, so one account blocking
 *  thousands of names at the head pushed every other user's fresh block out —
 *  and the sender that user had just blocked was shown live again. Past this
 *  many, a blocker's own oldest head block makes room; the durable list still
 *  has every one of them a minute later. */
export const HEAD_BLOCKS_PER_BLOCKER = 50;

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** blocker\0blocked → when the head block was seen. */
const blocked = new Map<string, number>();
/** blocker\0blocked → when an unverified head block was seen. */
const pending = new Map<string, number>();

const pairKey = (blocker: string, target: string): string => `${blocker}\u0000${target}`;
const blockerOf = (key: string): string => key.slice(0, key.indexOf('\u0000'));

/** Each map's keys per blocker, oldest first (pruned lazily: a key deleted
 *  elsewhere — expired, unblocked — is dropped the next time its list is used). */
const byBlocker = new Map<Map<string, number>, Map<string, string[]>>();

/** Insert `key` (newest) into `map`, keeping each blocker to
 *  HEAD_BLOCKS_PER_BLOCKER entries and the map to HEAD_BLOCK_MAX. */
function insertCapped(map: Map<string, number>, key: string, at: number): void {
	map.delete(key);
	let lists = byBlocker.get(map);
	if (lists === undefined) {
		lists = new Map();
		byBlocker.set(map, lists);
	}
	const blocker = blockerOf(key);
	const list = (lists.get(blocker) ?? []).filter((k) => k !== key && map.has(k));
	while (list.length >= HEAD_BLOCKS_PER_BLOCKER) {
		const oldest = list.shift();
		if (oldest !== undefined) map.delete(oldest);
	}
	list.push(key);
	lists.set(blocker, list);
	map.set(key, at);
	while (map.size > HEAD_BLOCK_MAX) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
	// The lists never outgrow the map by much.
	if (lists.size > HEAD_BLOCK_MAX) {
		for (const [b, l] of lists) {
			const kept = l.filter((k) => map.has(k));
			if (kept.length === 0) lists.delete(b);
			else lists.set(b, kept);
		}
	}
}

/** Has `blocker` blocked `target` in a head block not yet durable? */
export function headBlocked(blocker: string, target: string, now: number = Date.now()): boolean {
	if (headBlockPending(blocker, target, now)) return true;
	const k = pairKey(blocker, target);
	const at = blocked.get(k);
	if (at === undefined) return false;
	if (now - at > HEAD_BLOCK_TTL_MS) {
		blocked.delete(k);
		return false;
	}
	return true;
}

/** Is a head block of `target` by `blocker` still waiting for its signature
 *  to be checked? */
export function headBlockPending(
	blocker: string,
	target: string,
	now: number = Date.now()
): boolean {
	const k = pairKey(blocker, target);
	const at = pending.get(k);
	if (at === undefined) return false;
	if (now - at > HEAD_BLOCK_PENDING_MS) {
		pending.delete(k);
		return false;
	}
	return true;
}

/** Test seam. */
export function _resetHeadBlocksForTest(): void {
	blocked.clear();
	pending.clear();
	byBlocker.clear();
}

/** Did the account's POSTING key sign this transaction? (The tailer's own
 *  check.) true / false, or 'unknown' when the key needs a chain read first. */
export type PostingSignerCheck = (
	trx: BlockTransaction,
	account: string
) => Promise<boolean | 'unknown'>;

/**
 * Look at one head-block op. Records a signed block (or clears an earlier head
 * block on a signed unblock); a block whose signature cannot be checked yet is
 * 'pending' (see the header) unless this is the `final` look; ignores anything
 * else. Never throws.
 */
export async function noteHeadBlockOp(
	trx: BlockTransaction,
	op: readonly [string, unknown],
	signedBySigner: PostingSignerCheck,
	now: number = Date.now(),
	opts: { final?: boolean } = {}
): Promise<'blocked' | 'unblocked' | 'pending' | 'unverified' | null> {
	try {
		const [name, body] = op;
		if (name !== 'custom_json' || typeof body !== 'object' || body === null) return null;
		const b = body as { id?: unknown; json?: unknown; required_posting_auths?: unknown };
		if (b.id !== 'morphit_block_v1' || typeof b.json !== 'string') return null;
		const auths = Array.isArray(b.required_posting_auths) ? b.required_posting_auths : [];
		const blocker = auths.length === 1 && typeof auths[0] === 'string' ? auths[0] : null;
		if (blocker === null) return null;
		let payload: unknown;
		try {
			payload = JSON.parse(b.json);
		} catch {
			return null;
		}
		const p = (typeof payload === 'object' && payload !== null ? payload : {}) as {
			blocked?: unknown;
			action?: unknown;
		};
		if (typeof p.blocked !== 'string' || !ACCOUNT_NAME_RE.test(p.blocked)) return null;
		if (p.blocked === blocker) return null;
		if (p.action !== 'block' && p.action !== 'unblock') return null;
		const k = pairKey(blocker, p.blocked);
		const signed = await signedBySigner(trx, blocker);
		if (signed !== true) {
			if (p.action !== 'block' || opts.final === true) {
				if (p.action === 'block') pending.delete(k);
				return null;
			}
			// A key on file that did not sign it: NOT held back (a lone node could
			// otherwise hold any pair with forged block ops — independent review 2,
			// finding 6); looked at again only in case the key was just rotated.
			if (signed === false) {
				pending.delete(k);
				return 'unverified';
			}
			if (!pending.has(k)) insertCapped(pending, k, now);
			return 'pending';
		}
		pending.delete(k);
		if (p.action === 'unblock') {
			blocked.delete(k);
			return 'unblocked';
		}
		insertCapped(blocked, k, now);
		return 'blocked';
	} catch {
		return null;
	}
}
