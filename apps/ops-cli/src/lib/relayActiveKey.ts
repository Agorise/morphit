/**
 * The relay's own check of its key against the chain, as `health` and `status`
 * show it.
 *
 * The relay compares the key it unlocked with the keys the chain lists for its
 * account (apps/relay/src/policy/activeKeyGuard.ts) and reports the result in
 * the `active_key` block of its /v1/health, for local callers only:
 *   ok        — the key is one of the account's active (or owner) keys;
 *   mismatch  — it is not: the relay signs NOTHING (signups are refused,
 *               queued payouts wait) until it is fixed. Why, when the relay
 *               says so: `found_as` (posting / memo, or
 *               active_below_threshold with `weight` and `threshold`),
 *               `no_account` (the account does not exist on the chain) or
 *               `bad_key` (the key file holds no valid private key);
 *   unknown   — the chain could not be asked, or the nodes did not agree: the
 *               relay goes on signing and asks again shortly;
 *   unchecked — the first check has not finished yet.
 * Only `mismatch` is a problem. The others are not errors and are never said
 * as one. `account` names the relay's account (public data).
 *
 * Each kind of mismatch has its own fix (review, 2026-10-29): "the account
 * does not exist" was answered with "run edit-active-key", which cannot set
 * the account name — the fix is the account name in the relay's env files.
 */
export type RelayActiveKeyState = 'ok' | 'mismatch' | 'unknown' | 'unchecked';

export interface RelayActiveKey {
	readonly state: RelayActiveKeyState;
	/** What the chain says the key is instead, when the relay said so. */
	readonly foundAs: 'posting' | 'memo' | null;
	/** The key is listed on the active authority, but below its threshold. */
	readonly belowThreshold: { readonly weight: number; readonly threshold: number } | null;
	/** The relay's account does not exist on the chain. */
	readonly noAccount: boolean;
	/** The relay's key file does not hold a valid private key. */
	readonly badKey: boolean;
	/** The relay's account, when the relay said (older relays do not). */
	readonly account: string | null;
}

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** The `active_key` block of a relay /v1/health body; null when the body has
 *  none (an older relay, or the answer was not for a local caller). PURE. */
export function parseRelayActiveKey(body: unknown): RelayActiveKey | null {
	if (body === null || typeof body !== 'object') return null;
	const ak = (body as { active_key?: unknown }).active_key;
	if (ak === null || typeof ak !== 'object') return null;
	const o = ak as {
		state?: unknown;
		found_as?: unknown;
		weight?: unknown;
		threshold?: unknown;
		no_account?: unknown;
		bad_key?: unknown;
		account?: unknown;
	};
	const s = o.state;
	if (s !== 'ok' && s !== 'mismatch' && s !== 'unknown' && s !== 'unchecked') return null;
	const weight = Number(o.weight);
	const threshold = Number(o.threshold);
	return {
		state: s,
		foundAs: o.found_as === 'posting' || o.found_as === 'memo' ? o.found_as : null,
		belowThreshold:
			o.found_as === 'active_below_threshold' &&
			Number.isFinite(weight) &&
			Number.isFinite(threshold)
				? { weight, threshold }
				: null,
		noAccount: o.no_account === true,
		badKey: o.bad_key === true,
		account: typeof o.account === 'string' && ACCOUNT_RE.test(o.account) ? o.account : null
	};
}

/** The problem, in plain words (the generic case: the key is not the account's
 *  active key). For a specific one use {@link relayKeyMismatch}. */
export const RELAY_KEY_MISMATCH =
	"the relay's key file is not the account's active key on the chain: signups and payouts are paused";

/** The problem, in plain words, for this mismatch. */
export function relayKeyMismatch(k: RelayActiveKey): string {
	const acct = k.account !== null ? `@${k.account}` : "the relay's account";
	if (k.noAccount)
		return `the relay's account ${k.account !== null ? `${acct} ` : ''}does not exist on the Blurt chain: signups and payouts are paused`;
	if (k.badKey)
		return "the relay's key file does not hold a valid Blurt private key: signups and payouts are paused";
	if (k.belowThreshold !== null)
		return `the relay's key cannot sign alone for ${acct} (its weight is below the threshold): signups and payouts are paused`;
	return RELAY_KEY_MISMATCH;
}

