#!/usr/bin/env tsx
/**
 * upgrade-backup-prune-smoke.ts
 *
 * `morphit-ops upgrade` rotates install backups (/opt/morphit.bak-<ts>) and
 * prunes the oldest beyond MORPHIT_BACKUP_KEEP. The original prune REFUSED to
 * delete any backup that had a process with its cwd parked under it — which on
 * a real box meant a leftover login shell or a `less`/pager from
 * `systemctl status` blocked the prune forever, and the operator got a [WARN]
 * on every upgrade telling them to go hunt PIDs (cp260: Ken hit exactly this,
 * with the same stuck shell + status pagers two upgrades running).
 *
 * The fix (beta18): the prune only refuses when a process is actually RUNNING
 * CODE from the backup (a service started from the old tree) — detected via
 * `pidsRunningFrom` (executable, or an absolute argv path, under the dir), NOT
 * mere cwd. A backup with only idle shells/pagers parked in it is pruned
 * anyway (deleting a directory out from under a process's cwd is harmless on
 * Linux — the kernel keeps it running with a stale cwd). This pins that
 * contract so a future edit can't regress to "any cwd parked here blocks the
 * prune forever".
 *
 *   BP-1  pruneOldBackups gates the delete on pidsRunningFrom(), not
 *         pidsWithCwdUnder().
 *   BP-2  pidsRunningFrom inspects the executable (/proc/<pid>/exe) AND the
 *         command line (/proc/<pid>/cmdline), matching absolute paths only.
 *   BP-3  pruneOldBackups still calls rmSync to delete the pruned tree (it
 *         doesn't merely warn).
 *   BP-4  pidsWithCwdUnder still EXISTS (used for the post-swap orphan warning
 *         and the "idle shells parked here, harmless" note) — not deleted.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '..', 'src', 'commands', 'upgrade.ts'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	console.log(`  ✓ ${m}`);
	pass++;
};
const bad = (m: string, detail?: string): void => {
	console.log(`  ✗ ${m}${detail ? ` — ${detail}` : ''}`);
	fail++;
};

console.log('\n── upgrade-backup-prune smoke (beta18 — prune past harmless campers) ──\n');

// Isolate the pruneOldBackups body (up to the next top-level function).
const pruneStart = SRC.indexOf('function pruneOldBackups(');
const afterPrune = pruneStart >= 0 ? SRC.slice(pruneStart + 1) : '';
const nextFnRel = afterPrune.search(/\n(?:async )?function /);
const pruneBody =
	pruneStart < 0
		? ''
		: SRC.slice(pruneStart, nextFnRel >= 0 ? pruneStart + 1 + nextFnRel : pruneStart + 3000);

// BP-1: the delete safeguard keys on pidsRunningFrom, not pidsWithCwdUnder.
if (/pidsRunningFrom\(ent\.path\)/.test(pruneBody)) {
	ok('BP-1 prune safeguard gates on pidsRunningFrom(ent.path)');
} else {
	bad('BP-1 prune no longer gates on pidsRunningFrom(ent.path)');
}
// It must NOT be the OLD cwd-based gate (a process with cwd under the dir
// blocking the delete).
if (/const\s+livePids\s*=\s*pidsWithCwdUnder\(ent\.path\)/.test(pruneBody)) {
	bad('BP-1b prune regressed to the cwd-based block (pidsWithCwdUnder gates the delete)');
} else {
	ok('BP-1b prune does not block on mere cwd (no pidsWithCwdUnder delete-gate)');
}

// BP-2: pidsRunningFrom inspects exe + cmdline, absolute paths only.
const rfStart = SRC.indexOf('function pidsRunningFrom(');
const rfBody = rfStart >= 0 ? SRC.slice(rfStart, rfStart + 1400) : '';
const checksExe = /\/proc\/\$\{e\}\/exe/.test(rfBody);
const checksCmdline = /\/proc\/\$\{e\}\/cmdline/.test(rfBody);
const absOnly = /p\[0\]\s*!==\s*'\/'/.test(rfBody);
if (rfStart >= 0 && checksExe && checksCmdline && absOnly) {
	ok('BP-2 pidsRunningFrom inspects /proc exe + cmdline, absolute paths only');
} else {
	bad(
		'BP-2 pidsRunningFrom signal incomplete',
		`exe=${checksExe} cmdline=${checksCmdline} absOnly=${absOnly}`
	);
}

// BP-3: prune still actually deletes (rmSync), not just warns.
if (/rmSync\(ent\.path,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/.test(pruneBody)) {
	ok('BP-3 prune still deletes the tree (rmSync recursive+force)');
} else {
	bad('BP-3 prune no longer calls rmSync on the pruned tree');
}

// BP-4: pidsWithCwdUnder still exists (orphan warning + harmless-camper note).
if (/function pidsWithCwdUnder\(/.test(SRC)) {
	ok('BP-4 pidsWithCwdUnder retained (orphan warning + harmless-camper note)');
} else {
	bad('BP-4 pidsWithCwdUnder was removed (breaks the post-swap orphan warning)');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-backup-prune smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} upgrade-backup-prune scenarios passed`);
