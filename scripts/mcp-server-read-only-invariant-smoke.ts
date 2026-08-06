/**
 * mcp-server read-only invariant smoke (cp149).
 *
 * Locks in the cp148 walkthrough's load-bearing trust claim:
 * Charlie (the AI-agent persona invoking Morphit via the MCP
 * server) is read-only by construction.  The MCP server can
 * search orders, fetch listings, list instances, list payment
 * methods, and describe Morphit — but it cannot SIGN anything,
 * MUTATE any user state, BROADCAST any transaction, or HOLD
 * any keys.
 *
 * The cp148 walkthrough verified this inline with a grep over
 * `apps/mcp-server/src/`.  This smoke codifies that grep so
 * the property gets re-checked on every CI run.  If anyone
 * ever imports a signing primitive into the MCP server, that's
 * a major architectural shift requiring its own ADR — and this
 * smoke makes that shift impossible to land silently.
 *
 * Three invariants:
 *
 *   1. No signing-primitive imports in mcp-server source.
 *      Forbidden module specifiers + symbol names.  Walks
 *      every .ts file under apps/mcp-server/src/.
 *
 *   2. No mutation-API imports from the indexer/relay client
 *      packages.  `@morphit/indexer-client` and
 *      `@morphit/relay-client` both export READ-only helpers
 *      (buildV1Url, fetchJson) AND mutation helpers
 *      (postOrder, postFeedback, etc.).  The MCP server must
 *      only import the read-only ones.
 *
 *   3. The `fetchJson` callsite cardinality matches expectation.
 *      Every network call in apps/mcp-server/src/ must go through
 *      the centralized `fetchJson` from `indexerClient.ts`.  Raw
 *      `fetch(` in tool code would bypass the cp146 SSRF defenses
 *      (redirect:'manual', User-Agent, URL redaction).
 *
 * Together: Charlie's trust posture as documented in cp148
 * Persona 4 walkthrough is enforced by code, not just by
 * convention.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const MCP_SRC = join(REPO_ROOT, 'apps', 'mcp-server', 'src');

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

/* ---------------- walk apps/mcp-server/src/ ---------------- */

function walkTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			out.push(...walkTsFiles(full));
		} else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
			out.push(full);
		}
	}
	return out;
}

const mcpFiles = walkTsFiles(MCP_SRC);

if (mcpFiles.length === 0) {
	fail(
		'at least one .ts file in apps/mcp-server/src/',
		'walker found zero files — directory layout shifted?'
	);
}

/* ---------------- invariant 1: no signing primitives ---------------- */

/**
 * Each entry is a class of forbidden import.  We check both the
 * module specifier (the thing after `from '...'`) and the
 * imported symbol names.  Module-level matches are tighter; the
 * symbol-name matches catch transient re-exports or future
 * indirection.
 *
 * The list is intentionally conservative: anything that COULD be
 * a signing primitive even by name.  False positives are easy to
 * carve out by adding to the allowlist; false negatives (a
 * signing primitive sneaks in unnoticed) are the failure mode we
 * cannot tolerate.
 */
interface SigningPattern {
	module?: RegExp;
	symbol?: RegExp;
	label: string;
}

const SIGNING_PATTERNS: SigningPattern[] = [
	// Direct libsodium imports.  Morphit uses libsodium-wrappers
	// in apps/web (via @noble/curves abstraction) for all crypto.
	{ module: /^libsodium-wrappers(-sumo)?$/, label: 'libsodium' },
	{ symbol: /^sodium$/, label: 'libsodium symbol' },
	// secp256k1 / k256: used by @noble/curves for Blurt's
	// signing curve.  Should never appear in mcp-server.
	{ module: /^@noble\/curves(\/|$)/, label: '@noble/curves' },
	{ module: /^@noble\/secp256k1$/, label: '@noble/secp256k1' },
	{ module: /^secp256k1$/, label: 'secp256k1' },
	{ module: /^tiny-secp256k1$/, label: 'tiny-secp256k1' },
	// Blurt-js / dpay / steem-js families.  Any of these carry
	// signing helpers.
	{ module: /^@blurtfoundation\//, label: 'blurt SDK' },
	{ module: /^blurt-js$/, label: 'blurt-js' },
	{ module: /^dsteem$/, label: 'dsteem' },
	{ module: /^@steempro\//, label: 'steempro SDK' },
	// Internal Morphit signing primitives.  These all live in
	// apps/web/src/lib/crypto/ and are NEVER consumed outside
	// the web app.
	{ symbol: /^signTx$/, label: 'signTx' },
	{ symbol: /^signAuthored$/, label: 'signAuthored' },
	{ symbol: /^signPostingKey$/, label: 'signPostingKey' },
	{ symbol: /^signActiveKey$/, label: 'signActiveKey' },
	{ symbol: /^signMemoKey$/, label: 'signMemoKey' },
	{ symbol: /^signMemo$/, label: 'signMemo' },
	{ symbol: /^broadcastTransaction$/, label: 'broadcastTransaction' },
	{ symbol: /^broadcastAuthored$/, label: 'broadcastAuthored' },
	{ symbol: /^deriveKeyPair$/, label: 'deriveKeyPair' },
	{ symbol: /^derivePostingKey$/, label: 'derivePostingKey' },
	{ symbol: /^crypto_sign/, label: 'crypto_sign* (libsodium)' }
];

interface SigningHit {
	file: string;
	line: number;
	text: string;
	label: string;
}

const signingHits: SigningHit[] = [];

const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))?\s*(?:,\s*\{([^}]*)\})?\s*from\s+['"]([^'"]+)['"]/;

