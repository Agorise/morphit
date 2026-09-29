/**
 * help-layout smoke (review H-14).
 *
 * The `mcp` description's continuation lines ("…the AI-agent orderbook surface.
 * Read-only + non-custodial; on by default.") were interleaved UNDER the
 * `matrix` entry, so --help described matrix as the AI-agent orderbook. Parse
 * the REAL --help output (not the source) and pin each entry to its own text.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const WS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

const run = spawnSync(process.execPath, [join(WS, 'bin', 'morphit-ops.mjs'), '--help'], {
	encoding: 'utf8',
	timeout: 60_000
});
const lines = `${run.stdout ?? ''}`.split('\n');

// The description block of a subcommand = its line plus the following
// continuation lines (indented, no new "  <word>" subcommand token).
const blockOf = (name: string): string => {
	const start = lines.findIndex((l) => new RegExp(`^  ${name}\\b`).test(l));
	if (start < 0) return '';
	const block = [lines[start]!];
	for (let i = start + 1; i < lines.length; i++) {
		if (/^  \S/.test(lines[i]!) || lines[i]!.trim() === '') break; // next entry / section
		block.push(lines[i]!);
	}
	return block.join('\n');
};

const mcp = blockOf('mcp');
const matrix = blockOf('matrix');
check('--help exits 0', run.status === 0);
check('the AI-agent orderbook text is under `mcp`', /AI-agent orderbook/.test(mcp));
check('the AI-agent orderbook text is NOT under `matrix`', !/AI-agent orderbook/.test(matrix));
check('`matrix` describes the Matrix alert username', /Matrix alert username/.test(matrix));

console.log(
	fail === 0 ? `✓ all ${pass} help-layout checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
