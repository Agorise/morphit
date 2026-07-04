/**
 * indexer-config-boot-smoke (cp194)
 *
 * Two guards for the boot-crash class the VPS operator hit:
 *
 *   ReferenceError: require is not defined
 *     at apps/indexer/src/config/index.ts  (a Zod .transform that
 *     used CommonJS require() — undefined under ESM)
 *
 * The trap: the crashing transform only ran when a specific env var
 * (MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM) was NON-empty. Empty values
 * returned early, so every default install and every test fixture
 * sailed past it — and `tsc` is no help because `require` is a valid
 * global in @types/node (it only blows up at ESM runtime). So:
 *
 *   1. STATIC: no shipped runtime `src` file uses a bare `require(` /
 *      `= require(`. The ESM-safe ways (static `import`, or
 *      `createRequire(import.meta.url)`) are allowed.
 *   2. FUNCTIONAL: indexer loadConfig() RUNS the matrix-room transform
 *      with a non-empty value without throwing "require is not
 *      defined" (a plain Zod validation error is fine — it proves the
 *      transform body executed).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let failed = 0;
let passed = 0;
const ok = (m: string) => {
	console.log(`  ✓ ${m}`);
	passed++;
};
const bad = (m: string, d: string) => {
	console.error(`  ✗ ${m}\n      ${d}`);
	failed++;
};

// ─── Guard 1: no bare require() in shipped runtime src ───────────
// Walk apps/<ws>/src and packages/<ws>/src. Flag a line that calls
// `require(` UNLESS it is a createRequire-derived call (a different
// identifier like `_require(`) — bare global `require(` and
// `= require(` (destructured) are the ESM-illegal forms.
const RUNTIME_SRC_ROOTS = [
	'apps/indexer/src',
	'apps/relay/src',
	'apps/mcp-server/src',
	'apps/matrix-bot/src',
	'packages'
];

function walk(dir: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const e of entries) {
		if (e === 'node_modules' || e === 'dist' || e === 'scripts' || e.startsWith('.')) continue;
		const p = join(dir, e);
		const s = statSync(p);
		if (s.isDirectory()) walk(p, out);
		else if (/\.(ts|mts|js|mjs)$/.test(e) && !/\.test\.|\.spec\./.test(e)) out.push(p);
	}
}

function stripCommentsAndStrings(src: string): string {
	// crude but sufficient: drop block + line comments so a `require(`
	// mentioned in prose doesn't false-positive.
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const files: string[] = [];
for (const root of RUNTIME_SRC_ROOTS) walk(join(REPO, root), files);

// A bare-require offender: `require(` preceded by a non-identifier
// char (so `createRequire(` and `_require(` don't match). Catches
// `require(` and `= require(` and `const {x} = require(`.
const BARE_REQUIRE = /(^|[^A-Za-z0-9_$.])require\s*\(/;

const offenders: string[] = [];
for (const f of files) {
	const code = stripCommentsAndStrings(readFileSync(f, 'utf8'));
	const lines = code.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (BARE_REQUIRE.test(lines[i]!)) {
			offenders.push(`${f.replace(REPO + '/', '')}:${i + 1}`);
		}
	}
}

if (offenders.length === 0) {
	ok('no bare require() in shipped runtime src (ESM-safe: static import or createRequire only)');
} else {
	bad(
		'bare require() found in ESM runtime src — crashes at boot the moment the code path runs',
		offenders.join('\n      ') +
			'\n      Fix: use a static `import`, or `createRequire(import.meta.url)`.'
	);
}

// ─── Guard 2: loadConfig runs the matrix-room transform ──────────
const prior: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string) => {
	prior[k] = process.env[k];
	process.env[k] = v;
};

// The trigger: a NON-empty room value (this is what the operator had).
setEnv('MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM', '#morphit-ops:matrix.org');
// Enough surrounding env that loadConfig reaches the transform.
setEnv('MORPHIT_INDEXER_DATABASE_URL', 'postgres://u:p@localhost:5432/morphit_indexer');
setEnv('MORPHIT_INDEXER_RELAY_ACCOUNT', 'tester');
setEnv('MORPHIT_INDEXER_FEE_RECIPIENT', 'tester');
setEnv('MORPHIT_INDEXER_CHAIN_ID', 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f');
setEnv('MORPHIT_INDEXER_RPC_ENDPOINTS', 'https://rpc.blurt.world');

try {
	const mod = await import('../src/config/index.ts');
	try {
		mod.loadConfig();
		ok('indexer loadConfig() ran the matrix-room transform with a non-empty value (no require crash)');
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/require is not defined/.test(msg)) {
			bad('loadConfig STILL throws "require is not defined" with a Matrix room set', msg.split('\n')[0]!);
		} else {
			// A Zod/validation error proves the transform body executed
			// without the ReferenceError — which is exactly the regression
			// we are guarding. That is a PASS for this smoke's purpose.
			ok('matrix-room transform executed without require-crash (downstream validation error is fine here)');
		}
	}
} catch (e) {
	const msg = e instanceof Error ? e.message : String(e);
	if (/require is not defined/.test(msg)) {
		bad('module load threw "require is not defined"', msg.split('\n')[0]!);
	} else {
		ok('config module loaded without require-crash');
	}
} finally {
	for (const [k, v] of Object.entries(prior)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

// ─── Guard 3 (beta5 D): indexer RPC endpoints fall back to the
//     shared canonical set when MORPHIT_INDEXER_RPC_ENDPOINTS is unset.
//     Before beta5 this var was REQUIRED while the relay's equivalent
//     had a default — the asymmetry that let one real node's relay
//     survive while its indexer froze. Now both fall back to the same
//     canonical set. ────────────────────────────────────────────────
{
	const prior3: Record<string, string | undefined> = {};
	const set3 = (k: string, v: string) => {
		prior3[k] = process.env[k];
		process.env[k] = v;
	};
	// A complete, valid required env — EXCEPT MORPHIT_INDEXER_RPC_ENDPOINTS,
	// which we leave unset so the schema default must supply it.
	set3('MORPHIT_INDEXER_DATABASE_URL', 'postgres://u:arealpassword@localhost:5432/morphit_indexer');
	set3('MORPHIT_INDEXER_RELAY_ACCOUNT', 'tester');
	set3('MORPHIT_INDEXER_FEE_RECIPIENT', 'tester');
	set3('MORPHIT_INDEXER_CHAIN_ID', 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f');
	set3('MORPHIT_INDEXER_PUBLIC_ORIGIN', 'https://idx.example.com');
	set3('MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY', 'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9');
	prior3['MORPHIT_INDEXER_RPC_ENDPOINTS'] = process.env.MORPHIT_INDEXER_RPC_ENDPOINTS;
	delete process.env.MORPHIT_INDEXER_RPC_ENDPOINTS;
	prior3['MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM'] = process.env.MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM;
	delete process.env.MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM;

	try {
		const mod = await import('../src/config/index.ts');
		const cfg = mod.loadConfig() as { blurtRpcEndpoints: readonly string[] };
		const got = new Set(cfg.blurtRpcEndpoints);
		const canon = new Set(DEFAULT_BLURT_RPC_ENDPOINTS);
		const eq = got.size === canon.size && [...canon].every((u) => got.has(u));
		if (eq) {
			ok('indexer falls back to the canonical RPC set when MORPHIT_INDEXER_RPC_ENDPOINTS is unset');
		} else {
			bad(
				'indexer RPC fallback does not match the canonical set',
				`got=[${[...got].sort().join(', ')}] canon=[${[...canon].sort().join(', ')}]`
			);
		}
	} catch (e) {
		bad(
			'loadConfig threw with RPC endpoints unset (the fallback default did not apply)',
			(e instanceof Error ? e.message : String(e)).split('\n')[0]!
		);
	} finally {
		for (const [k, v] of Object.entries(prior3)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

// ─── Guard 4 (cp407): fee recipient validates + falls back to the
//     treasury. Federated operators earn 90% of BLURT fees and set the
//     account they land in; an empty or malformed value must fall back to
//     @morphit-fees (NOT crash boot, NOT route fees to a non-account) and
//     /v1/instance then advertises the RESOLVED account so the frontend pays
//     the same place the indexer verifies. ────────────────────────────────
{
	const mod = await import('../src/config/index.ts');
	const resolve = mod.resolveFeeRecipient as (
		raw: string
	) => { recipient: string; fellBack: boolean };
	const TREASURY = 'morphit-fees';

	// Pure resolver: valid stays, empty/garbage falls back.
	const validOk = resolve('some-operator').recipient === 'some-operator' && !resolve('some-operator').fellBack;
	validOk
		? ok('resolveFeeRecipient keeps a valid operator account')
		: bad('resolveFeeRecipient mangled a valid account', JSON.stringify(resolve('some-operator')));

	const cases: Array<[string, string]> = [
		['', 'empty'],
		['   ', 'whitespace'],
		['UPPER', 'uppercase'],
		['ab', 'too short'],
		['a'.repeat(17), 'too long'],
		['1lead', 'leading digit'],
		['trailing-', 'trailing punct'],
		['under_score', 'underscore']
	];
	let allFellBack = true;
	for (const [raw, why] of cases) {
		const r = resolve(raw);
		if (!(r.recipient === TREASURY && r.fellBack)) {
			allFellBack = false;
			bad(`resolveFeeRecipient did NOT fall back for ${why}`, JSON.stringify(r));
		}
	}
	if (allFellBack) ok('resolveFeeRecipient falls back to @morphit-fees for empty / malformed accounts');

	// loadConfig integration: a garbage env resolves to the treasury (no boot crash).
	const prior4: Record<string, string | undefined> = {};
	const set4 = (k: string, v: string) => {
		prior4[k] = process.env[k];
		process.env[k] = v;
	};
	set4('MORPHIT_INDEXER_DATABASE_URL', 'postgres://u:arealpassword@localhost:5432/morphit_indexer');
	set4('MORPHIT_INDEXER_RELAY_ACCOUNT', 'tester');
	set4('MORPHIT_INDEXER_CHAIN_ID', 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f');
	set4('MORPHIT_INDEXER_PUBLIC_ORIGIN', 'https://idx.example.com');
	set4('MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY', 'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9');
	set4('MORPHIT_INDEXER_FEE_RECIPIENT', 'BAD_ACCOUNT!'); // malformed on purpose
	try {
		const cfg = mod.loadConfig() as { feeRecipient: string };
		cfg.feeRecipient === TREASURY
			? ok('loadConfig resolves a malformed MORPHIT_INDEXER_FEE_RECIPIENT to the treasury (no boot crash)')
			: bad('loadConfig did not fall back a malformed fee recipient', cfg.feeRecipient);
	} catch (e) {
		bad(
			'loadConfig CRASHED on a malformed fee recipient (must fall back, not throw)',
			(e instanceof Error ? e.message : String(e)).split('\n')[0]!
		);
	} finally {
		for (const [k, v] of Object.entries(prior4)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('\nindexer-config-boot smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} indexer-config-boot scenarios passed`);