for (const file of mcpFiles) {
	const rel = relative(REPO_ROOT, file);
	const lines = readFileSync(file, 'utf8').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = line.match(IMPORT_RE);
		if (!m) continue;
		const namedImports = (m[1] ?? '') + ',' + (m[4] ?? '');
		const nsImport = m[2] ?? '';
		const defImport = m[3] ?? '';
		const moduleSpec = m[5];
		const symbols = [
			...namedImports
				.split(',')
				.map((s) => s.trim().split(/\s+as\s+/)[0].trim())
				.filter(Boolean),
			nsImport,
			defImport
		].filter(Boolean);

		for (const pat of SIGNING_PATTERNS) {
			if (pat.module && pat.module.test(moduleSpec)) {
				signingHits.push({
					file: rel,
					line: i + 1,
					text: line.trim(),
					label: pat.label
				});
			}
			if (pat.symbol) {
				for (const sym of symbols) {
					if (pat.symbol.test(sym)) {
						signingHits.push({
							file: rel,
							line: i + 1,
							text: line.trim(),
							label: `${pat.label} (symbol: ${sym})`
						});
					}
				}
			}
		}
	}
}

if (signingHits.length === 0) {
	pass(
		`no signing/mutation primitives imported in apps/mcp-server/src/ (${mcpFiles.length} .ts files checked)`
	);
} else {
	fail(
		'no signing/mutation primitives in apps/mcp-server/src/',
		`SIGNING PRIMITIVE LEAKED INTO READ-ONLY MCP SERVER: ${signingHits
			.map((h) => `${h.file}:${h.line} [${h.label}] — ${h.text}`)
			.join('; ')}.  This is a major architectural shift.  Charlie (the AI-agent persona, cp148 walkthrough) is documented as read-only-by-construction; adding signing primitives to mcp-server invalidates the entire AI-agent trust model.  If this is intentional, write an ADR explaining the shift first, then update the cp148 walkthrough, then carve a deliberate exception into this smoke's allowlist.`
	);
}

/* ---------------- invariant 2: no mutation API from client packages ---------------- */

/**
 * If mcp-server ever starts importing @morphit/indexer-client
 * or @morphit/relay-client, audit the imports against this
 * allowlist.  Currently mcp-server imports nothing from those
 * packages (it talks directly to /v1/ via fetch), so this is
 * forward-looking.
 *
 * READ-only symbols that would be safe: buildV1Url, fetchJson,
 * trimOrderRow, etc.  MUTATION symbols that must NOT appear:
 * postOrder, postFeedback, postFeedbackResponse, postCancel,
 * anything starting with `post`, `submit`, `broadcast`, `cancel`,
 * `mutate`, or `sign`.
 */
const MUTATION_SYMBOL_RE = /^(post|submit|broadcast|cancel|mutate|sign|publish|send)[A-Z]/;

interface MutationHit {
	file: string;
	line: number;
	symbol: string;
	source: string;
}
const mutationHits: MutationHit[] = [];

const CLIENT_PACKAGE_RE = /^@morphit\/(indexer-client|relay-client)$/;

