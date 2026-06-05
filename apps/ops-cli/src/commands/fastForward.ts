/**
 * morphit-ops fast-forward (beta5).
 *
 * Advances an EXISTING node's indexer cursor
 * (indexer_state.last_applied_block) to a chosen recent block, so an
 * operator who started a fresh sync from too far back (e.g. block 0)
 * can jump to near the chain head instead of waiting days — without
 * wiping the database.
 *
 * Pre-launch this is free (there is no Morphit data in skipped
 * blocks). Post-launch it loses any Morphit listings/orders/fees in
 * the skipped range, so the command is loud about that and forward-
 * only (it refuses to rewind — re-indexing from an earlier block is a
 * separate, destructive "reset the DB" operation, not a fast-forward).
 *
 * Recovery command — NOT in the morphit-ops menu (beta6). A normal
 * install auto-starts the indexer at the Morphit genesis block and
 * resumes from its saved cursor on every restart, so the usual flow
 * never needs this. It exists only for a node mistakenly started from
 * too far back (e.g. block 0). Run it as `morphit-ops fast-forward`.
 *
 * The cursor + how to find a target:
 *   - The indexer must be STOPPED first, so the poller doesn't fight
 *     this change. As a guard, the command REFUSES if the indexer's
 *     cursor was touched within the last 90s (it looks live); pass
 *     --force to override that check.
 *   - Get the current chain head from `curl <indexer>/v1/health`
 *     (chain_head_block) or any Blurt block explorer, and pass it
 *     (or a little less) as the target.
 */

import type { CommandCtx } from '../lib/ctx.ts';
import { jsonOutput } from '../lib/ctx.ts';
import { ask } from '../init/prompt.ts';
import { section, info, blank } from '../render/term.ts';
import { emitJson } from '../render/json.ts';

export type FastForwardKind = 'advance' | 'noop' | 'behind' | 'invalid';

export interface FastForwardPlan {
	readonly kind: FastForwardKind;
	readonly current: number;
	readonly target: number;
	/** advance: blocks marked applied WITHOUT being indexed. */
	readonly skipped: number;
	/** Operator-facing explanation / warning. */
	readonly message: string;
}

/** Decide what a fast-forward from `current` to `target` would do.
 *  PURE — no I/O — so the decision logic is unit-testable. */
export function planFastForward(current: number, target: number): FastForwardPlan {
	if (!Number.isInteger(target) || target < 0) {
		return {
			kind: 'invalid',
			current,
			target,
			skipped: 0,
			message: 'Target must be a whole number of 0 or more (a Blurt block height).'
		};
	}
	if (target === current) {
		return {
			kind: 'noop',
			current,
			target,
			skipped: 0,
			message: `The indexer cursor is already at block ${current}. Nothing to do.`
		};
	}
	if (target < current) {
		return {
			kind: 'behind',
			current,
			target,
			skipped: 0,
			message:
				`Fast-forward only moves the cursor FORWARD. It is at block ${current}, ` +
				`and ${target} is behind that. Re-indexing from an earlier block means ` +
				`resetting the database — a separate, destructive operation, not a fast-forward.`
		};
	}
	const skipped = target - current;
	return {
		kind: 'advance',
		current,
		target,
		skipped,
		message:
			`This marks blocks ${current + 1}–${target} (${skipped.toLocaleString()} blocks) as ` +
			`already applied WITHOUT indexing them. Any Morphit listings, orders, or fee ` +
			`payments in that range will NOT be seen. This is safe BEFORE launch (no Morphit ` +
			`data exists yet) but loses data AFTER launch.`
	};
}

/** Liveness window for the fast-forward guard. The indexer's poller
 *  writes indexer_state.last_applied_at = NOW() in the same transaction
 *  it applies blocks — every ~3s block while following the chain, far
 *  more often while catching up (the only time fast-forward does real
 *  work). So a cursor touched within this window means the poller is
 *  live and a fast-forward would race it. 90s sits well above the block
 *  interval (margin for slow polling) while keeping the post-stop wait
 *  short. */
export const INDEXER_LIVE_WINDOW_MS = 90_000;

/** PURE — does the indexer look like it is still running, judging only
 *  by how recently it applied a block? `lastAppliedAt === null` means it
 *  has never applied one (safe). A future timestamp (clock skew) is
 *  treated as not-running. `now` is explicit so this is unit-testable. */
export function indexerLooksRunning(
	lastAppliedAt: Date | null,
	now: Date,
	windowMs: number = INDEXER_LIVE_WINDOW_MS
): boolean {
	if (lastAppliedAt === null) return false;
	const ageMs = now.getTime() - lastAppliedAt.getTime();
	return ageMs >= 0 && ageMs < windowMs;
}

