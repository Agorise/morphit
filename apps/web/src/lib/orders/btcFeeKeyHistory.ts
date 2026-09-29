/**
 * v1.20.0 (MK-H2, V3-10) — every treasury BTC key (`treasury.btc.xpub`) the
 * release account has EVER pinned on chain.
 *
 * After a key rotation, an order posted under the previous key keeps its fee
 * address from THAT key (the indexer numbers it under the pin in force at its
 * block). The browser shows such an address only if it can derive it itself
 * from a key @morphit really pinned. The latest release (the release store)
 * only has the new key, so this walks @morphit's account history on chain —
 * the same direct chain read, and the same validator, as
 * $net/releaseFetch.fetchVerifiedRelease — for older release ops. Called only
 * when an order's key is not the current one, so normally never.
 */
import { parseAccountXpub, validateReleasePayload } from '@morphit/release-schema';

/** One condenser_api.get_account_history entry. */
type HistoryEntry = [number, { block?: number; op?: [string, Record<string, unknown>] }];

/** The canonical xpubs pinned by `account`'s valid release ops. Pure. */
export function btcXpubsFromReleaseHistory(
	history: readonly unknown[],
	account: string
): Set<string> {
	const out = new Set<string>();
	for (const e of history) {
		if (!Array.isArray(e)) continue;
		const op = (e as HistoryEntry)[1]?.op;
		if (!Array.isArray(op) || op[0] !== 'custom_json') continue;
		const body = op[1] ?? {};
		if (body.id !== 'morphit_release_v1') continue;
		const auths = [
			...(Array.isArray(body.required_auths) ? body.required_auths : []),
			...(Array.isArray(body.required_posting_auths) ? body.required_posting_auths : [])
		];
		if (!auths.includes(account) || typeof body.json !== 'string') continue;
		let payload: unknown;
		try {
			payload = JSON.parse(body.json);
		} catch {
			continue;
		}
		const v = validateReleasePayload(payload);
		const x = v.ok ? v.value.treasury?.btc?.xpub : undefined;
		if (typeof x !== 'string') continue;
		const p = parseAccountXpub(x);
		if (p.ok) out.add(p.value.xpub);
	}
	return out;
}

let cached: Promise<Set<string>> | null = null;

/** Keys pinned by @morphit, read once per session straight from the chain.
 *  An empty set when the chain cannot be read (the address then stays
 *  hidden — never shown unchecked). */
export function loadPinnedBtcXpubs(): Promise<Set<string>> {
	if (cached !== null) return cached;
	cached = (async () => {
		try {
			const { fetchReleaseAccountHistory, RELEASE_SIGNER_ACCOUNT } = await import(
				'$net/releaseFetch'
			);
			const history = await fetchReleaseAccountHistory();
			return btcXpubsFromReleaseHistory(
				Array.isArray(history) ? history : [],
				RELEASE_SIGNER_ACCOUNT
			);
		} catch {
			cached = null;
			return new Set<string>();
		}
	})();
	return cached;
}