for (const file of mcpFiles) {
	const rel = relative(REPO_ROOT, file);
	const lines = readFileSync(file, 'utf8').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = line.match(IMPORT_RE);
		if (!m) continue;
		const moduleSpec = m[5];
		if (!CLIENT_PACKAGE_RE.test(moduleSpec)) continue;
		const namedImports = ((m[1] ?? '') + ',' + (m[4] ?? ''))
			.split(',')
			.map((s) => s.trim().split(/\s+as\s+/)[0].trim())
			.filter(Boolean);
		for (const sym of namedImports) {
			if (MUTATION_SYMBOL_RE.test(sym)) {
				mutationHits.push({ file: rel, line: i + 1, symbol: sym, source: moduleSpec });
			}
		}
	}
}

if (mutationHits.length === 0) {
	pass(
		'no mutation-API symbols imported from @morphit/{indexer,relay}-client'
	);
} else {
	fail(
		'no mutation-API symbols from client packages',
		`mutation imports: ${mutationHits.map((h) => `${h.file}:${h.line} ${h.symbol} from ${h.source}`).join('; ')}.  Mutation helpers in the client packages exist for apps/web's signed-broadcast flows; mcp-server is read-only and must not consume them.`
	);
}

/* ---------------- invariant 3: all network calls via fetchJson ---------------- */

/**
 * The cp146 hardening (redirect:'manual', URL redaction in
 * errors, User-Agent header, timeout via AbortController) is
 * concentrated in `indexerClient.ts`'s `fetchJson()`.  Any tool
 * that uses raw `fetch(` instead of `fetchJson(` would bypass
 * those defenses.
 *
 * Whitelist `indexerClient.ts` itself (it defines fetchJson and
 * naturally contains the `fetch(` callsite that fetchJson
 * delegates to).  Everywhere else: raw `fetch(` is a smell.
 */
const FETCH_RE = /\bfetch\s*\(/;
const INDEXER_CLIENT_PATH = join(MCP_SRC, 'indexerClient.ts');

interface RawFetchHit {
	file: string;
	line: number;
	text: string;
}
const rawFetchHits: RawFetchHit[] = [];

for (const file of mcpFiles) {
	if (file === INDEXER_CLIENT_PATH) continue;
	const rel = relative(REPO_ROOT, file);
	const text = readFileSync(file, 'utf8');
	const lines = text.split('\n');
	let inBlockComment = false;
	// cp153 — the simpler `stripComments` helper at
	// `scripts/lib/strip-comments.ts` does a whole-text regex
	// strip, which is faster but destroys line-number alignment
	// (a multi-line `/* */` collapses to an empty string,
	// shifting all subsequent lines).  This smoke reports raw
	// fetch() hits with file:line for remediation, so we need
	// per-line state that preserves the original line numbers.
	// Hence the inline state machine here.  Confirmed in cp153
	// that consolidation would lose the diagnostic precision.
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		// Strip line comments.
		const lineCommentIdx = line.indexOf('//');
		if (lineCommentIdx >= 0) line = line.slice(0, lineCommentIdx);

		// Crude block-comment stripping.  Good enough for this
		// repo's prose-comment style; doesn't perfectly handle
		// /* */ inside strings, which is fine for raw fetch
		// detection.
		if (inBlockComment) {
			const end = line.indexOf('*/');
			if (end < 0) continue;
			line = line.slice(end + 2);
			inBlockComment = false;
		}
		while (true) {
			const start = line.indexOf('/*');
			if (start < 0) break;
			const end = line.indexOf('*/', start + 2);
			if (end < 0) {
				line = line.slice(0, start);
				inBlockComment = true;
				break;
			}
			line = line.slice(0, start) + line.slice(end + 2);
		}

		if (FETCH_RE.test(line)) {
			rawFetchHits.push({ file: rel, line: i + 1, text: lines[i].trim() });
		}
	}
}

if (rawFetchHits.length === 0) {
	pass(
		'no raw fetch() calls outside indexerClient.ts (network calls all routed through fetchJson)'
	);
} else {
	fail(
		'no raw fetch() outside indexerClient.ts',
		`raw fetch() calls: ${rawFetchHits.map((h) => `${h.file}:${h.line} — ${h.text}`).join('; ')}.  All network calls in apps/mcp-server/src/ must go through fetchJson() in indexerClient.ts so they inherit the cp146 hardening (redirect:'manual', User-Agent, URL redaction in errors, timeout via AbortController).`
	);
}

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log(`  ${ANSI_GREEN}✓${ANSI_RESET} ${r.name}`);
	} else {
		console.log(`  ${ANSI_RED}✗${ANSI_RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`✗ ${failed} of ${results.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(`✓ all ${results.length} scenarios passed`);
}
