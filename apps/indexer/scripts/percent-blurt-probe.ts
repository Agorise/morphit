#!/usr/bin/env tsx
/**
 * percent-blurt-probe — answers ONE question against the real chain:
 *
 *   does Blurt accept `percent_blurt: 10000` on comment_options,
 *   or does it clamp / reject it?
 *
 * WHY THIS EXISTS. v1.8.12 sets `percent_blurt` so the AUTHOR receives as much
 * liquid BLURT as possible instead of Blurt's default 25% liquid / 75% BP.
 * The field's shape is verified (it serialises against dblurt's own
 * serializer), but the acceptable RANGE could not be established from Blurt's
 * documentation — the docs describe the default and an opt-in to 100% BP, and
 * never advertise going above 25% liquid. Guessing at a consensus rule that
 * moves real money is not acceptable, so this asks the chain directly.
 *
 * WHAT IT DOES. Posts one tiny throwaway post from a TEST account, then
 * immediately broadcasts comment_options for it with percent_blurt = 10000, and
 * reports exactly what the node said. Two separate transactions, matching how
 * the app now broadcasts them — so if the options op is refused, the post still
 * exists and nothing is lost but a test post.
 *
 * SAFE BY CONSTRUCTION:
 *   - Uses only the POSTING key. It cannot move funds.
 *   - Refuses to run against @kencode / @agorise / @morphit (real accounts).
 *   - Costs one Blurt operation fee (a fraction of a BLURT).
 *   - Reads the key from a MASKED prompt — never an argument, so it cannot
 *     land in shell history.
 *
 * USAGE (from the repo root, on the laptop that holds the key):
 *   npx tsx apps/indexer/scripts/percent-blurt-probe.ts kentest3
 */
import { createInterface } from 'node:readline';
import { Client, PrivateKey } from '@beblurt/dblurt';

const RPC = 'https://rpc.blurt.blog';
/** Accounts this probe refuses to touch — it creates a real post. */
const FORBIDDEN = new Set(['kencode', 'agorise', 'morphit', 'morphit-fees', 'morphit-relay']);
/** The value v1.8.12 asks for: 100% of the author reward as liquid BLURT. */
const PERCENT_BLURT = 10000;

function askHidden(query: string): Promise<string> {
	process.stderr.write(query);
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
		rl.question('', (ans) => {
			rl.close();
			process.stderr.write('\n');
			resolve(ans.trim());
		});
	});
}

function die(msg: string): never {
	process.stderr.write(`\n✗ ${msg}\n`);
	process.exit(1);
}

async function main(): Promise<void> {
	const account = process.argv[2]?.trim().toLowerCase();
	if (!account) die('usage: npx tsx apps/indexer/scripts/percent-blurt-probe.ts <test-account>');
	if (FORBIDDEN.has(account)) {
		die(`refusing to post from @${account} — use a test account (this creates a real post).`);
	}

	const wif = await askHidden(`Posting key (WIF) for @${account} — starts with 5, input hidden: `);
	if (!wif.startsWith('5')) die('that does not look like a posting WIF (it should start with 5).');

	const client = new Client(RPC);
	const key = PrivateKey.fromString(wif);
	const permlink = `percent-blurt-probe-${Date.now().toString(36)}`;

	process.stderr.write(`\n1/2  posting a throwaway post as @${account}…\n`);
	try {
		await client.broadcast.comment(
			{
				parent_author: '',
				parent_permlink: 'test',
				author: account,
				permlink,
				title: 'percent_blurt probe',
				body: 'Throwaway post used to test the comment_options percent_blurt range. Safe to ignore.',
				json_metadata: JSON.stringify({ app: 'morphit-probe', tags: ['test'] })
			},
			key
		);
		process.stderr.write(`     ✓ posted: @${account}/${permlink}\n`);
	} catch (err) {
		die(`the POST itself failed, so we learned nothing about percent_blurt:\n   ${String(err)}`);
	}

	process.stderr.write(`\n2/2  setting comment_options with percent_blurt = ${PERCENT_BLURT}…\n`);
	try {
		await client.broadcast.commentOptions(
			{
				author: account,
				permlink,
				max_accepted_payout: '1000000.000 BLURT',
				allow_votes: true,
				allow_curation_rewards: true,
				// StaticVariant index 1 = percent_blurt (index 0 = beneficiaries).
				extensions: [[1, { percent_blurt: PERCENT_BLURT }]]
			} as never,
			key
		);
		process.stderr.write(
			`\n✅ ACCEPTED — the chain took percent_blurt = ${PERCENT_BLURT}.\n` +
				`   Tell Claude: "accepted". v1.8.12 can keep 10000.\n` +
				`   (Whether the PAYOUT honours it fully shows after the 7-day payout on\n` +
				`    @${account}/${permlink} — worth a look then.)\n`
		);
	} catch (err) {
		const msg = String(err);
		process.stderr.write(
			`\n❌ REJECTED — the chain refused percent_blurt = ${PERCENT_BLURT}.\n` +
				`   The post itself is fine; only the options op failed (which is exactly\n` +
				`   why the app broadcasts them separately).\n\n` +
				`   Paste this whole error to Claude:\n   ${msg}\n`
		);
		process.exit(2);
	}
}

void main();
