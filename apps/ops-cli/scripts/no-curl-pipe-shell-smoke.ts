/**
 * no-curl-pipe-shell-smoke.
 *
 * The wizard offered to fix a missing Docker with
 * `curl -fsSL https://get.docker.com | sudo sh` — a remote script run as root —
 * and that fix ran on a bare Enter (defaultYes: true); `morphit-ops bunkerweb`
 * offered the same script. Shipped code installs packages from the
 * distribution's apt repositories only, and only on an explicit yes.
 *
 * Checks:
 *   - no `curl|wget … | [sudo] sh|bash` in ops-cli's source, the root and
 *     ops shell scripts, the Ansible tasks/templates and morphit-setup.sh
 *     (comments ignored);
 *   - remediationFor(): every auto-fix that installs a package defaults to No.
 *   MORPHIT_PIPE_SCAN_ROOT=<other tree> tsx apps/ops-cli/scripts/no-curl-pipe-shell-smoke.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.MORPHIT_PIPE_SCAN_ROOT ?? join(HERE, '..', '..', '..'));

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

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

const PIPE = /\b(?:curl|wget)\b[^\n|;&]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|da|z)?sh\b/;
const files = [
	...walk(join(ROOT, 'apps', 'ops-cli', 'src'), /\.ts$/),
	...walk(join(ROOT, 'scripts'), /\.sh$/),
	...walk(join(ROOT, 'ops'), /\.(?:sh|ya?ml|j2)$/),
	...(existsSync(join(ROOT, 'morphit-setup.sh')) ? [join(ROOT, 'morphit-setup.sh')] : [])
];
const hits: string[] = [];
for (const f of files) {
	readFileSync(f, 'utf8')
		.split('\n')
		.forEach((line, i) => {
			if (/^\s*(#|\/\/|\*)/.test(line)) return;
			if (PIPE.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
		});
}
check('no remote script piped into a shell in shipped code', hits.length === 0, `${hits.length}`);
for (const h of hits) console.log(`      ${h}`);

const rem = (await import(
	pathToFileURL(join(ROOT, 'apps', 'ops-cli', 'src', 'init', 'remediation.ts')).href
)) as {
	remediationFor: (c: { name: string; actual: string; recommended: string; status: string }) => {
		autoFix?: { command: string; defaultYes: boolean };
	} | null;
};
for (const [name, actual] of [
	['Docker', 'not installed'],
	['Ansible version', '2.9.0']
] as const) {
	const r = rem.remediationFor({ name, actual, recommended: '', status: 'error' });
	const fix = r?.autoFix;
	check(
		`${name}: the package-installing auto-fix defaults to No`,
		fix === undefined ||
			(/apt-get install|pipx install/.test(fix.command) ? fix.defaultYes === false : true),
		fix ? `${fix.command} (defaultYes ${fix.defaultYes})` : ''
	);
}

console.log(
	fail === 0 ? `✓ all ${pass} no-curl-pipe-shell checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
