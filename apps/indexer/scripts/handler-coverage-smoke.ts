/**
 * Morphit indexer — handler-coverage smoke.
 *
 * Asserts that every handler file in apps/indexer/src/indexer/handlers/
 * is registered in the dispatcher's HANDLERS map and OP_IDS const,
 * AND that the indexer's OP_IDS matches the frontend's OP_IDS.
 *
 * Origin: BATCH19B Pass B (2026-05-02).  Discovered that
 * operatorBlock.ts and operatorPaymentMethod.ts had been
 * implemented and unit-tested but never wired to the dispatcher —
 * the indexer was rejecting every `morphit_operator_block_v1` and
 * `morphit_payment_method_addition_v1` op as `handler_not_implemented`.
 *
 * This smoke prevents that class of bug:
 * - Add a new handler file → must register it in the dispatcher
 *   AND in $net/config OP_IDS, or this smoke fails loudly.
 * - Remove a handler file → must remove from both, ditto.
 * - Add an OP_ID without a handler → caught.
 *
 * The smoke walks the handler dir at file-system level, parses
 * dispatcher.ts source for OP_IDS keys + HANDLERS map keys, and
 * does the obvious set comparisons.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

let scenarios = 0;
let failures = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  ✗ ${name}: ${msg}`);
	}
}

console.log('Handler-coverage smoke');
console.log('──────────────────────');

// ─── Read the dispatcher source ──────────────────────────────────

const dispatcherPath = join(REPO_ROOT, 'apps/indexer/src/indexer/dispatcher.ts');
const dispatcherSrc = readFileSync(dispatcherPath, 'utf-8');

// Extract OP_IDS keys: lines like `\toperatorBlock: 'morphit_operator_block_v1',`
// inside the `export const OP_IDS = {` block.
function extractOpIdsKeys(src: string): { name: string; opId: string }[] {
	const start = src.indexOf('export const OP_IDS = {');
	if (start < 0) throw new Error('OP_IDS not found in dispatcher.ts');
	const end = src.indexOf('} as const;', start);
	if (end < 0) throw new Error('OP_IDS terminator not found');
	const block = src.slice(start, end);
	const out: { name: string; opId: string }[] = [];
	const lineRe = /^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:\s*'([^']+)'\s*,?\s*$/gm;
	for (const m of block.matchAll(lineRe)) {
		out.push({ name: m[1]!, opId: m[2]! });
	}
	return out;
}

// Extract HANDLERS map keys: lines like `\t[OP_IDS.operatorBlock]: operatorBlockHandler,`
function extractHandlersMapKeys(src: string): string[] {
	const start = src.indexOf('const HANDLERS:');
	if (start < 0) throw new Error('HANDLERS map not found in dispatcher.ts');
	const end = src.indexOf('};', start);
	if (end < 0) throw new Error('HANDLERS map terminator not found');
	const block = src.slice(start, end);
	const out: string[] = [];
	const lineRe = /\[OP_IDS\.([a-zA-Z][a-zA-Z0-9]*)\]/g;
	for (const m of block.matchAll(lineRe)) {
		out.push(m[1]!);
	}
	return out;
}

// Extract handler-import statements: `import xHandler from '$indexer/handlers/x';`
function extractHandlerImports(src: string): string[] {
	const re = /^import\s+(\w+)\s+from\s+['"]\$indexer\/handlers\/(\w+)['"]\s*;?$/gm;
	const out: string[] = [];
	for (const m of src.matchAll(re)) {
		out.push(m[2]!);
	}
	return out;
}

const opIds = extractOpIdsKeys(dispatcherSrc);
const handlersMapKeys = extractHandlersMapKeys(dispatcherSrc);
const handlerImports = extractHandlerImports(dispatcherSrc);

// ─── Read the handlers directory ─────────────────────────────────

const handlersDir = join(REPO_ROOT, 'apps/indexer/src/indexer/handlers');
const handlerFiles = readdirSync(handlersDir)
	.filter((f) => f.endsWith('.ts') && !f.startsWith('UNUSED_'))
	.map((f) => f.replace(/\.ts$/, ''));

scenario('dispatcher.ts parses cleanly', () => {
	if (opIds.length === 0) throw new Error('OP_IDS empty');
	if (handlersMapKeys.length === 0) throw new Error('HANDLERS map empty');
	if (handlerImports.length === 0) throw new Error('no handler imports');
});

scenario('every OP_IDS entry has a HANDLERS map registration', () => {
	const opIdNames = new Set(opIds.map((x) => x.name));
	const mapKeys = new Set(handlersMapKeys);
	const missing = [...opIdNames].filter((n) => !mapKeys.has(n));
	if (missing.length > 0) {
		throw new Error(`OP_IDS without handler registration: ${missing.join(', ')}`);
	}
});

scenario('every HANDLERS entry has a corresponding OP_IDS', () => {
	const opIdNames = new Set(opIds.map((x) => x.name));
	const orphans = handlersMapKeys.filter((k) => !opIdNames.has(k));
	if (orphans.length > 0) {
		throw new Error(`HANDLERS keys not in OP_IDS: ${orphans.join(', ')}`);
	}
});

scenario('every handler file is imported by the dispatcher', () => {
	const imported = new Set(handlerImports);
	const unimported = handlerFiles.filter((f) => !imported.has(f));
	if (unimported.length > 0) {
		throw new Error(
			`Handler files not imported by dispatcher: ${unimported.join(', ')}\n  ` +
				`If a handler is intentionally not yet wired, prefix the file ` +
				`with UNUSED_ to mark it for manual cleanup.`
		);
	}
});

scenario('every imported handler is registered in HANDLERS map', () => {
	// The HANDLERS map lookups all use OP_IDS.X — so we need to
	// verify each imported handler module's name (xHandler) maps
	// onto an OP_IDS entry whose registration uses xHandler.
	// Approximation: every handler import should be referenced
	// as a value in the HANDLERS object literal.
	const start = dispatcherSrc.indexOf('const HANDLERS:');
	const end = dispatcherSrc.indexOf('};', start);
	const block = dispatcherSrc.slice(start, end);
	const unused: string[] = [];
	for (const handlerFile of handlerImports) {
		// Convention: handler import is named `${handlerFile}Handler`,
		// or has special-case mappings.  We check that the named
		// identifier appears as a value in the HANDLERS block.
		// (e.g. `chatHandler`, `releaseHandler`, etc.)
		// The convention is enforced by the import line: file `chat.ts`
		// imports as `chatHandler`.
		const expectedName = `${handlerFile}Handler`;
		if (!new RegExp(`:\\s*${expectedName}\\b`).test(block)) {
			unused.push(handlerFile);
		}
	}
	if (unused.length > 0) {
		throw new Error(
			`Handler files imported but not referenced in HANDLERS map: ${unused.join(', ')}`
		);
	}
});

// ─── Frontend OP_IDS parity ──────────────────────────────────────

const frontendConfigPath = join(REPO_ROOT, 'apps/web/src/lib/net/config.ts');
const frontendSrc = readFileSync(frontendConfigPath, 'utf-8');
const frontendOpIds = extractOpIdsKeys(frontendSrc);

scenario('frontend OP_IDS matches indexer OP_IDS (same keys)', () => {
	const indexerKeys = new Set(opIds.map((x) => x.name));
	const frontendKeys = new Set(frontendOpIds.map((x) => x.name));
	const missingInIndexer = [...frontendKeys].filter((k) => !indexerKeys.has(k));
	const missingInFrontend = [...indexerKeys].filter((k) => !frontendKeys.has(k));
	if (missingInIndexer.length > 0 || missingInFrontend.length > 0) {
		throw new Error(
			`OP_IDS drift between indexer and frontend.\n  ` +
				`In frontend but not indexer: ${missingInIndexer.join(', ') || '(none)'}\n  ` +
				`In indexer but not frontend: ${missingInFrontend.join(', ') || '(none)'}`
		);
	}
});

scenario('frontend OP_IDS values match indexer OP_IDS values (same op-id strings)', () => {
	const indexerMap = new Map(opIds.map((x) => [x.name, x.opId]));
	const frontendMap = new Map(frontendOpIds.map((x) => [x.name, x.opId]));
	const mismatches: string[] = [];
	for (const [name, indexerOpId] of indexerMap) {
		const frontendOpId = frontendMap.get(name);
		if (frontendOpId !== undefined && frontendOpId !== indexerOpId) {
			mismatches.push(`${name}: indexer="${indexerOpId}" frontend="${frontendOpId}"`);
		}
	}
	if (mismatches.length > 0) {
		throw new Error(`OP_ID string drift:\n  ` + mismatches.join('\n  '));
	}
});

// ─── Final report ────────────────────────────────────────────────

console.log();
console.log('────────────────────────────────────────────────────────────');
if (failures > 0) {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} scenarios passed`);
