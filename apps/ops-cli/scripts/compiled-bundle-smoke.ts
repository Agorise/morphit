/**
 * ops-cli compiled-bundle smoke (cp162).
 *
 * Proves the executable guarantee that cp162 exists to provide:
 * the esbuild bundle builds and runs under PLAIN `node` with no
 * tsx, and the launcher shim selects the compiled path when the
 * bundle is present.  This is the runtime counterpart to
 * install-invariants-smoke (which checks the static contract).
 *
 * Scenarios:
 *   1. `npm run build` produces dist/main.js.
 *   2. dist/main.js has EXACTLY ONE shebang, and it is the node
 *      shebang (the cp162 double-shebang bug regression guard).
 *   3. dist/main.js runs under plain `node --help` (exit 0, prints
 *      the usage banner) — no tsx involved.
 *   4. `pg` is left external (imported, not inlined) — bundling
 *      the Postgres driver is fragile.
 *   5. The cross-workspace source IS inlined (keyEnvelope's
 *      decryptEnvelope + feeAmountCalc's computeFeeAmounts present
 *      in the bundle) — proving the bundler resolved the
 *      rootDir-escaping imports that blocked a plain tsc build.
 *   6. The launcher shim, run with dist present, executes the
 *      compiled path (not the tsx fallback).
 *
 * This smoke BUILDS as a side effect (idempotent) so CI always
 * exercises a fresh bundle.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distEntry = resolve(pkgRoot, 'dist/main.js');
const shim = resolve(pkgRoot, 'bin/morphit-ops.mjs');

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

/* ---------------- scenario 1: build produces dist/main.js ---------------- */

const buildRes = spawnSync(process.execPath, [resolve(pkgRoot, 'scripts/build.mjs')], {
	cwd: pkgRoot,
	encoding: 'utf8',
	timeout: 120_000
});
if (buildRes.status === 0 && existsSync(distEntry)) {
	pass('`node scripts/build.mjs` produces dist/main.js');
} else {
	fail(
		'build produces dist/main.js',
		`build exit=${buildRes.status}; stderr=${(buildRes.stderr ?? '').slice(0, 400)}`
	);
}

/* ---------------- scenario 2: exactly one node shebang ---------------- */

let distSrc = '';
try {
	distSrc = readFileSync(distEntry, 'utf8');
} catch {
	distSrc = '';
}
const lines = distSrc.split('\n');
const shebangCount = lines.filter((l) => l.startsWith('#!')).length;
const firstLine = lines[0] ?? '';
// The cp162 double-shebang bug: esbuild preserved the source's
// `#!/usr/bin/env -S npx tsx` AND a banner added a node shebang,
// yielding two shebangs and a SyntaxError.  Guard against it.
if (shebangCount === 1 && firstLine === '#!/usr/bin/env node') {
	pass('dist/main.js has exactly one shebang, and it is the node shebang');
} else {
	fail(
		'dist/main.js has exactly one node shebang (double-shebang regression guard)',
		`shebangCount=${shebangCount} firstLine=${JSON.stringify(firstLine)}; the source tsx shebang must be stripped and replaced with a single "#!/usr/bin/env node"`
	);
}

/* ---------------- scenario 3: runs under plain node ---------------- */

const runRes = spawnSync(process.execPath, [distEntry, '--help'], {
	encoding: 'utf8',
	timeout: 30_000
});
if (runRes.status === 0 && /morphit-ops/.test(runRes.stdout ?? '')) {
	pass('dist/main.js runs under plain node (--help exits 0, prints usage) — no tsx');
} else {
	fail(
		'dist/main.js runs under plain node',
		`exit=${runRes.status}; stdout=${(runRes.stdout ?? '').slice(0, 200)}; stderr=${(runRes.stderr ?? '').slice(0, 300)}`
	);
}

/* ---------------- scenario 4: pg stays external ---------------- */

