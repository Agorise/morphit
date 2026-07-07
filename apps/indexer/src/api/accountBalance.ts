/**
 * Morphit indexer — /v1/account/:account/balance endpoint. Anchor cp295.
 *
 *   GET /v1/account/:account/balance
 *     → { account: { name, balance, vesting_shares, voting_manabar },
 *         dgp:     { head_block_number, current_supply,
 *                    total_vesting_fund_blurt, total_vesting_shares } }
 *     404 if the account does not exist on chain.
 *     502 (code "internal") if the chain RPC could not be reached.
 *
 * WHY THIS ENDPOINT EXISTS — PRIVACY (priority #1).  The balance card
 * and block explorer used to fetch account data by talking to public
 * Blurt RPC nodes DIRECTLY from the browser.  That leaks two things to
 * third-party node operators Morphit does not control: the user's IP
 * address, and exactly which account they are looking at.  It is also
 * fragile — a browser can only use a node that returns a single valid
 * `Access-Control-Allow-Origin`, so the browser's usable node set is a
 * shifting subset of the canonical pool (it depends on each operator
 * keeping their CORS config correct, which changes night to night).
 *
 * Routing the read through the indexer fixes both: the third-party
 * nodes only ever see the INDEXER's IP (server-side fetch, where CORS
 * does not apply, across the FULL canonical pool with the rpc-pool's
 * automatic latency-aware best-node selection + cooldown failover),
 * and the only party that sees which account the user viewed is the
 * operator the user already chose to trust. The browser fetches this
 * same-origin (`/v1/account/...`), so it never opens a cross-origin
 * connection to an RPC node at all.
 *
 * Balance is public on-chain data, so the response is `public`-
 * cacheable for a short window — a single indexer fetch then serves
 * every viewer of that account, collapsing RPC load and widening the
 * privacy set.
 */

import { Hono } from 'hono';

import type { BlurtClient } from '$blurt/client';
import { errorBody, isAccountName } from '$api/shared';

/** Short public cache. Balances move ~every 3s block, so the window
 *  must stay tiny: a 2s max-age still collapses sub-block bursts (and
 *  repeat explorer views of the same account) without ever serving a
 *  meaningfully stale balance. NO stale-while-revalidate — on a balance
 *  that is exactly the failure mode: swr serves the last cached copy
 *  while a background revalidation runs, and if that revalidation fails
 *  against a flaky node it keeps serving the old number indefinitely.
 *  A live wallet must refetch, not coast on a cached value. `public` is
 *  correct — an account's balance is public chain data, not private. */
const BALANCE_CACHE_CONTROL = 'public, max-age=2';

/** Response body. Mirrors the fields the frontend balance math
 *  (`vestsToBlurtPower`, `manaPercentage`, `computeBlurtVestingApr`)
 *  consumes, so the browser keeps all its existing computation and
 *  only swaps the data SOURCE from direct-RPC to this endpoint. */
interface AccountBalanceBody {
	readonly account: {
		readonly name: string;
		readonly balance: string;
		readonly vesting_shares: string;
		/** VESTS delegated TO / OUT FROM this account — the frontend uses
		 *  them to compute EFFECTIVE vesting (own + received − delegated),
		 *  the real voting-manabar ceiling, so voting power % is correct for
		 *  accounts that delegate BP out (e.g. the loyalty-grant relay). */
		readonly received_vesting_shares: string;
		readonly delegated_vesting_shares: string;
		readonly voting_manabar: {
			readonly current_mana: string;
			readonly last_update_time: number;
		} | null;
		/** Legacy voting power (0–10000) + last-vote time — the inputs the
		 *  frontend regenerates into the "Voting" % shown by blocks.blurtwallet.com. */
		readonly voting_power: number | null;
		readonly last_vote_time: string | null;
		/** First posting-authority pubkey, or null — lets the block
		 *  explorer's account page avoid a direct getAccount RPC read. */
		readonly posting_pub: string | null;
		/** cp396 — unclaimed author/curation rewards waiting to be claimed
		 *  via claim_reward_balance. `reward_blurt_balance` is liquid BLURT;
		 *  `reward_vesting_balance` is the VESTS amount (what the claim op
		 *  consumes); `reward_vesting_blurt` is the chain-provided BLURT
		 *  value of that vesting reward (what the card shows as BP). All
		 *  default to their zero sentinel when a node omits them. */
		readonly reward_blurt_balance: string;
		readonly reward_vesting_balance: string;
		readonly reward_vesting_blurt: string;
	};
	readonly dgp: {
		readonly head_block_number: number;
		readonly current_supply: string;
		readonly total_vesting_fund_blurt: string;
		readonly total_vesting_shares: string;
	};
}

