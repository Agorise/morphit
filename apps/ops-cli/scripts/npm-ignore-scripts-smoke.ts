/**
 * npm-ignore-scripts smoke.
 *
 * An `npm ci` / `npm install` without `--ignore-scripts` runs every
 * dependency's install scripts — as root, on a node, during an install or an
 * upgrade. The native add-ons the Matrix bot needs are put in place from
 * pinned SHA-256 sums instead (scripts/fetch-matrix-bot-natives.mjs), and only
 * where the bot runs.
 *
 * Checks every place an install path runs npm, and every npm command printed
 * for an operator to type:
 *   - apps/ops-cli/src: spawn argument arrays (`'npm', ['ci', …]`) and printed
 *     command lines;
 *   - scripts/build-offline-bundle.sh, scripts/eli5-release.sh,
 *     ops/scripts/deploy-mcp.sh, .forgejo/workflows/*.yml, ops/ansible tasks,
 *     morphit-setup.sh: command lines (comments ignored).
 * `--package-lock-only` (no node_modules written) is allowed.
 *   MORPHIT_NPM_SCAN_ROOT=<other tree> tsx apps/ops-cli/scripts/npm-ignore-scripts-smoke.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(
	process.env.MORPHIT_NPM_SCAN_ROOT ??
		join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
);

const walk = (d: string, ext: RegExp, out: string[] = []): string[] => {
	if (!existsSync(d)) return out;
	for (const n of readdirSync(d)) {
		if (n === 'node_modules') continue;
		const p = join(d, n);
		if (statSync(p).isDirectory()) walk(p, ext, out);
		else if (ext.test(n)) out.push(p);
	}
	return out;
};

const offenders: string[] = [];
const lineOf = (text: string, idx: number): number => text.slice(0, idx).split('\n').length;

// A command, not prose: `npm ci|install|i`, then only flags / package names,
// then the end of the command (line end, a quote, &&, ;, |). "npm ci exited 1",
// "(npm ci)" or "skipping npm ci." are prose and do not match.
const ARG = String.raw`[ \t]+[-@\w/=:^~]+(?:\.[-@\w/=:^~]+)*`;
const CMD = new RegExp(
	String.raw`\bnpm[ \t]+(?:ci|install|i)\b(?:${ARG})*(?=[ \t]*(?:$|&&|;|\||['"\x60]))`,
	'gm'
);
const allowed = (cmd: string): boolean =>
	/--ignore-scripts\b/.test(cmd) || /--package-lock-only\b/.test(cmd);

function scanText(file: string, stripComments: (line: string) => string): void {
	const text = readFileSync(file, 'utf8');
	const lines = text.split('\n').map(stripComments).join('\n');
	for (const m of lines.matchAll(CMD)) {
		if (!allowed(m[0]))
			offenders.push(`${relative(ROOT, file)}:${lineOf(lines, m.index!)}: ${m[0].trim()}`);
	}
}
const shellComment = (l: string): string => (/^\s*#/.test(l) ? '' : l);

for (const f of [
	'scripts/build-offline-bundle.sh',
	'scripts/eli5-release.sh',
	'ops/scripts/deploy-mcp.sh',
	'morphit-setup.sh'
]) {
	if (existsSync(join(ROOT, f))) scanText(join(ROOT, f), shellComment);
}
for (const f of walk(join(ROOT, '.forgejo', 'workflows'), /\.ya?ml$/)) scanText(f, shellComment);
for (const f of walk(join(ROOT, 'ops', 'ansible'), /\.ya?ml$/)) scanText(f, shellComment);

// ops-cli source: printed hints (string literals) and spawn argument arrays.
for (const f of walk(join(ROOT, 'apps', 'ops-cli', 'src'), /\.ts$/)) {
	const text = readFileSync(f, 'utf8');
	const code = text
		.split('\n')
		.map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
		.join('\n');
	for (const m of code.matchAll(/(['"`])((?:(?!\1).)*)\1/g)) {
		for (const c of m[2]!.matchAll(CMD)) {
			if (!allowed(c[0]))
				offenders.push(`${relative(ROOT, f)}:${lineOf(code, m.index!)}: ${c[0].trim()}`);
		}
	}
	for (const m of code.matchAll(/['"]npm['"]\s*,\s*\[\s*['"](ci|install|i)['"]([^\]]*)\]/g)) {
		if (!allowed(m[2]!))
			offenders.push(`${relative(ROOT, f)}:${lineOf(code, m.index!)}: npm ${m[1]}${m[2]}`);
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
check('every install-path / printed `npm ci|install` has --ignore-scripts', offenders.length === 0);
for (const o of offenders) console.log(`      ${o}`);

// The Matrix bot's native add-ons: pinned sums, fetched only where the bot runs.
const natives = join(ROOT, 'scripts', 'fetch-matrix-bot-natives.mjs');
const nativesSrc = existsSync(natives) ? readFileSync(natives, 'utf8') : '';
check(
	'the native add-ons are checked against pinned SHA-256 sums',
	/sha256/i.test(nativesSrc) && (nativesSrc.match(/[0-9a-f]{64}/g) ?? []).length >= 4
);
const upgrade = readFileSync(
	join(ROOT, 'apps', 'ops-cli', 'src', 'commands', 'upgrade.ts'),
	'utf8'
);
check(
	'upgrade fetches them only when the Matrix bot is set up to run',
	/function ensureMatrixBotNatives[\s\S]{0,400}if \(!matrixBotReadiness\(readMatrixBotEnv\(\)\)\.run\) return;/.test(
		upgrade
	)
);

console.log(
	fail === 0 ? `✓ all ${pass} npm-ignore-scripts checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