/** What the chain says the key is instead, when the relay said so; else null. */
export function relayKeyFoundAs(k: RelayActiveKey): string | null {
	if (k.foundAs === 'posting')
		return "The key file holds the account's posting key, which cannot sign payouts.";
	if (k.foundAs === 'memo') return "The key file holds the account's memo key, which cannot sign.";
	if (k.belowThreshold !== null)
		return (
			`The key file holds a key listed on the account's active authority with weight ${k.belowThreshold.weight}, ` +
			`below the threshold ${k.belowThreshold.threshold}, so it cannot sign alone.`
		);
	if (k.noAccount)
		return (
			`The relay is set to sign as ${k.account !== null ? `@${k.account}` : 'an account'}, and two Blurt RPC operators agree ` +
			'that no such account exists — usually a typo in the account name.'
		);
	return null;
}

/** The fix, as exact commands on this server, in order (the generic case). */
export const RELAY_KEY_FIX: readonly string[] = [
	'To fix it, on this server:',
	"  1. sudo morphit-ops show-key            (shows which key the relay's file holds)",
	"  2. sudo morphit-ops edit-active-key     (paste the relay account's ACTIVE private key)",
	'  3. sudo systemctl restart morphit-relay (the relay reads the new key when it starts)'
];

/** The fix for this mismatch, as exact commands on this server, in order. */
export function relayKeyFix(k: RelayActiveKey): readonly string[] {
	if (k.noAccount)
		return [
			'To fix it, on this server:',
			'  1. sudo nano /etc/morphit/relay.env and /opt/morphit/morphit.env',
			'     (the line MORPHIT_RELAY_ACCOUNT=… must name the relay account as it is on the chain)',
			'  2. sudo systemctl restart morphit-relay (the relay reads the name when it starts)'
		];
	if (k.badKey)
		return [
			'To fix it, on this server:',
			"  1. sudo morphit-ops edit-active-key     (paste the relay account's ACTIVE private key)",
			'  2. sudo systemctl restart morphit-relay (the relay reads the new key when it starts)'
		];
	if (k.belowThreshold !== null)
		return [
			'To fix it, on this server:',
			'  1. sudo morphit-ops edit-active-key     (paste an ACTIVE private key of the account that can sign alone)',
			'  2. sudo systemctl restart morphit-relay (the relay reads the new key when it starts)',
			`  Or, in your Blurt wallet, give this key weight ${k.belowThreshold.threshold} on the account's active authority.`
		];
	return RELAY_KEY_FIX;
}

/** What asking the relay gave. */
export type RelayKeyReading =
	| { readonly reached: false }
	| { readonly reached: true; readonly key: RelayActiveKey | null };

/**
 * Ask the relay for its key check: each address in turn, within `budgetMs` in
 * all. Never throws. `reached: false` when no address gave a relay answer.
 */
export async function readRelayActiveKey(
	urls: readonly string[],
	budgetMs = 4_000
): Promise<RelayKeyReading> {
	const until = Date.now() + budgetMs;
	for (const url of urls) {
		const left = until - Date.now();
		if (left <= 0) break;
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), left);
		try {
			const res = await fetch(url, {
				method: 'GET',
				signal: ctrl.signal,
				redirect: 'manual',
				headers: { accept: 'application/json', 'x-morphit-local-health': '1' }
			});
			if (!res.ok) continue;
			const body = (await res.json()) as unknown;
			// The relay's health always carries rpc_ok; anything else is not it.
			if (body === null || typeof body !== 'object' || !('rpc_ok' in body)) continue;
			return { reached: true, key: parseRelayActiveKey(body) };
		} catch {
			// Not answering at this address: try the next.
		} finally {
			clearTimeout(t);
		}
	}
	return { reached: false };
}
