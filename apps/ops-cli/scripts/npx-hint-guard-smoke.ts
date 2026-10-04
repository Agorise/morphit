/**
 * npx-hint-guard smoke (review H-5).
 *
 * `morphit-ops`, `morphit-mcp` and `@morphit/*` are not published on npm (the
 * packages are private). A hint to run `npx morphit-ops …` or
 * `npx -y morphit-mcp` therefore asks npm's registry for a package of that
 * name — one anybody could publish — and runs it, as root on a server.
 *
 * Operator-facing hints say `sudo morphit-ops <cmd>` (the installed launcher)
 * or, before the launcher exists, `sudo node apps/ops-cli/bin/morphit-ops.mjs
 * <cmd>` from the install directory. `npx --no-install …` never reaches the
 * registry and is allowed.
 *
 * Scans ops-cli's source, morphit-setup.sh and the MCP server's README, and
 * checks that the two CLI packages are private.
 *   MORPHIT_NPX_SCAN_ROOT=<other tree> tsx apps/ops-cli/scripts/npx-hint-guard-smoke.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(
	process.env.MORPHIT_NPX_SCAN_ROOT ??
		join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
);
const SRC = join(ROOT, 'apps', 'ops-cli', 'src');

const files: string[] = [];
(function walk(d: string): void {
	for (const n of readdirSync(d)) {
		const p = join(d, n);
		if (statSync(p).isDirectory()) walk(p);
		else if (p.endsWith('.ts')) files.push(p);
	}
})(SRC);
for (const extra of ['morphit-setup.sh', 'apps/mcp-server/README.md']) {
	if (existsSync(join(ROOT, extra))) files.push(join(ROOT, extra));
}

/** `npx` (any flags, except --no-install) followed by one of our package names. */
const NPX_OURS =
	/\bnpx\b((?:\s+-{1,2}[\w-]+)*)\s+(?:"?)(morphit-ops|morphit-mcp|@morphit\/[\w-]+)\b/g;
/** The JSON form an MCP client config takes: "command": "npx", "args": ["-y", "morphit-mcp"]. */
const NPX_JSON = /"command"\s*:\s*"npx"[\s\S]{0,80}?"(morphit-mcp|morphit-ops)"/g;

const offenders: string[] = [];
for (const f of files) {
	const text = readFileSync(f, 'utf8');
	const rel = relative(ROOT, f);
	for (const m of text.matchAll(NPX_OURS)) {
		if (/--no-install/.test(m[1] ?? '')) continue;
		const line = text.slice(0, m.index).split('\n').length;
		offenders.push(`${rel}:${line}: ${m[0].replace(/\s+/g, ' ')}`);
	}
	for (const m of text.matchAll(NPX_JSON)) {
		const line = text.slice(0, m.index).split('\n').length;
		offenders.push(`${rel}:${line}: "command": "npx" … ${m[1]}`);
	}
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

check(
	'no `npx` hint that would fetch morphit-ops / morphit-mcp / @morphit/* from npm',
	offenders.length === 0
);
for (const o of offenders) console.log(`      ${o}`);
for (const pkg of ['apps/ops-cli/package.json', 'apps/mcp-server/package.json']) {
	const j = JSON.parse(readFileSync(join(ROOT, pkg), 'utf8')) as { private?: unknown };
	check(`${pkg} is private (never published by accident)`, j.private === true);
}

console.log(
	fail === 0 ? `✓ all ${pass} npx-hint-guard checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
