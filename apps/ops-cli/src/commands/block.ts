/**
 * `morphit-ops block <account> [reason]` / `unblock <account>` (beta5).
 *
 * Instance-local moderation: hide an account's listings from THIS
 * instance with no Blurt posting key and no chain broadcast. Writes
 * `operator_blocks` directly (origin='local'); the listing queries
 * exclude blocked accounts. Reversible with `unblock`.
 */

import type { CommandCtx } from '../lib/ctx.ts';
import { error as printError, info } from '../render/term.ts';
import { applyLocalBlock, normalizeAccount, type BlockAction } from '../lib/localBlock.ts';

async function run(ctx: CommandCtx, action: BlockAction): Promise<number> {
	const json = ctx.flags.json === 'true';
	const operator = ctx.config.operatorAccount;

	const rawAccount = ctx.positional[0];
	if (rawAccount === undefined || rawAccount === '') {
		printError(`Usage: morphit-ops ${action} <account>${action === 'block' ? ' [reason]' : ''}`);
		return 1;
	}
	const account = normalizeAccount(rawAccount);
	if (account === null) {
		printError(`"${rawAccount}" is not a valid Blurt account name.`);
		return 1;
	}
	if (account === operator) {
		printError(`You can't block your own operator account (@${operator}).`);
		return 1;
	}

	// Reason: --reason flag, else the remaining positional words.
	const reason =
		action === 'block'
			? (ctx.flags.reason ?? ctx.positional.slice(1).join(' ')).slice(0, 500)
			: '';

	const { plan, changed } = await applyLocalBlock(ctx.db, { operator, account, action, reason });

	if (json) {
		console.log(JSON.stringify({ account, action, operator, op: plan.op, changed }, null, 2));
		return 0;
	}

	info(plan.summary);
	if (changed && action === 'block') {
		info(`  @${account}'s listings are now hidden on this instance. They'll see a notice with a link to the Matrix chatroom.`);
		info(`  Reverse with: morphit-ops unblock ${account}`);
	} else if (changed && action === 'unblock') {
		info(`  @${account}'s listings will show on this instance again.`);
	}
	return 0;
}

export function runBlock(ctx: CommandCtx): Promise<number> {
	return run(ctx, 'block');
}

export function runUnblock(ctx: CommandCtx): Promise<number> {
	return run(ctx, 'unblock');
}
