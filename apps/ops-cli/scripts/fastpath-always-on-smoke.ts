#!/usr/bin/env tsx
/**
 * fastpath-always-on — v1.7.0, ADR-0051.
 *
 * THE DECISION THIS PINS. The head-block fast path has NO on/off switch, and
 * that is deliberate rather than an oversight someone should "fix" later.
 *
 * ADR-0048 shipped `MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED` as an opt-out for
 * operators who wanted nothing shown until it was irreversible. v1.7.0 removed
 * it — REMOVED, not renamed — because the reasoning didn't survive contact with
 * what the tailer actually is: it never writes the database, so the worst a
 * broken fast path can do is fail to make things fast. There is nothing to
 * protect an operator from, and nobody prefers slow. A flag that is always true
 * is a branch that can be wrong, config that can drift, a second path every
 * smoke must cover, and — via the old `Fast chat: on` health line — an
 * invitation for an operator to conclude that slow is a thing they might want.
 *
 * This replaced `upgrade-fastpath-ensure-smoke`, which existed to check the
 * knob was on. Guarding "the knob is gone" is the same job for the opposite
 * world, so it keeps the registration slot rather than shifting every chunk
 * index after it.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Re-add MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED to the env schema → fails.
 *   - Re-add an `enabled` gate to HeadTailer.run() → fails.
 *   - Put the dead var back in ops/env/indexer.env.example → fails.
 *   - Re-add `enabled` to HeadTailerStatus → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── fastpath-always-on (v1.7.0 / ADR-0051) ─────────────\n');

const config = read('apps/indexer/src/config/index.ts');
const tailer = read('apps/indexer/src/indexer/headTailer.ts');
const envExample = read('ops/env/indexer.env.example');
const opsHealth = read('apps/ops-cli/src/commands/health.ts');

// ─── the knob is gone from every layer it lived in ───────────────
// Match a DECLARATION, not a mention: the files explain WHY the var was
// removed, and a guard that punishes documentation is a guard people delete.
check(
	'env schema declares no *_FASTPATH_ENABLED var',
	!/^\s*MORPHIT_[A-Z_]*FASTPATH_ENABLED\s*:/m.test(config),
	'fast is not an operator preference — see ADR-0051'
);
check(
	'Config has no fastPathEnabled / chatFastPathEnabled field',
	!/readonly\s+(chat)?[fF]astPathEnabled\s*:/.test(config)
);
check(
	'the interval knob survives (a straining node needs a real lever)',
	/MORPHIT_INDEXER_FASTPATH_INTERVAL_MS\s*:/.test(config) &&
		/readonly fastPathIntervalMs: number;/.test(config)
);

// ─── run() must not be gateable ──────────────────────────────────
check(
	'HeadTailer.run() has no enabled gate',
	!/if \(!this\.config\.[a-zA-Z]*[fF]astPathEnabled\)/.test(tailer),
	'an early return here silently restores the opt-out'
);
check(
	'HeadTailerStatus reports no always-true `enabled`',
	!/export interface HeadTailerStatus \{[^}]*readonly enabled:/s.test(tailer),
	'a status field that cannot vary is noise at best, misleading at worst'
);

// ─── operator-facing surfaces ────────────────────────────────────
check(
	'env example ships no dead FASTPATH_ENABLED assignment',
	!/^MORPHIT_[A-Z_]*FASTPATH_ENABLED=/m.test(envExample)
);
check(
	'env example ships the interval under its new name',
	/^MORPHIT_INDEXER_FASTPATH_INTERVAL_MS=/m.test(envExample)
);
check(
	'health reports LAG, not an on/off line',
	/FASTPATH_HEALTHY_LAG_BLOCKS/.test(opsHealth) && /behind head/.test(opsHealth),
	'"running" is not the question — "is it keeping up" is'
);
check(
	'health parses the `fastpath` block, not `chat_fastpath`',
	/parseFastPath\(b\.fastpath\)/.test(opsHealth)
);

// ─── the invariant that makes losing the switch safe ─────────────
// This is the load-bearing premise of the whole decision. If the tailer ever
// starts writing to the DB, removing the operator's off switch stops being
// defensible and this file's reasoning is void.
check(
	'the tailer still NEVER writes the database (premise of all the above)',
	!/\bINSERT\b|\bUPDATE\b|\bDELETE\b|withTx\(/i.test(tailer),
	'if the fast path can write, a reorg can corrupt state and the opt-out has to come back'
);

console.log(`\n${'─'.repeat(54)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} fastpath-always-on checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed}/${passed + failed} fastpath-always-on checks failed`);
	process.exit(1);
}
