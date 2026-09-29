/**
 * npx-hint-guard smoke (review H-5).
 *
 * Operator-facing hints must tell people to run `sudo morphit-ops <cmd>` (the
 * installed launcher), not `npx morphit-ops <cmd>`. `npx morphit-ops` is only
 * legitimate for the BOOTSTRAP that runs from the repo before the launcher
 * exists — `install` / `init` — and for the generic `<command>` placeholder the
 * PATH-shortcut step prints while explaining the shortcut isn't installed yet.
 * Any other `npx morphit-ops <real-subcommand>` is a stale hint.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ALLOWED_AFTER_NPX = new Set(['install', 'init']);

const files: string[] = [];
(function walk(d: string): void {
	for (const n of readdirSync(d)) {
		const p = join(d, n);
		if (statSync(p).isDirectory()) walk(p);
		else if (p.endsWith('.ts')) files.push(p);
	}
})(SRC);

const offenders: string[] = [];
for (const f of files) {
	const text = readFileSync(f, 'utf8');
	for (const m of text.matchAll(/npx morphit-ops\s+(\S+)/g)) {
		const raw = (m[1] ?? '').replace(/[^A-Za-z0-9<>[\]_-].*$/, '');
		// A `<command>` / `[cmd]` placeholder (the PATH-shortcut step's generic
		// "run it as npx morphit-ops <command> until the shortcut is installed")
		// is allowed; only a NAMED operational subcommand is a stale hint.
		if (raw.startsWith('<') || raw.startsWith('[')) continue;
		if (!ALLOWED_AFTER_NPX.has(raw)) {
			offenders.push(`${f.split('/apps/ops-cli/')[1]}: npx morphit-ops ${raw}`);
		}
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
	'no stale `npx morphit-ops <operational-subcommand>` hints in ops-cli src',
	offenders.length === 0
);
for (const o of offenders) console.log(`      ${o} → use \`sudo morphit-ops …\``);

console.log(
	fail === 0 ? `✓ all ${pass} npx-hint-guard checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
