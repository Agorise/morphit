/**
 * ddns-config-parse-smoke.
 *
 * A manual run of ops/ddns/morphit-ddns-update.sh reads /etc/morphit/ddns.env
 * itself. The provider URLs the docs give contain `&`; when the file was
 * SOURCED, the shell cut the value at the first `&` and the updater said "not
 * configured". Runs the real script with a fake curl and checks that the whole
 * URL (every parameter, {ip} filled in) reaches the provider, for an unquoted
 * and a quoted value, and that nothing in the file is executed.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';

const SCRIPT = process.env.MORPHIT_DDNS_SCRIPT ?? join(REPO, 'ops/ddns/morphit-ddns-update.sh');
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};
const URL = 'https://njal.la/update/?h=home.example.org&k=SECRETKEY&a={ip}';
for (const [label, line] of [
	['unquoted', `MORPHIT_DDNS_UPDATE_URL=${URL}`],
	['double-quoted', `MORPHIT_DDNS_UPDATE_URL="${URL}"`]
] as const) {
	const dir = mkdtempSync(join(tmpdir(), 'ddns-'));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const pushed = join(dir, 'pushed');
	writeFileSync(
		join(bin, 'curl'),
		`#!/bin/sh\nfor a in "$@"; do case "$prev" in -K) sed -n 's/^url = "\\(.*\\)"$/\\1/p' "$a" > ${pushed} ;; esac; prev="$a"; done\ncase "$*" in *-K*) exit 0 ;; *) echo 203.0.113.7 ;; esac\n`
	);
	chmodSync(join(bin, 'curl'), 0o755);
	const marker = join(dir, 'executed');
	writeFileSync(
		join(dir, 'ddns.env'),
		`${line}\nMORPHIT_DDNS_STATE_FILE=${join(dir, 'last')}\n$(touch ${marker})\n`
	);
	const r = spawnSync('sh', [SCRIPT], {
		encoding: 'utf8',
		env: { PATH: `${bin}:/usr/bin:/bin`, MORPHIT_DDNS_ENV: join(dir, 'ddns.env') }
	});
	const got = existsSync(pushed) ? readFileSync(pushed, 'utf8').trim() : '';
	check(
		`${label} value: the whole provider URL is used, {ip} filled in`,
		got === URL.replace('{ip}', '203.0.113.7'),
		got || (r.stderr ?? '').trim().split('\n').pop()
	);
	check(`${label} value: nothing in ddns.env is executed`, !existsSync(marker));
	rmSync(dir, { recursive: true, force: true });
}
console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} ddns-config-parse checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} ddns-config-parse checks failed`);
process.exit(1);
