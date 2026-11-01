/**
 * curl-proxy-noproxy-smoke — every curl that Morphit sends through Tor or I2P
 * also says `--noproxy ''`.
 *
 * WHY (2026-10-31). curl applies the `no_proxy` / `NO_PROXY` environment
 * variable even to a proxy named on its command line (`--socks5-hostname`,
 * `-x`, `--proxy`): a host listed there is fetched DIRECTLY, around Tor. Seen
 * for real: a diagnostic's "fetch through Tor" answered HTTP 200 in 0.05 s on a
 * machine with no Tor at all, because no_proxy listed registry.npmjs.org. On a
 * zero-clearnet node that is a clearnet connection the operator never meant to
 * make; anywhere it is a check that proves nothing. `--noproxy ''` makes curl
 * ignore no_proxy for that call.
 *
 * Checks every shipped file (sources, scripts, ops shell scripts, the Ansible
 * playbook and roles, the docs' commands): a line passing curl a proxy flag
 * must have `--noproxy` on it or on one of the three lines before it (an
 * argument array split over lines). Smokes, tests and harnesses are left out
 * (they drive stand-ins), as are comments.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checked = 0;
const ok = (m: string): void => console.log(`  ✓ ${m}`);
const bad = (m: string): void => {
	console.error(`  ✗ ${m}`);
	failures++;
};

function walk(dir: string, out: string[]): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const n of names) {
		if (
			n === 'node_modules' ||
			n === 'dist' ||
			n === 'build' ||
			n === '.svelte-kit' ||
			n === '.git'
		)
			continue;
		const p = join(dir, n);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else out.push(p);
	}
}

const files: string[] = [];
for (const d of ['apps', 'packages', 'ops', 'scripts', 'docs']) walk(join(REPO, d), files);
const shipped = files.filter((f) => {
	const r = relative(REPO, f);
	if (!/\.(ts|mjs|sh|ya?ml|j2|md)$/.test(r)) return false;
	if (/(^|\/)(test|tests)\//.test(r) || r.startsWith('ops/test/')) return false;
	if (/-smoke\.ts$|\.test\.ts$|harness/.test(r)) return false;
	if (r.startsWith('docs/release-notes/') || r.startsWith('docs/audit/')) return false;
	return true;
});

// A proxy handed to curl: Tor by name, a SOCKS or HTTP proxy, I2P's proxy.
// `-x` counts only when a proxy address (or the variable holding one) follows
// it, so the shell's `[ -x f ]` and `set -x` are not taken for it.
const PROXY_FLAG =
	/(^|[\s('"`,[])(--socks5-hostname|--socks5|--socks4a?|--proxy)(?=[\s'"`,)\]=]|$)|(^|[\s('"`,[])-x['"`]?(\s*,\s*|\s+)["'`]?(https?:|socks|\$|\{|[A-Z][A-Z0-9_]*[,)\s])/;
const commentIn = (file: string): RegExp =>
	/\.(sh|ya?ml|j2|md)$/.test(file) ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;

/** `--noproxy` belongs to THIS proxy flag's argument list: on its own line, or
 *  (an argument array written one element per line) on an element line just
 *  before it — never a neighbouring branch's (`*.onion) … --noproxy …` above
 *  `*.i2p) … -x …` passed before this check was made this strict). */
function hasNoproxy(lines: readonly string[], i: number): boolean {
	if (/--noproxy/.test(lines[i]!)) return true;
	const element = /^\s*(['"`][^'"`]*['"`]|\/\/.*),?\s*$/;
	if (!element.test(lines[i]!)) return false;
	for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
		const l = lines[j]!;
		if (/--noproxy/.test(l)) return true;
		if (PROXY_FLAG.test(l) || !element.test(l)) return false;
	}
	return false;
}

for (const f of shipped) {
	const r = relative(REPO, f);
	const text = readFileSync(f, 'utf8');
	// Only files that run curl (directly, or through a helper of their own).
	if (!/\bcurl\b/.test(text)) continue;
	const lines = text.split('\n');
	const COMMENT = commentIn(r);
	lines.forEach((line, i) => {
		if (COMMENT.test(line) || !PROXY_FLAG.test(line)) return;
		// The shell's own `-x` (is executable): `[ -x f ]`, `[ ! -x f ]`, `test -x f`.
		if (!/--socks|--proxy/.test(line) && /(\[\[?|\btest)\s+(!\s+)?-x\s/.test(line)) return;
		if (/apt|Acquire::|apt-transport-tor/.test(line)) return;
		checked++;
		if (!hasNoproxy(lines, i))
			bad(`${r}:${i + 1} passes curl a proxy without --noproxy '': ${line.trim().slice(0, 140)}`);
	});
}

if (checked < 12) bad(`only ${checked} proxied curl calls found; the scan no longer sees them`);
else if (failures === 0)
	ok(`${checked} proxied curl calls in shipped files, each with --noproxy ''`);

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	// One scenario per proxied curl call, plus the scan's own floor.
	console.log(`✓ all ${checked + 1} curl-proxy-noproxy scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failures} curl-proxy-noproxy check(s) failed`);
process.exit(1);
