/**
 * fast-sync-modes-smoke — pins two fast-sync robustness fixes (v1.16.14), by
 * RUNNING both restore paths against a stand-in install whose snapshot tool
 * (node_modules/.bin/tsx) records what it was started with:
 *   1. Both restores SOURCE the indexer unit's env files (morphit.env,
 *      morphit.config.env, /etc/morphit/indexer.env) first, so CHAIN_ID /
 *      PUBLIC_ORIGIN / OFFICIAL_POSTING_PUBKEY are present — a stock box couldn't
 *      fast-sync without this (morphit.io).
 *   2. A `--from-file` peer-import mode exists (fastSyncFromFile) using the
 *      bootstrap's positional file + `--i-trust-this-source` — for when @morphit
 *      has no fresh on-chain snapshot (publisher rebuilt).
 *
 * v1.21.18 (review, 2026-10-29): this smoke used to also read fastSync.ts as
 * text and check where certain lines sit (questions before the stop, a
 * `finally` around the start, the stop poll). Those are behaviour, and tests
 * that run it prove them: test/fastSyncAskFirst.test.ts (every question before
 * anything is stopped, the safe default, starting again after Ctrl+C),
 * test/fastSyncStopWait.test.ts (waits until systemd says stopped),
 * test/fastSyncRestart.test.ts (started again after a failed restore).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fastSyncFromChain, fastSyncFromFile } from '../src/commands/fastSync.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  ✗ ${name}`);
	}
}

const repo = mkdtempSync(join(tmpdir(), 'fast-sync-modes-'));
const seen = join(repo, 'seen');
try {
	mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
	// The snapshot tool: records its arguments and the indexer settings it got.
	writeFileSync(
		join(repo, 'node_modules', '.bin', 'tsx'),
		[
			'#!/bin/sh',
			`{ printf 'ARGS'; for a in "$@"; do printf ' [%s]' "$a"; done; echo;`,
			'  echo "CHAIN=${MORPHIT_INDEXER_CHAIN_ID:-}"; echo "CONFIG=${MORPHIT_FROM_CONFIG:-}"; } >> ' +
				`'${seen}'`,
			'exit 0',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	// The settings live in the install's env files, not in this process.
	writeFileSync(join(repo, 'morphit.env'), 'MORPHIT_INDEXER_CHAIN_ID=cd8d90f2\n');
	writeFileSync(join(repo, 'morphit.config.env'), 'MORPHIT_FROM_CONFIG=yes\n');
	delete process.env.MORPHIT_INDEXER_CHAIN_ID;
	const quiet = process.stdout.write.bind(process.stdout);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	let rcChain: number;
	let rcFile: number;
	try {
		rcChain = fastSyncFromChain({ repoRoot: repo, callerSaysNext: true });
		rcFile = fastSyncFromFile({
			repoRoot: repo,
			filePath: join(repo, 'peer-snapshot.tar.gz'),
			callerSaysNext: true
		});
	} finally {
		process.stdout.write = quiet;
	}
	const runs = readFileSync(seen, 'utf8').trim().split('\n');
	const [chainArgs, chainEnv, chainCfg, fileArgs, fileEnv, fileCfg] = runs;

	check('the chain restore ran and succeeded', rcChain === 0 && chainArgs !== undefined);
	check(
		'…as snapshot-bootstrap --from-chain --i-trust-signer',
		/snapshot-bootstrap\.ts\] \[--from-chain\] \[--i-trust-signer\]/.test(chainArgs ?? '')
	);
	check(
		"…with the indexer's settings sourced from the install's env files (CHAIN_ID present)",
		chainEnv === 'CHAIN=cd8d90f2' && chainCfg === 'CONFIG=yes'
	);
	check('the file import ran and succeeded', rcFile === 0 && fileArgs !== undefined);
	check(
		'…with the file as the positional argument and --i-trust-this-source',
		(fileArgs ?? '').includes(
			`snapshot-bootstrap.ts] [${join(repo, 'peer-snapshot.tar.gz')}] [--i-trust-this-source]`
		)
	);
	check(
		"…and the same env files sourced (CHAIN_ID present)",
		fileEnv === 'CHAIN=cd8d90f2' && fileCfg === 'CONFIG=yes'
	);
} finally {
	rmSync(repo, { recursive: true, force: true });
}

if (fail === 0) {
	console.log(`✓ all ${pass} fast-sync-modes checks passed`);
} else {
	console.error(`✗ ${fail} of ${pass + fail} fast-sync-modes checks FAILED`);
	process.exit(1);
}
