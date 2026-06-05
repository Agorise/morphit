#!/usr/bin/env tsx
/**
 * fetch-must-have-timeout smoke — Part 122 cp71 (LL #73 / O-21).
 *
 * `await fetch(url)` without an AbortController + timeout hangs
 * indefinitely if the remote endpoint is slow or unresponsive.
 * cp70-D5 and cp70-D6 both fell into this trap (ops-cli/upgrade.ts
 * and stores/chainFee.ts). The pattern is used CORRECTLY in 7+
 * other places; these were drift.
 *
 * This smoke walks all .ts source files and flags `fetch(` calls
 * that lack a timeout.  A fetch is considered guarded when:
 *
 *   • The same line OR a nearby line (within ~10 lines) creates
 *     an `AbortController()` whose `.signal` is passed to the
 *     fetch via the `signal:` option, OR
 *   • The fetch is inside a function whose name suggests it's a
 *     server-side resource that explicitly wants long-lived
 *     fetches (allow_listed), OR
 *   • The fetch is inside a Service Worker context, where the
 *     browser manages the timeout via the request's own signal.
 *
 * cp70-D5/D6 reference fixes:
 *   - apps/ops-cli/src/commands/upgrade.ts: UPGRADE_FETCH_TIMEOUT_MS = 30_000
 *   - apps/web/src/lib/stores/chainFee.ts:  10s AbortController in try/finally
 *
 * Mutation test M-144: add `await fetch('https://example.com')`
 * (no signal) to any .ts file → smoke fires.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── fetch-must-have-timeout smoke (cp71 LL #73 / O-21) ──\n');

function walkTs(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry === '.svelte-kit' || entry === 'dist' || entry === 'test' || entry === '.vite' || entry === 'historical') continue;
			walkTs(full, out);
		} else if (entry.endsWith('.ts') || entry.endsWith('.svelte')) {
			out.push(full);
		}
	}
}

const ALLOW_LIST = new Set<string>([
	// File + reason — allow-list intentional fetches where a timeout
	// would harm UX (e.g. SW retry-on-network-restore, EventSource
	// open which has its own keepalive).
	// Format: relpath:lineHint (line is approximate, just for human ref).
	'apps/web/src/service-worker.ts:150', // navigation/asset fetch in the SW fetch handler — browser manages the timeout via the request's own signal; a blanket AbortController would prematurely 503 a slow-but-working asset (cp199's cleanRedirect shifted this from line 127)
	// fetchWithTimeout itself wraps fetch() — the signal it adds IS
	// the timeout, but the smoke can't see that the `signal` variable
	// it passes was just constructed from an AbortController.
	'apps/web/src/lib/net/fetchWithTimeout.ts:60',
]);

const tsFiles: string[] = [];
for (const root of [
	'apps/indexer/src',
	'apps/relay/src',
	'apps/web/src',
	'apps/ops-cli/src',
	'apps/matrix-bot/src',
	'packages'
]) {
	try {
		walkTs(join(REPO_ROOT, root), tsFiles);
	} catch {
		// missing dir; skip
	}
}

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly context: string;
}

const findings: Finding[] = [];
let totalFetches = 0;

for (const file of tsFiles) {
	const src = readFileSync(file, 'utf-8');
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Match `fetch(` but not method calls like `obj.fetch(` or
		// `prefetch(`, `crossFetch(`, etc.  Require the preceding char
		// to NOT be a word char or dot — so `await fetch(`, `=fetch(`,
		// `return fetch(` match but `up.fetch(` doesn't.
		if (!/(?:^|[^a-zA-Z0-9_$.])fetch\s*\(/.test(line)) continue;
		// Skip type-only / interface lines
		if (/^(\s*\*|\s*\/\/|\s*\/\*)/.test(line)) continue;
		// Skip identifier definitions
		if (/^\s*(function|const|let|var|type|interface)\s+\w*[Ff]etch/.test(line)) continue;
		totalFetches++;

		// Look at this line + next 16 lines for `signal:` option
		// (fetch options can span multiple lines, especially for POSTs
		// with body / headers).
		const windowLines = lines.slice(i, Math.min(lines.length, i + 16)).join('\n');
		const hasSignal = /signal\s*:/.test(windowLines);
		if (hasSignal) continue;

		// Look at this line + previous 10 lines for AbortController
		// definition (the controller might be hoisted into a helper)
		const prevWindow = lines.slice(Math.max(0, i - 15), i + 1).join('\n');
		const hasAbortController = /new AbortController\(/.test(prevWindow) || /AbortSignal\.timeout\(/.test(prevWindow);
		if (hasAbortController && /signal[\s:]/.test(prevWindow)) continue;

		// Check allow-list
		const relPath = file.replace(REPO_ROOT + '/', '');
		let allowed = false;
		for (const entry of ALLOW_LIST) {
			const [allowPath, allowLineStr] = entry.split(':');
			if (relPath !== allowPath) continue;
			const allowLine = Number(allowLineStr);
			if (Math.abs((i + 1) - allowLine) <= 5) {
				allowed = true;
				break;
			}
		}
		if (allowed) continue;

		findings.push({
			file: relPath,
			line: i + 1,
			context: line.trim().slice(0, 200)
		});
	}
}

console.log(`▸ scanned ${tsFiles.length} .ts/.svelte files; found ${totalFetches} fetch() call(s)`);
console.log(`  ${findings.length} appear to lack an AbortController+timeout.\n`);

for (const f of findings) {
	fail(
		`${f.file}:${f.line} fetch() has an AbortController timeout`,
		`${f.context}\n      Add: \`const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), TIMEOUT_MS); try { await fetch(url, { signal: ac.signal }); } finally { clearTimeout(timer); }\``
	);
}

if (findings.length === 0) {
	pass(`all ${totalFetches} fetch() sites have an AbortController+timeout (or are explicitly allow-listed)`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nfetch-must-have-timeout smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} fetch-must-have-timeout scenarios passed`);
