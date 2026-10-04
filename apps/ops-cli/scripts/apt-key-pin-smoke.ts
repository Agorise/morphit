/**
 * apt-key-pin-smoke.
 *
 * Every third-party apt repository (NodeSource, Docker, Trivy) is trusted
 * with ITS signing key only when that key's fingerprint is the pinned one —
 * and Node.js is never installed by piping a setup script into a root shell.
 * Checks: no `curl … | sh` / `| bash` in morphit-setup.sh or ops/; each role
 * checks its pinned fingerprint BEFORE adding the repository; the setup script
 * and the Ansible role pin the same NodeSource fingerprint; the exact check
 * they run (gpg --show-keys | awk) accepts only a file holding ONE key with
 * that fingerprint — run here on keys made for the test (a different key and a
 * file with two keys are refused); and the setup script prints real "…" / "—"
 * characters, not \xE2 escape text.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';

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

const setup = readFileSync(join(REPO, 'morphit-setup.sh'), 'utf8');
const files: string[] = [join(REPO, 'morphit-setup.sh')];
const walk = (d: string): void => {
	for (const n of readdirSync(d)) {
		const p = join(d, n);
		if (statSync(p).isDirectory()) walk(p);
		else if (/\.(sh|ya?ml|j2)$/.test(n)) files.push(p);
	}
};
walk(join(REPO, 'ops'));
const pipes = files.flatMap((f) =>
	readFileSync(f, 'utf8')
		.split('\n')
		.filter((l) => !/^\s*#/.test(l) && /\bcurl\b[^|#]*\|\s*(sudo\s+)?(-E\s+)?(ba|da)?sh\b/.test(l))
		.map((l) => `${f.slice(REPO.length + 1)}: ${l.trim()}`)
);
check(
	'no `curl … | sh` installer in morphit-setup.sh or ops/',
	pipes.length === 0,
	pipes.join(' | ')
);

const setupPin = /^NODESOURCE_KEY_FPR=([0-9A-F]{40})$/m.exec(setup)?.[1];
const gvPin = /^nodesource_key_fingerprint:\s*"([0-9A-F]{40})"/m.exec(
	readFileSync(join(REPO, 'ops/ansible/group_vars/all.yml'), 'utf8')
)?.[1];
check(
	'the setup script and the Ansible role pin the same NodeSource fingerprint',
	!!setupPin && setupPin === gvPin,
	`${setupPin} vs ${gvPin}`
);
const gvText = readFileSync(join(REPO, 'ops/ansible/group_vars/all.yml'), 'utf8');
for (const [file, varName, repoTask] of [
	[
		'ops/ansible/roles/morphit/tasks/nodejs.yml',
		'nodesource_key_fingerprint',
		'Add NodeSource apt repo'
	],
	[
		'ops/ansible/roles/bunkerweb/tasks/main.yml',
		'docker_apt_key_fingerprint',
		'Add Docker apt repo'
	],
	[
		'ops/ansible/roles/trivy_monitor/tasks/main.yml',
		'trivy_apt_key_fingerprint',
		'Add Aqua Security trivy apt repo'
	]
] as const) {
	const y = readFileSync(join(REPO, file), 'utf8');
	const i = y.indexOf(varName);
	check(
		`${file.split('/')[3]}: checks the ${varName.split('_')[0]} key against its pin before adding the repository`,
		i > 0 && i < y.indexOf(repoTask),
		file
	);
	check(
		`${varName} is a full 40-hex fingerprint in group_vars`,
		new RegExp(`^${varName}:\\s*"[0-9A-F]{40}"`, 'm').test(gvText)
	);
}
check(
	'the setup script adds the repository with signed-by (that key only)',
	/signed-by=\/etc\/apt\/keyrings\/nodesource\.gpg/.test(setup)
);
check('the setup script prints real characters, not \\xE2 escape text', !/\\xE2/.test(setup));

// The check itself, on real keys.
const AWK = `awk -F: '/^pub:/ {n++} /^fpr:/ && f == "" {f = $10} END {print n " " f}'`;
if (spawnSync('sh', ['-c', 'command -v gpg']).status === 0) {
	const home = mkdtempSync(join(tmpdir(), 'nskey-'));
	const gpg = (args: string[], input?: string) =>
		spawnSync(
			'gpg',
			['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', ...args],
			{ encoding: 'utf8', input }
		);
	gpg(['--quick-gen-key', 'test-a@example.invalid', 'ed25519', 'sign', '1d']);
	gpg(['--quick-gen-key', 'test-b@example.invalid', 'ed25519', 'sign', '1d']);
	const one = gpg(['--armor', '--export', 'test-a@example.invalid']).stdout;
	const both = gpg(['--armor', '--export']).stdout;
	const fprA =
		/^fpr:+([0-9A-F]{40}):/m.exec(
			gpg(['--with-colons', '--list-keys', 'test-a@example.invalid']).stdout
		)?.[1] ?? '';
	const verdict = (armored: string): string => {
		const f = join(home, 'k.asc');
		writeFileSync(f, armored);
		return spawnSync(
			'sh',
			['-c', `gpg --homedir ${home} --show-keys --with-colons ${f} 2>/dev/null | ${AWK}`],
			{ encoding: 'utf8' }
		).stdout.trim();
	};
	check(
		'the check reads "1 <fingerprint>" for a single key (so the pin comparison is exact)',
		verdict(one) === `1 ${fprA}`,
		verdict(one)
	);
	check('a different key does not match the pin', verdict(one) !== `1 ${setupPin}`);
	check(
		'a file with two keys never matches (count 2)',
		verdict(both).startsWith('2 '),
		verdict(both)
	);
	rmSync(home, { recursive: true, force: true });
} else {
	check('skipped the gpg part: no gpg here', true);
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} apt-key-pin checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} apt-key-pin checks failed`);
process.exit(1);
