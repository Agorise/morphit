#!/usr/bin/env tsx
/**
 * Smoke: the canary timestamp parser is implemented twice, and the two copies
 * must never disagree (cp442).
 *
 *   • `scripts/canary/verify.ts`      — the operator-facing verifier CLI
 *   • `apps/ops-cli/src/canaryTime.ts` — used by `morphit-ops` health
 *
 * They can't share a module: the root workspace is CommonJS and ops-cli is ESM,
 * so a named import across that boundary fails at runtime. So they're kept in
 * lockstep here instead.
 *
 * Why this matters: the canary's freshness IS the security signal. If health
 * reads a stamp as local time while the verifier reads it as UTC, an operator's
 * dead-man's switch quietly acquires an hours-wide blind spot. If one accepts a
 * typo'd month as a real date, a canary that should read `unparsable` reads
 * `fresh` instead.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCanaryTimestamp } from '../src/canaryTime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const verifySrc = readFileSync(join(REPO, 'scripts', 'canary', 'verify.ts'), 'utf8');
const opsSrc = readFileSync(join(__dirname, '..', 'src', 'canaryTime.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

/** Pull a regex literal's source out of a TS file by a nearby anchor. */
function humanRegexOf(src: string): string | null {
	const m = /\/\^\(\\d\{1,2\}\)[^\n]*?\/(?=[.;\s])/.exec(src);
	return m ? m[0] : null;
}
function isoRegexOf(src: string): string | null {
	const m = /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}T[^\n]*?\/(?=\.test)/.exec(src);
	return m ? m[0] : null;
}

// ─── the two implementations are textually identical where it counts ──
const hVerify = humanRegexOf(verifySrc);
const hOps = humanRegexOf(opsSrc);
check('both files define the human-stamp regex', hVerify !== null && hOps !== null);
check('the human-stamp regex is IDENTICAL in both', hVerify === hOps);

const iVerify = isoRegexOf(verifySrc);
const iOps = isoRegexOf(opsSrc);
check('both files define the strict ISO guard', iVerify !== null && iOps !== null);
check('the strict ISO guard is IDENTICAL in both', iVerify === iOps);

check('neither falls back to a bare Date.parse of arbitrary text', !/return Date\.parse\(s\);\s*\n\}/.test(verifySrc) && !/return Date\.parse\(s\);\s*\n\}/.test(opsSrc));
check('both list all twelve months', (opsSrc.match(/'(january|december)'/g) ?? []).length === 2 && /december/.test(verifySrc));

// ─── behaviour (run against the ops-cli copy) ────────────────────────
const cases: [string, string | 'NaN'][] = [
	['30 June, 2026 @ 16:45:18 UTC', '2026-06-30T16:45:18.000Z'],
	['1 January, 2027 @ 00:00:00 UTC', '2027-01-01T00:00:00.000Z'],
	['2026-07-22T23:45:18Z', '2026-07-22T23:45:18.000Z'],
	['2026-07-22T23:45:18.123Z', '2026-07-22T23:45:18.123Z'],
	// must NOT be guessed:
	['2026-07-22 23:45:18', 'NaN'], // local-time ambiguity
	['22 Julius, 2026 @ 23:45:18 UTC', 'NaN'], // typo'd month
	['{{GENERATED_AT_ISO}}', 'NaN'], // un-substituted template
	['22 July, 2026 @ 23:45:18', 'NaN'], // no UTC suffix
	['', 'NaN']
];
for (const [input, want] of cases) {
	const got = parseCanaryTimestamp(input);
	const ok = want === 'NaN' ? Number.isNaN(got) : new Date(got).toISOString() === want;
	check(`parses ${JSON.stringify(input)} -> ${want}`, ok);
}

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} canary-timestamp-parity scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} canary-timestamp-parity checks FAILED`);
	process.exit(1);
}
