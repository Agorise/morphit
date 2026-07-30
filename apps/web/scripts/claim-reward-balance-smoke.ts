#!/usr/bin/env tsx
/**
 * Smoke: the unclaimed-rewards "Claim now" feature is wired end-to-end —
 * the op is buildable + broadcastable same-origin, the indexer surfaces the
 * reward fields, and the balance card claims → animates → hides the line.
 * Anchor cp396.
 *
 * THE PRODUCT RULES THIS GUARDS:
 *   1. claim_reward_balance is on the broadcast-proxy op whitelist, so the
 *      claim goes SAME-ORIGIN (privacy #1) instead of leaking the user's IP
 *      to a third-party RPC node via the direct fallback.
 *   2. broadcastClaimReward builds the native op with the exact Blurt field
 *      names (account, reward_blurt, reward_vests) and signs with POSTING
 *      authority — the signer can only ever claim their OWN rewards.
 *   3. The indexer balance endpoint exposes the three reward fields the card
 *      reads (reward_blurt_balance, reward_vesting_balance, reward_vesting_blurt).
 *   4. MyBalanceCard wires the UI: the line shows only when hasUnclaimed,
 *      the Claim button broadcasts then refreshes (odometer) + nudges the bus,
 *      and the line disappears once claimed (rewards cleared → hasUnclaimed false).
 *      The Claim button only renders when keys are present ($liveIdentity).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const BROADCAST = join(REPO, 'apps/indexer/src/api/broadcast.ts');
const SIGN = join(REPO, 'apps/web/src/lib/blurt/sign.ts');
const BALANCE_API = join(REPO, 'apps/indexer/src/api/accountBalance.ts');
const CARD = join(REPO, 'apps/web/src/lib/components/MyBalanceCard.svelte');

const broadcast = readFileSync(BROADCAST, 'utf-8');
const sign = readFileSync(SIGN, 'utf-8');
const balanceApi = readFileSync(BALANCE_API, 'utf-8');
const card = readFileSync(CARD, 'utf-8');

type Check = { readonly name: string; readonly holds: (s?: string) => boolean };

const checks: readonly Check[] = [
	{
		name: "broadcast proxy whitelists 'claim_reward_balance' (claim goes same-origin)",
		holds: () => /ALLOWED_OP_TYPES = new Set\(\[[\s\S]*?'claim_reward_balance'[\s\S]*?\]\)/.test(broadcast)
	},
	{
		name: 'broadcastClaimReward builds claim_reward_balance with the Blurt field names',
		holds: () =>
			/export async function broadcastClaimReward\(/.test(sign) &&
			/'claim_reward_balance',\s*\{\s*account:\s*blurtAccount,\s*reward_blurt:\s*rewardBlurt,\s*reward_vests:\s*rewardVests/.test(
				sign
			)
	},
	{
		name: 'broadcastClaimReward signs with the POSTING key',
		holds: () => /broadcastClaimReward[\s\S]*?rawToPrivateKey\(live\.posting\.privateKey\)/.test(sign)
	},
	{
		name: 'indexer balance endpoint exposes the three reward fields',
		holds: () =>
			/reward_blurt_balance:\s*acct\.reward_blurt_balance/.test(balanceApi) &&
			/reward_vesting_balance:\s*acct\.reward_vesting_balance/.test(balanceApi) &&
			/reward_vesting_blurt:\s*acct\.reward_vesting_blurt/.test(balanceApi)
	},
	{
		name: 'card derives hasUnclaimed from the parsed reward amounts',
		holds: () => /const hasUnclaimed = \$derived\(rewardBlurt > 0 \|\| rewardBp > 0\);/.test(card)
	},
	{
		name: 'card parses reward fields on load (raw strings for the op, numbers for display)',
		holds: () =>
			/rewardBlurtRaw = acct\.reward_blurt_balance;/.test(card) &&
			/rewardVestsRaw = acct\.reward_vesting_balance;/.test(card) &&
			/rewardBp = parseAssetAmount\(acct\.reward_vesting_blurt\);/.test(card)
	},
	{
		name: 'claimRewards broadcasts the raw amounts then hard-refreshes + nudges the bus',
		holds: () =>
			/broadcastClaimReward\(live, account, blurtArg, vestsArg\)/.test(card) &&
			/await refresh\(\{ hard: true \}\);/.test(card) &&
			/triggerBalanceRefresh\(\);/.test(card)
	},
	{
		name: 'claim clears the rewards so the line disappears (hasUnclaimed → false)',
		holds: () => /rewardBlurt = 0;\s*rewardBp = 0;/.test(card)
	},
	{
		name: 'unclaimed line + Claim button are gated (hasUnclaimed; button needs $liveIdentity)',
		holds: () =>
			/\{#if hasUnclaimed\}/.test(card) &&
			/data-unclaimed-rewards/.test(card) &&
			/\{#if \$liveIdentity\}[\s\S]*?onclick=\{claimRewards\}/.test(card)
	}
];

let pass = 0;
let fail = 0;
for (const c of checks) {
	if (c.holds()) {
		console.log(`  ✓ ${c.name}`);
		pass++;
	} else {
		console.error(`  ✗ ${c.name}`);
		fail++;
	}
}

// ── Tamper tests: break one invariant, assert the matching check flips red. ──
const tampers: ReadonlyArray<{ readonly label: string; readonly holds: () => boolean }> = [
	{
		label: 'claim_reward_balance dropped from the whitelist',
		holds: () =>
			/ALLOWED_OP_TYPES = new Set\(\[[\s\S]*?'claim_reward_balance'[\s\S]*?\]\)/.test(
				broadcast.replace("'claim_reward_balance'", "'nope_removed'")
			)
	},
	{
		label: 'claim no longer clears rewards (line would never disappear)',
		holds: () => /rewardBlurt = 0;\s*rewardBp = 0;/.test(card.replace('rewardBlurt = 0;', 'rewardBlurt = rewardBlurt;'))
	},
	{
		label: 'op field name drifts from reward_blurt',
		holds: () =>
			/reward_blurt:\s*rewardBlurt/.test(sign.replace('reward_blurt: rewardBlurt', 'reward_steem: rewardBlurt'))
	}
];
for (const t of tampers) {
	if (t.holds()) {
		console.error(`  ✗ tamper NOT caught: "${t.label}" (toothless)`);
		fail++;
	} else {
		console.log(`  ✓ tamper caught: "${t.label}"`);
		pass++;
	}
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`✓ all ${pass} scenarios passed`);
