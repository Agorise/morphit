#!/usr/bin/env tsx
/**
 * apps/web/scripts/focus-scrim-guard-execution-smoke.ts
 *
 * Runs ops/test/focus-scrim-guard-harness.sh, which puts the "focus opens a
 * full-page blur scrim" bug BACK, one variant at a time, and requires
 * focus-opens-scrim-smoke.ts to fail on each.
 *
 * This exists because the guard it tests is itself a response to guards that
 * guarded nothing. The bug's first fix was accompanied by an exact-string grep
 * over the sibling components, which pronounced them clean; two of them had the
 * bug — one spread over several lines, one behind a named function where the
 * handler attribute looks completely ordinary. A guard nobody has watched fail
 * is indistinguishable from a comment.
 *
 * The harness is hermetic: it mutates a COPY of apps/web in a temp dir, so it
 * can neither leave a mutation in the tree nor be affected by one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..', '..', '..');
const harness = join(repo, 'ops', 'test', 'focus-scrim-guard-harness.sh');

if (!existsSync(harness)) {
	console.error(`✗ focus-scrim guard harness missing at ${harness}`);
	process.exit(1);
}

const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 300_000 });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
process.stdout.write(out);

if (r.status !== 0) {
	console.error(
		'\n✗ focus-scrim guard harness FAILED — a mutation survived, so the guard is not guarding.'
	);
	process.exit(1);
}

// A harness that quietly stopped mutating would otherwise pass by doing nothing.
const checks = (out.match(/✓/g) ?? []).length;
if (checks < 6) {
	console.error(`\n✗ harness reported only ${checks} checks — it is not exercising the guard.`);
	process.exit(1);
}
// Battery convention: plain ASCII, starts with "✓ all ", no ANSI escapes.
console.log(`✓ all ${checks} focus-scrim guard-execution checks passed`);
