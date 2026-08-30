/**
 * morphit-ops fast-sync (cp766).
 *
 * Bring a FRESH node's indexer to a live orderbook in minutes by restoring the
 * newest federation snapshot published on-chain (indexer_snapshot_v1), instead
 * of replaying ~3.75M blocks for days. This is the recommended path for a new
 * install; the trustless full replay is always available (just start the indexer
 * with MORPHIT_INDEXER_START_BLOCK at genesis).
 *
 * This command is a thin, loud wrapper around snapshot-bootstrap.ts --from-chain:
 * it explains exactly what is being trusted, guards against a live indexer,
 * confirms, then runs the bootstrap (which reads the signed op, downloads,
 * verifies sha256 three ways, restores, and Tier-2 spot-checks the op log). On
 * success the operator starts the indexer, which catches up + re-verifies the
 * short tail.
 *
 * Flags: --signer <account> (trusted publisher, default morphit),
 *        --force (restore over an existing DB — destructive),
 *        --skip-verify (skip the Tier-2 spot-check, e.g. tor-only with no
 *        cleartext block access yet).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { CommandCtx } from '../lib/ctx.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { indexerLooksRunning } from './fastForward.ts';
import { ask } from '../init/prompt.ts';
import { section, info, blank } from '../render/term.ts';

interface StateRow {
	readonly last_applied_at: string | null;
	readonly last_applied_block: string;
}

export async function runFastSync(ctx: CommandCtx): Promise<number> {
	section('Fast-sync from a federation snapshot');
	info('Restores the newest on-chain-anchored indexer snapshot, then catches up the');
	info('short tail — minutes to a live orderbook instead of days of full replay.');
	blank();
	info('You will be trusting the snapshot PUBLISHER (@' + (ctx.flags.signer ?? 'morphit') + ') for the');
	info('pre-tail state — the same trust as running their software. The tail from the');
	info('snapshot block to chain head is re-verified by normal indexing, and a Tier-2');
	info('spot-check proves the snapshot op log against the chain before you serve.');
	blank();
	info('Prefer zero trust? Skip this and start the indexer with MORPHIT_INDEXER_START_BLOCK');
	info('at genesis for a full trustless replay.');
	blank();

	const force = ctx.flags.force === 'true';

	// Guard: never restore under a live indexer (it would fight the poller + the
	// restore truncates its tables). Mirror fast-forward's liveness heuristic.
	try {
		const res = await ctx.db.query<StateRow>(
			'SELECT last_applied_block::text, last_applied_at FROM indexer_state LIMIT 1'
		);
		if (res.rows.length > 0) {
			const lastAppliedAt = res.rows[0]!.last_applied_at ? new Date(res.rows[0]!.last_applied_at) : null;
			if (indexerLooksRunning(lastAppliedAt, new Date()) && !force) {
				info('✗ The indexer looks like it is RUNNING (its cursor moved recently).');
				info('  Stop it first, then re-run:  sudo systemctl stop morphit-indexer');
				return 1;
			}
			const existing = parseInt(res.rows[0]!.last_applied_block, 10);
			if (Number.isFinite(existing) && existing > 0 && !force) {
				info(`✗ This node already has indexer data (block ${existing.toLocaleString()}).`);
				info('  Fast-sync would DISCARD it. Re-run with --force if that is intended.');
				return 1;
			}
		}
	} catch {
		// No indexer_state yet = truly fresh box = the ideal fast-sync case.
	}

	const proceed = (await ask('Type "fast-sync" to restore the newest federation snapshot')).trim();
	if (proceed !== 'fast-sync') {
		info('Aborted — nothing changed.');
		return 1;
	}

	// Run the bootstrap from the deployed repo. Inherit stdio so its progress,
	// verification output, and any prompts reach the operator directly.
	blank();
	return fastSyncFromChain({
		repoRoot: defaultRepoRoot(),
		signer: ctx.flags.signer,
		force,
		skipVerify: ctx.flags['skip-verify'] === 'true'
	});
}

/**
 * Shared bootstrap driver: spawn snapshot-bootstrap.ts --from-chain and report.
 * Used by both the standalone `fast-sync` command (after its guards) and the
 * install wizard (fresh box, no guards needed). Returns the child's exit code.
 */
export function fastSyncFromChain(opts: {
	repoRoot: string;
	signer?: string;
	force?: boolean;
	skipVerify?: boolean;
}): number {
	const repo = opts.repoRoot;
	const tsx = join(repo, 'node_modules', '.bin', 'tsx');
	const bootstrapArgs = [
		'--tsconfig',
		join(repo, 'tsconfig.smoke.json'),
		join(repo, 'apps', 'indexer', 'scripts', 'snapshot-bootstrap.ts'),
		'--from-chain',
		'--i-trust-signer'
	];
	if (opts.signer) bootstrapArgs.push('--signer', opts.signer);
	if (opts.force) bootstrapArgs.push('--force');
	if (opts.skipVerify) bootstrapArgs.push('--skip-verify');

	const run = spawnSync(tsx, bootstrapArgs, { cwd: repo, stdio: 'inherit' });
	if (run.status !== 0) {
		blank();
		info('✗ Fast-sync did not complete. You can retry, or do a full replay instead.');
		return run.status ?? 1;
	}

	blank();
	section('Fast-sync complete');
	info('Start the indexer; it will catch up + re-verify the short tail to chain head:');
	info('    sudo systemctl start morphit-indexer');
	return 0;
}
