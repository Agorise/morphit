/**
 * ops-bridge-scripts-smoke — no one-off live-patch script ships in ops/.
 *
 * History. `ops/` used to carry sixteen one-off scripts written during live
 * debugging sessions (v1.12.x relay-health, federation, the morphitlat
 * canary). They travelled in every release, in /opt/morphit/ops, long after the
 * fixes they bridged had shipped. Run on a current release they did harm
 * (v1.20.0 deep review, C5/C6), for example:
 *   - relay-updown-proof.sh swapped the indexer's relay probe for an old
 *     true/false version: a HEALTHY relay then read {"up":false} and its
 *     hidden_only posture was dropped, until the script restored it (no trap);
 *   - relay-runtime-debug.sh / relay-filelog-debug.sh made /v1/health lose the
 *     relay `up` key and printed "up=true" for a relay that was down;
 *   - fix-stale-indexer.sh chose processes to kill host-wide by command-line
 *     pattern and always printed "The stale orphan was the whole problem";
 *   - the canary fix scripts deleted the served canary before re-signing and
 *     then said "last good canary still served".
 * They were deleted in v1.20.0. (v1.18.0 had only guarded the two apply-*-fix
 * scripts; that version of this smoke covered just those two.)
 *
 * This smoke keeps them gone:
 *   A. none of the deleted scripts exists anywhere under ops/;
 *   B. no ops/ shell script edits application source in place — a script that
 *      runs an interpreter (python3/perl/sed -i) AND names an apps/<app>/src
 *      path is exactly the live-patch shape. The detector is proven on a
 *      synthetic patcher and a benign script first, so a broken detector can't
 *      pass the scan vacuously.
 *
 * Override the tree with MORPHIT_OPS_BRIDGE_DIR=<some>/ops to watch it fail on
 * an older release.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPS = process.env.MORPHIT_OPS_BRIDGE_DIR ?? join(REPO, 'ops');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const DELETED = [
	'apply-relay-fix.sh',
	'apply-federation-fix.sh',
	'relay-updown-proof.sh',
	'relay-runtime-debug.sh',
	'relay-filelog-debug.sh',
	'find-live-file.sh',
	'fix-stale-indexer.sh',
	'relay-refresh-trace.sh',
	'relay-snapshot-diag.sh',
	'diag-relay.sh',
	'show-indexer-runtime.sh',
	'relay-health-fix.sh',
	'cleanup-relay-debug.sh',
	'fix-canary-tor.sh',
	'fix-canary-tor2.sh',
	'canary-fix-all.sh'
];

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

/** Comment-stripped shell text: a live patcher is identified by what it RUNS,
 *  not by a comment that mentions a path. */
function codeOf(text: string): string {
	return text
		.split('\n')
		.filter((l) => !/^\s*#/.test(l))
		.join('\n');
}

/** Does this shell script edit application source in place? */
export function isSourcePatcher(text: string): boolean {
	const code = codeOf(text);
	const runsEditor =
		/\bpython3?\b/.test(code) ||
		/\bperl\s+-[a-z]*i/.test(code) ||
		/\bsed\s+(-[a-zA-Z]*\s+)*-i/.test(code);
	// apps/<app>/src named directly, or an apps/<app> dir variable joined to /src.
	const namesAppSrc =
		/apps\/[a-z0-9-]+\/src\b/.test(code) ||
		(/apps\/[a-z0-9-]+["'}]?(\s|$|["'])/m.test(code) &&
			/\/src\/[A-Za-z0-9_./-]+\.(ts|js|svelte)\b/.test(code));
	return runsEditor && namesAppSrc;
}

// ── Detector self-test (so the scan below can't pass vacuously) ──
const syntheticPatcher = [
	'#!/usr/bin/env bash',
	'IDXDIR="${IDXDIR:-/opt/morphit/apps/indexer}"',
	'OH="$IDXDIR/src/api/operationalHealth.ts"',
	'python3 - "$OH" <<\'PY\'',
	'print(1)',
	'PY'
].join('\n');
const benign = [
	'#!/usr/bin/env bash',
	'# edits apps/indexer/src/x.ts? no — this comment must not count',
	'python3 -c "import json,sys; print(json.load(sys.stdin))"',
	'"$TSX" apps/indexer/scripts/snapshot-export.ts'
].join('\n');
check(
	'detector flags a synthetic live patcher (python3 + apps/<app>/src)',
	isSourcePatcher(syntheticPatcher)
);
check(
	'detector does not flag a benign script (JSON-only python3, apps/*/scripts)',
	!isSourcePatcher(benign)
);

// ── A. the deleted scripts stay deleted ──
const files = walk(OPS);
const byBase = new Map<string, string[]>();
for (const f of files) {
	const base = f.split('/').pop() ?? '';
	byBase.set(base, [...(byBase.get(base) ?? []), relative(REPO, f)]);
}
for (const name of DELETED) {
	const found = byBase.get(name) ?? [];
	check(`${name} is not shipped`, found.length === 0, found.join(', '));
}

// ── B. no shipped ops script patches application source ──
const patchers = files
	.filter((f) => f.endsWith('.sh') && !f.includes('/ops/test/'))
	.filter((f) => isSourcePatcher(readFileSync(f, 'utf8')))
	.map((f) => relative(REPO, f));
check('no ops/ shell script edits apps/*/src in place', patchers.length === 0, patchers.join(', '));

console.log(
	fail === 0
		? `\n✓ all ${pass} ops-bridge-scripts checks passed`
		: `\n✗ ops-bridge-scripts: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
