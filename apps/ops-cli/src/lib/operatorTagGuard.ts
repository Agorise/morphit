/**
 * operatorTagGuard — catch a doomed re-registration BEFORE broadcasting.
 *
 * The federation tag is IMMUTABLE (operatorRegister.ts: a re-register whose tag
 * differs from the account's original tag is rejected on-chain as
 * `tag_immutable`, silently changing nothing). If an operator's
 * MORPHIT_INSTANCE_OPERATOR_TAG drifts from the tag they first registered under,
 * `morphit-ops register` would otherwise emit an op the chain quietly discards —
 * the operator sees a valid transaction and assumes their display_name / origin
 * / contact updated, but nothing does. That trap left morphitlat's title stale
 * for 10 hours (v1.16.5).
 *
 * We check the account's EXISTING registered tag against the local indexer's
 * /v1/operators (authoritative — it reflects the immutable on-chain tag) and
 * refuse the register up front when they conflict. The check is best-effort: a
 * first-time registration has no row (returns null → proceed), and an
 * unreachable/unsynced indexer also returns null → proceed rather than block on
 * infrastructure. Only a CONFIRMED, different existing tag blocks.
 */
import { localIndexerBases } from './hiddenOnly.ts';

/** True only when the account is already registered under a DIFFERENT tag than
 *  the one about to be broadcast — i.e. the chain would reject as tag_immutable.
 *  null existingTag (first-time, or couldn't verify) is never a conflict. */
export function operatorTagConflict(existingTag: string | null, configTag: string): boolean {
	return existingTag !== null && existingTag !== configTag;
}

interface OperatorsWire {
	readonly operators?: ReadonlyArray<{ readonly account?: string; readonly tag?: string }>;
}

/** Best-effort: the tag `account` is currently registered under, per this
 *  node's own indexer, or null (not registered / indexer unreachable /
 *  malformed). Asks the indexer where it listens (localIndexerBases: the
 *  address in indexer.env, then the standard ones), each in turn, all within
 *  `timeoutMs` in all — a base that does not answer (a bridge address with no
 *  route) cannot stretch the wait. Never throws — callers treat null as
 *  "cannot confirm, proceed". */
export async function fetchRegisteredTag(
	account: string,
	opts: { readonly bases?: readonly string[]; readonly timeoutMs?: number } = {}
): Promise<string | null> {
	const until = Date.now() + (opts.timeoutMs ?? 5000);
	for (const base of opts.bases ?? localIndexerBases()) {
		const left = until - Date.now();
		if (left <= 0) return null;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), left);
		try {
			const res = await fetch(`${base.replace(/\/$/, '')}/v1/operators`, {
				signal: ctrl.signal,
				redirect: 'manual',
				headers: { accept: 'application/json' }
			});
			if (!res.ok) continue; // not the indexer at this address: try the next
			const body = (await res.json()) as OperatorsWire;
			if (!Array.isArray(body?.operators)) continue;
			// The indexer answered: its list is the answer.
			const row = body.operators.find((o) => o.account === account);
			return typeof row?.tag === 'string' && row.tag.length > 0 ? row.tag : null;
		} catch {
			// Not answering here (or not JSON): try the next address.
		} finally {
			clearTimeout(timer);
		}
	}
	return null;
}