interface StateRow {
	last_applied_block: string;
	chain_id: string;
	last_applied_at: string | null;
}

export async function runFastForward(ctx: CommandCtx): Promise<number> {
	const json = jsonOutput(ctx);

	// Read the current cursor.
	const res = await ctx.db.query<StateRow>(
		`SELECT last_applied_block::text, chain_id, last_applied_at FROM indexer_state WHERE id = 1`
	);
	if (res.rowCount === 0) {
		const msg =
			'The indexer has not initialised its state yet (it has never started). ' +
			'On first start it will begin indexing from MORPHIT_INDEXER_START_BLOCK ' +
			'(the Morphit genesis block by default), so there is nothing to fast-forward.';
		if (json) emitJson({ ok: true, applied: false, reason: 'no_state_row' });
		else {
			blank();
			info(`  ${msg}`);
			blank();
		}
		return 0;
	}
	const current = parseInt(res.rows[0]!.last_applied_block, 10);

	// Liveness-guard inputs. The poller writes last_applied_at = NOW() in
	// the same transaction it applies blocks, so a recent timestamp means
	// it is still running and would fight a cursor write. Captured once,
	// here at command start (a later prompt delay does not change them).
	const now = new Date();
	const lastAppliedAt = res.rows[0]!.last_applied_at
		? new Date(res.rows[0]!.last_applied_at)
		: null;
	const looksRunning = indexerLooksRunning(lastAppliedAt, now);
	const ageS = lastAppliedAt
		? Math.max(0, Math.round((now.getTime() - lastAppliedAt.getTime()) / 1000))
		: 0;
	const force = ctx.flags.force === 'true';

	// Determine target: positional arg, else interactive prompt.
	let target: number;
	const positional = ctx.positional[0];
	if (positional !== undefined) {
		target = parseInt(positional, 10);
	} else if (json) {
		emitJson({ ok: false, applied: false, error: 'target block required (pass it as an argument, or run interactively)' });
		return 1;
	} else {
		section('Fast-forward the indexer cursor');
		info(`  The indexer is currently at block ${current.toLocaleString()}.`);
		info('  Enter the block to jump to — usually the current chain head.');
		info('  Find it with:  curl -sS http://127.0.0.1:8081/v1/health | jq .chain_head_block');
		blank();
		const raw = await ask('Target block');
		target = parseInt(raw, 10);
	}

	const plan = planFastForward(current, target);

	if (json) {
		// JSON mode never mutates — it returns the plan for inspection.
		emitJson({
			ok: plan.kind === 'advance' || plan.kind === 'noop',
			applied: false,
			indexer_looks_running: looksRunning,
			plan: {
				kind: plan.kind,
				current: plan.current,
				target: plan.target,
				skipped: plan.skipped,
				message: plan.message
			}
		});
		return plan.kind === 'invalid' || plan.kind === 'behind' ? 1 : 0;
	}

	if (plan.kind === 'invalid' || plan.kind === 'behind') {
		blank();
		info(`  ${plan.message}`);
		blank();
		return 1;
	}
	if (plan.kind === 'noop') {
		blank();
		info(`  ${plan.message}`);
		blank();
		return 0;
	}

	// kind === 'advance' — guard against a live indexer, then confirm + apply.
	if (looksRunning && !force) {
		blank();
		info('  ✋ The indexer looks like it is still RUNNING — its sync cursor was');
		info(`     updated ${ageS}s ago.  Fast-forwarding now would fight the live poller`);
		info('     and may not stick.  Stop the indexer first, then run this again.');
		info('     (Just stopped it?  Give it a moment to settle.  To override this');
		info('     check anyway, re-run with --force.)');
		blank();
		return 1;
	}
	blank();
	info('  ⚠ Before continuing, make sure the indexer is STOPPED, so it does');
	info('    not fight this change (stop its screen/service first).');
	blank();
	info(`  ${plan.message}`);
	blank();
	const confirm = await ask(`  To proceed, type the target block number (${plan.target}) again`);
	if (parseInt(confirm, 10) !== plan.target) {
		blank();
		info('  Cancelled — the number did not match. Nothing was changed.');
		blank();
		return 1;
	}

	await ctx.db.query(
		`UPDATE indexer_state SET last_applied_block = $1, last_applied_at = NOW() WHERE id = 1`,
		[plan.target]
	);

	blank();
	info(`  ✓ Cursor set to block ${plan.target.toLocaleString()}.`);
	info(`    Start the indexer; it will resume from block ${(plan.target + 1).toLocaleString()}`);
	info('    and catch up to the chain head within minutes.');
	blank();
	return 0;
}
