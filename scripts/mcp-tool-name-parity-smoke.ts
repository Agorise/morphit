#!/usr/bin/env tsx
/**
 * mcp-tool-name-parity-smoke — the MCP tool names in the operator
 * docs (OPERATIONS §45) and the `morphit-ops init` wizard MUST match
 * the tools actually registered in apps/mcp-server/src/main.ts.
 *
 * Why: cp251 found the §45 table + the wizard advertising
 * `morphit_list_operators` / `morphit_account_reputation` /
 * `morphit_federation_summary`, none of which exist — the code
 * registers `morphit_list_instances` / `morphit_list_payment_methods`
 * / `morphit_describe`.  An operator wiring an agent off the docs would
 * configure phantom tools.  This locks doc + wizard to the source of
 * truth so the drift can't come back.
 *
 * Emits one canonical line at column 0 on success.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

let checks = 0;
const failures: string[] = [];
function check(label: string, cond: boolean): void {
	checks++;
	if (!cond) failures.push(label);
}

// ── Authoritative set: the TOOLS array in main.ts ─────────────────
const mainTs = read('apps/mcp-server/src/main.ts');
const toolsArray = mainTs.slice(mainTs.indexOf('const TOOLS'), mainTs.indexOf('async function main'));
const registered = new Set(
	[...toolsArray.matchAll(/name:\s*'(morphit_[a-z_]+)'/g)].map((m) => m[1]!)
);
check(`main.ts registers a plausible tool count (found ${registered.size}, expect 5)`, registered.size === 5);

// ── OPERATIONS §45: backtick-wrapped tool tokens ──────────────────
const ops = read('docs/OPERATIONS.md');
const s45Start = ops.indexOf('## 45. MCP server');
const s45End = ops.indexOf('\n## ', s45Start + 1);
const s45 = s45Start >= 0 ? ops.slice(s45Start, s45End > 0 ? s45End : undefined) : '';
check('OPERATIONS §45 section located', s45.length > 0);
const docToolTokens = new Set([...s45.matchAll(/`(morphit_[a-z_]+)`/g)].map((m) => m[1]!));

for (const t of docToolTokens) {
	check(`OPERATIONS §45 names a real tool: ${t}`, registered.has(t));
}
for (const t of registered) {
	check(`OPERATIONS §45 documents the registered tool: ${t}`, docToolTokens.has(t));
}

// ── init wizard (steps.ts): the tool bullet list ──────────────────
const steps = read('apps/ops-cli/src/init/steps.ts');
const wizardToolTokens = new Set(
	steps
		.split('\n')
		.filter((ln) => ln.includes('\u2022') && /morphit_[a-z_]+/.test(ln))
		.flatMap((ln) => [...ln.matchAll(/(morphit_[a-z_]+)/g)].map((m) => m[1]!))
);
check(`wizard lists tool bullets (found ${wizardToolTokens.size})`, wizardToolTokens.size > 0);
for (const t of wizardToolTokens) {
	check(`init wizard names a real tool: ${t}`, registered.has(t));
}

// ── Result ────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(`mcp-tool-name-parity-smoke: ${failures.length} FAILED of ${checks}:`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`  registered tools: ${[...registered].join(', ')}`);
	process.exit(1);
}
console.log(`✓ all ${checks} mcp-tool-name-parity-smoke scenarios passed`);
