/**
 * Morphit indexer — /v1/account/:account/keys endpoint. Anchor cp298.
 *
 *   GET /v1/account/:account/keys
 *     → { account: { name, owner, active, posting, memo_key } }
 *     404 if the account does not exist on chain.
 *     502 (code "internal") if the chain RPC could not be reached.
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
 * Authorities change rarely (key rotations are infrequent), so the
 * response is briefly `public`-cacheable — public chain data, not
 * per-user-private.
 */

import { Hono } from 'hono';

import type { BlurtClient } from '$blurt/client';
import { errorBody, isAccountName } from '$api/shared';

/** Authorities change only on a key rotation (rare). A short public
 *  cache collapses the per-keystroke existence checks the import field
 *  fires while typing, without risking a stale verdict for long. */
const KEYS_CACHE_CONTROL = 'public, max-age=30, stale-while-revalidate=120';

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

export function accountKeysRoute(blurt: BlurtClient): Hono {
	const app = new Hono();

	app.get('/:account/keys', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		let acct;
		try {
			// userFacing: true → hedged for a snappy interactive verdict
			// (the import field checks existence as the user types).
			acct = await blurt.getAccount(account, { userFacing: true });
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}

		if (acct === null) {
			return c.json(errorBody('not_found', 'no such account on chain'), 404);
		}

		// Defensive: a node could return an account missing its authority
		// blocks. Treat that as an upstream failure rather than emitting a
		// body the client-side verifier would choke on.
		if (!isAuthority(acct.owner) || !isAuthority(acct.active) || !isAuthority(acct.posting) || typeof acct.memo_key !== 'string') {
			return c.json(errorBody('internal', 'incomplete account data from the Blurt network'), 502);
		}

		const body: AccountKeysBody = {
			account: {
				name: acct.name,
				owner: acct.owner,
				active: acct.active,
				posting: acct.posting,
				memo_key: acct.memo_key
			}
		};

		c.header('Cache-Control', KEYS_CACHE_CONTROL);
		return c.json(body);
	});

	return app;
}