// The bundle should import("pg") / require("pg") rather than
// inlining the driver source.  A telltale of inlining would be
// pg's internal identifiers; the clean signal is an external
// import reference to the bare specifier.
if (/["']pg["']/.test(distSrc) && !/Client\.prototype\.connect = function/.test(distSrc)) {
	pass('pg is left external (imported, not inlined)');
} else {
	fail(
		'pg is left external',
		'expected a bare "pg" import reference and no inlined pg driver source — pg must stay a runtime dependency'
	);
}

/* ---------------- scenario 5: cross-workspace source is inlined ---------------- */

const hasKeyEnvelope = /decryptEnvelope/.test(distSrc);
const hasFeeCalc = /computeFeeAmounts/.test(distSrc);
if (hasKeyEnvelope && hasFeeCalc) {
	pass('cross-workspace source inlined (keyEnvelope.decryptEnvelope + feeAmountCalc.computeFeeAmounts present)');
} else {
	fail(
		'cross-workspace source is inlined',
		`decryptEnvelope=${hasKeyEnvelope} computeFeeAmounts=${hasFeeCalc}; the bundler must inline the rootDir-escaping cross-workspace imports that blocked a plain tsc build`
	);
}

/* ---------------- scenario 6: shim selects the compiled path when dist present ---------------- */

// With dist present, the shim should run the compiled bundle under
// node.  We can't easily observe WHICH path it took from outside,
// but we can confirm the shim runs successfully + the shim source
// prefers dist when existsSync(distEntry).
const shimSrc = existsSync(shim) ? readFileSync(shim, 'utf8') : '';
const shimPrefersDist =
	/existsSync\(distEntry\)/.test(shimSrc) && /process\.execPath/.test(shimSrc);
const shimRun = spawnSync(process.execPath, [shim, '--help'], {
	encoding: 'utf8',
	timeout: 30_000
});
if (shimPrefersDist && shimRun.status === 0 && /morphit-ops/.test(shimRun.stdout ?? '')) {
	pass('launcher shim prefers compiled dist when present and runs successfully');
} else {
	fail(
		'launcher shim prefers compiled dist + runs',
		`shimPrefersDist=${shimPrefersDist} exit=${shimRun.status} stdout=${(shimRun.stdout ?? '').slice(0, 150)}`
	);
}

/* ------ scenario 7: bundle can EVALUATE the dblurt broadcast dep (cp178) ------ */

// cp178 regression guard.  The bundle is ESM but @beblurt/dblurt (via
// cross-fetch → node-fetch) does CommonJS `require('stream')` at
// module-eval time.  Without the createRequire banner in build.mjs,
// esbuild's `__require` shim throws "Dynamic require of 'stream' is
// not supported" the moment `register` does `await import(...)` — and
// the old catch mis-reported it as "@beblurt/dblurt is not installed".
// We drive `register` with a syntactically-plausible-but-bogus key and
// dummy env: it must get PAST the import (reaching a key/RPC error),
// never a dependency-load error.  This proves dblurt evaluates inside
// the bundle under plain node.
{
	const fakeKey = resolve(pkgRoot, 'dist', '.dblurt-eval-test.key');
	try {
		writeFileSync(fakeKey, '5JfakefakefakefakefakefakefakefakefakefakefakefakeFAKE\n');
	} catch {
		/* ignore */
	}
	const regRun = spawnSync(process.execPath, [distEntry, 'register'], {
		encoding: 'utf8',
		timeout: 60_000,
		input: 'y\nN\n',
		env: {
			...process.env,
			MORPHIT_RELAY_ACCOUNT: 'bundle-eval-test',
			MORPHIT_RELAY_ACTIVE_KEY_FILE: fakeKey,
			MORPHIT_INSTANCE_NAME: 'Bundle Eval Test',
			MORPHIT_INSTANCE_ORIGIN: 'https://bundle-eval-test.example',
			MORPHIT_INSTANCE_OPERATOR_TAG: 'bundle-eval-test.example'
		}
	});
	try {
		unlinkSync(fakeKey);
	} catch {
		/* ignore */
	}
	const out = `${regRun.stdout ?? ''}\n${regRun.stderr ?? ''}`;
	const sawRequireError = /Dynamic require of|is not supported/i.test(out);
	const sawNotInstalled = /is not installed|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(out);
	// It SHOULD have reached the broadcast/key stage (a key or RPC
	// error), proving the import resolved + evaluated.
	const reachedBroadcast = /broadcast failed|network|rpc|posting authority|private key/i.test(out);
	if (!sawRequireError && !sawNotInstalled && reachedBroadcast) {
		pass('bundle evaluates @beblurt/dblurt (no Dynamic-require / not-installed; reaches broadcast)');
	} else {
		fail(
			'bundle evaluates @beblurt/dblurt',
			`sawRequireError=${sawRequireError} sawNotInstalled=${sawNotInstalled} ` +
				`reachedBroadcast=${reachedBroadcast}; out=${out.slice(0, 400)}`
		);
	}
}

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
	} else {
		console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
		if (r.detail) console.log('      ' + r.detail);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
	process.exit(1);
} else {
	console.log('✓ all ' + results.length + ' scenarios passed');
}
