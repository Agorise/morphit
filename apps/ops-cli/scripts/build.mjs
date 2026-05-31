/**
 * ops-cli production build (cp162).
 *
 * Bundles the operator CLI into a single self-contained
 * `dist/main.js` with a Node shebang, so the published `bin`
 * points at runnable JavaScript and the runtime no longer
 * depends on `tsx`.  This closes the cp161 root cause for good:
 * the operator's `morphit-ops init` runs under plain `node`,
 * with no source-transpilation step at invocation time.
 *
 * Why bundle (esbuild) rather than plain `tsc` like mcp-server:
 * ops-cli has two structural traits that make a clean `tsc`
 * emit impractical —
 *   1. ~92 `.ts`-extension import specifiers across 24 files
 *      (the tsx-source-run model; `allowImportingTsExtensions`
 *      requires `noEmit`, so tsc can't emit them as-is).
 *   2. Two cross-workspace reaches that escape ops-cli's
 *      `rootDir: src` —
 *        - apps/relay/src/crypto/keyEnvelope.ts (static + dynamic)
 *        - apps/indexer/src/lib/feeAmountCalc.ts (static)
 *      plus the `@morphit/operator-config` workspace package,
 *      which is itself source-only (main: src/index.ts).
 *
 * A bundler inlines all of that into one file, resolving the
 * `.ts` extensions and the cross-workspace source at build time
 * — touching only this workspace.  Single-file bundling is the
 * standard ship strategy for a Node CLI anyway.
 *
 * Externals (NOT bundled — resolved from node_modules at runtime):
 *   - `pg` — the Postgres driver; a real npm dependency with its
 *     own internal requires + optional native bits.  Bundling it
 *     is fragile; it stays a production dependency and is required
 *     normally at runtime.
 *   - `node:*` builtins — never bundled.
 *
 * Everything else (ops-cli source + keyEnvelope + feeAmountCalc
 * + operator-config) is inlined.
 *
 * The output keeps a `#!/usr/bin/env node` shebang via the
 * banner, matching apps/mcp-server/dist/main.js.
 */

import { build } from 'esbuild';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const outfile = resolve(root, 'dist/main.js');

await build({
	entryPoints: [resolve(root, 'src/main.ts')],
	outfile,
	bundle: true,
	platform: 'node',
	// Node 22 is the floor (engines.node >=22.0.0); target its V8.
	target: 'node22',
	format: 'esm',
	// Keep these resolved from node_modules at runtime, not inlined.
	external: ['pg'],
	// cp178 — CRITICAL ESM/CJS interop fix.  We bundle to `format:
	// 'esm'`, but several inlined deps are CommonJS and call
	// `require(...)` at module-eval time — notably the broadcast
	// path's @beblurt/dblurt → cross-fetch → node-fetch, which does
	// `require('stream')`.  esbuild replaces `require` in an ESM
	// bundle with a `__require` shim that THROWS ("Dynamic require of
	// 'stream' is not supported") for Node builtins unless a real
	// `require` exists in scope.  Without this banner the operator's
	// `register` step dies at `await import('@beblurt/dblurt')` with a
	// require error that the catch-block then mis-reports as "dblurt
	// is not installed" — un-fixable by reinstalling, since the
	// package IS installed; the bundle just can't evaluate it.  The
	// `createRequire(import.meta.url)` banner gives the bundle a real
	// CJS `require`, so `__require` falls through to it for builtins.
	// This is esbuild's documented ESM-output interop pattern.
	// NOTE: the banner is plain JS (no leading `#!`), so it does NOT
	// interfere with the shebang handling below — esbuild emits the
	// entry's own shebang FIRST, then this banner; the post-process
	// strips that first shebang line and prepends the Node one,
	// leaving the banner intact.
	banner: {
		js: "import { createRequire as __ops_createRequire } from 'node:module';\nimport { fileURLToPath as __ops_fileURLToPath } from 'node:url';\nimport { dirname as __ops_dirname } from 'node:path';\nconst require = __ops_createRequire(import.meta.url);\nconst __filename = __ops_fileURLToPath(import.meta.url);\nconst __dirname = __ops_dirname(__filename);"
	},
	// NOTE: we deliberately do NOT use esbuild's `banner` for the
	// shebang.  esbuild preserves the entry file's own leading
	// shebang (`#!/usr/bin/env -S npx tsx` in src/main.ts — kept
	// for the dev/tsx-source run path), so a banner shebang would
	// produce TWO shebang lines and an "Invalid or unexpected
	// token" at runtime.  Instead we strip any leading shebang
	// from the bundled output and prepend exactly one Node shebang
	// in the post-process step below.
	sourcemap: true,
	// Minification off: operator-facing tool, readable stack traces
	// matter more than a few KB.
	minify: false,
	logLevel: 'info'
});

// Post-process: guarantee exactly one shebang, and make it the
// Node one.  The bundled output may begin with the source file's
// `#!/usr/bin/env -S npx tsx` shebang (esbuild preserves it); the
// runtime artifact must instead run under plain `node`.
const NODE_SHEBANG = '#!/usr/bin/env node';
let code = readFileSync(outfile, 'utf8');
if (code.startsWith('#!')) {
	// Drop the existing first-line shebang (whatever it is).
	const nl = code.indexOf('\n');
	code = nl === -1 ? '' : code.slice(nl + 1);
}
code = NODE_SHEBANG + '\n' + code;
writeFileSync(outfile, code);

// Ensure the output is executable (the bin symlink invokes it).
chmodSync(outfile, 0o755);

console.log(`✓ ops-cli bundled → ${outfile}`);
