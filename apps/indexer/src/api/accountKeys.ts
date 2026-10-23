/**
 * Morphit indexer — /v1/account/:account/keys endpoint. Anchor.
 *
 *   GET /v1/account/:account/keys
 *     → { account: { name, owner, active, posting, memo_key } }
 *     404 if the account does not exist on chain.
 *     502 (code "internal") if the chain RPC could not be reached, or two
 *     RPC operators did not (yet) agree on the account (S-M9).
 *
 * WHY THIS ENDPOINT EXISTS — PRIVACY (priority #1). Login / key import
 * (onboarding/import) and the settings account-name verifier used to
 * call Blurt `get_accounts` DIRECTLY from the browser to confirm that
 * the key the user holds matches the account's on-chain authority. That
 * leaks a deanonymizing fact — "IP X is logging into / verifying account
 * Y" — to third-party RPC operators Morphit does not control. Routing
 * the lookup through the operator's own indexer (server-side, across the
 * full pool) means only the operator the user already trusts learns
 * which account is being checked, and the browser opens no cross-origin
 * RPC connection.
 *
 * PUBLIC KEYS ONLY. This returns the account's PUBLIC authority blocks
 * (owner / active / posting key_auths + the memo PUBLIC key) — exactly
 * the public chain data `verifyPostingKey` reads. No secret ever touches
 * the server: the WIF the user enters never leaves the browser, the
 * private→public derivation runs client-side, and the comparison against
 * these public authorities runs client-side. The indexer is purely a
 * privacy-preserving relay of public data.
 *
 * The answer names the account, so it is never stored (`no-store` from
 * the security middleware, VT3-6).
 */

import { Hono } from 'hono';

import type { BlurtClient, ChainAccount } from '$blurt/client';
import { primaryPostingKey } from '$indexer/postingKeyBackfill';
import { errorBody, isAccountName } from '$api/shared';


interface AccountKeysBody {
	readonly account: {
		readonly name: string;
		readonly owner: unknown;
		readonly active: unknown;
		readonly posting: unknown;
		readonly memo_key: string;
	};
}

/** A well-formed Blurt authority block has a key_auths array. Defensive
 *  against a misbehaving node returning a malformed authority. */
function isAuthority(v: unknown): boolean {
	return typeof v === 'object' && v !== null && Array.isArray((v as { key_auths?: unknown }).key_auths);
}

/** What two operators must agree on: every authority (threshold, keys and
 *  account authorities, order-independent) and the memo key. An account the
 *  chain does not have is agreed on too, as "none". */
function authoritiesKey(acc: ChainAccount | undefined): string {
	if (acc === undefined) return '∅ no such account';
	const auth = (a: unknown): unknown => {
		const x = (a ?? {}) as { weight_threshold?: unknown; key_auths?: unknown; account_auths?: unknown };
		const pairs = (v: unknown): string[] =>
			Array.isArray(v) ? v.map((p) => JSON.stringify(p)).sort() : [];
		return [x.weight_threshold ?? null, pairs(x.key_auths), pairs(x.account_auths)];
	};
	return JSON.stringify([auth(acc.owner), auth(acc.active), auth(acc.posting), acc.memo_key ?? null]);
}

export function accountKeysRoute(
	blurt: BlurtClient,
	opts: {
		/** Told the account's signing posting key once operators agreed on it
		 *  (main.ts: the fast path's key cache, notePostingKeyFromQuorum). */
		onAgreedPostingKey?: (account: string, key: string) => void;
	} = {}
): Hono {
	const app = new Hono();

	app.get('/:account/keys', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		// TWO OPERATORS MUST AGREE (v1.21.14 full chat audit, S-M9). This answer
		// is what a browser ENCRYPTS TO: a first message to someone whose chat
		// key is not pinned yet goes to the posting key named here. It used to be
		// one hedged answer — the fastest node's — so a single hostile pool node
		// could name its own key and read that message. Now it is the quorum
		// read the fast path already uses for keys: two operators agreeing on
		// every authority and the memo key, a majority of those that answered.
		let agreed: ReadonlyMap<string, ChainAccount> | null;
		try {
			agreed = await blurt.getAccountsAgreed([account], authoritiesKey);
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}
		if (agreed === null) {
			return c.json(errorBody('internal', 'Blurt RPC operators did not agree on this account yet'), 502);
		}
		const acct = agreed.get(account) ?? null;

		if (acct === null) {
			return c.json(errorBody('not_found', 'no such account on chain'), 404);
		}

		// Defensive: a node could return an account missing its authority
		// blocks. Treat that as an upstream failure rather than emitting a
		// body the client-side verifier would choke on.
		if (!isAuthority(acct.owner) || !isAuthority(acct.active) || !isAuthority(acct.posting) || typeof acct.memo_key !== 'string') {
			return c.json(errorBody('internal', 'incomplete account data from the Blurt network'), 502);
		}

		const posting = primaryPostingKey(acct as never);
		if (posting !== null) opts.onAgreedPostingKey?.(acct.name, posting);

		const body: AccountKeysBody = {
			account: {
				name: acct.name,
				owner: acct.owner,
				active: acct.active,
				posting: acct.posting,
				memo_key: acct.memo_key
			}
		};

		return c.json(body);
	});

	return app;
}