export function accountBalanceRoute(blurt: BlurtClient): Hono {
	const app = new Hono();

	app.get('/:account/balance', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		let acct;
		let dgp;
		try {
			// userFacing: true → hedged (race the two best nodes) for a
			// snappy interactive response, exactly as a balance read wants.
			[acct, dgp] = await Promise.all([
				blurt.getAccount(account, { userFacing: true }),
				blurt.getDynamicGlobalProperties()
			]);
		} catch {
			// Upstream RPC unreachable / all nodes failed. This is the
			// indexer's problem to report now, NOT a browser CORS failure.
			return c.json(
				errorBody('internal', 'could not reach the Blurt network'),
				502
			);
		}

		if (acct === null) {
			return c.json(errorBody('not_found', 'no such account on chain'), 404);
		}

		// Defensive: a misbehaving node could return an account/DGP
		// missing the balance-relevant fields. Treat that as an upstream
		// failure rather than emitting a malformed body the frontend math
		// would choke on.
		if (
			typeof acct.balance !== 'string' ||
			typeof acct.vesting_shares !== 'string' ||
			typeof dgp.total_vesting_fund_blurt !== 'string' ||
			typeof dgp.total_vesting_shares !== 'string' ||
			typeof dgp.current_supply !== 'string'
		) {
			return c.json(
				errorBody('internal', 'incomplete account data from the Blurt network'),
				502
			);
		}

		// First posting-authority pubkey (defensive: a node could return
		// a malformed authority). null when absent. Lets the explorer's
		// account page render the posting key without its own RPC read.
		let postingPub: string | null = null;
		const keyAuths = acct.posting?.key_auths;
		if (
			Array.isArray(keyAuths) &&
			keyAuths.length > 0 &&
			Array.isArray(keyAuths[0]) &&
			typeof keyAuths[0][0] === 'string'
		) {
			postingPub = keyAuths[0][0];
		}

		const body: AccountBalanceBody = {
			account: {
				name: acct.name,
				balance: acct.balance,
				vesting_shares: acct.vesting_shares,
				// Effective-vesting inputs. Default to zero if a node omits
				// them so the frontend's manabar math degrades to the
				// owned-only ceiling rather than producing NaN.
				received_vesting_shares: acct.received_vesting_shares ?? '0.000000 VESTS',
				delegated_vesting_shares: acct.delegated_vesting_shares ?? '0.000000 VESTS',
				voting_manabar: acct.voting_manabar ?? null,
				voting_power: acct.voting_power ?? null,
				last_vote_time: acct.last_vote_time ?? null,
				posting_pub: postingPub,
				// cp396 — unclaimed rewards. Zero sentinels keep the frontend
				// math safe if a node omits them (no rewards → line hidden).
				reward_blurt_balance: acct.reward_blurt_balance ?? '0.000 BLURT',
				reward_vesting_balance: acct.reward_vesting_balance ?? '0.000000 VESTS',
				reward_vesting_blurt: acct.reward_vesting_blurt ?? '0.000 BLURT'
			},
			dgp: {
				head_block_number: dgp.head_block_number,
				current_supply: dgp.current_supply,
				total_vesting_fund_blurt: dgp.total_vesting_fund_blurt,
				total_vesting_shares: dgp.total_vesting_shares
			}
		};

		c.header('Cache-Control', BALANCE_CACHE_CONTROL);
		return c.json(body);
	});

	return app;
}
