#!/usr/bin/env tsx
/**
 * apps/ops-cli/scripts/systemd-execstart-executable-smoke.ts
 *
 * Every script a shipped systemd unit invokes via ExecStart must carry the
 * execute bit in the repo.
 *
 * WHY THIS EXISTS
 * `morphit-snapshot-publish.service` failed the very first time its timer fired,
 * with nothing in the journal but `result=exit-code`. The script was mode 0644:
 * systemd refuses to exec it and the unit dies before the first line runs. It had
 * been reviewed, smoke-tested and shipped — and every one of those checks read the
 * file's CONTENT, which was perfectly fine. Nothing looked at its MODE.
 *
 * It hid for so long because the operator had only ever run it by hand as
 * `sudo bash ops/snapshot-autopublish.sh`, and bash does not need the exec bit.
 * The failure appears only under systemd, i.e. only in production.
 *
 * Auditing the rest of the tree found two more units with the same defect
 * (`morphit-release-monitor`, `morphit-treasury-repin`), both of which would fail
 * identically wherever they are installed.
 *
 * The check is deliberately mechanical: parse ExecStart out of each unit, map the
 * /opt/morphit path back to the repo, and stat it. No content inspection — that is
 * exactly the blind spot this closes.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..', '..', '..');
const unitDir = join(repo, 'ops', 'systemd');

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

const units = existsSync(unitDir) ? readdirSync(unitDir).filter((f) => f.endsWith('.service')) : [];
ok('there are shipped systemd units to check', units.length > 0, `found ${units.length}`);

let checked = 0;
for (const unit of units.sort()) {
	const body = readFileSync(join(unitDir, unit), 'utf8');
	for (const line of body.split('\n')) {
		const m = /^ExecStart=[-@+!]*(\S+)/.exec(line.trim());
		if (!m) continue;
		const target = m[1]!;
		// Only repo-shipped scripts are ours to get right; /usr/bin/foo is the
		// distro's problem and /usr/local/lib/morphit/... is installed by a role.
		if (!target.startsWith('/opt/morphit/')) continue;
		const rel = target.slice('/opt/morphit/'.length);
		const abs = join(repo, rel);
		if (!existsSync(abs)) {
			ok(`${unit}: ExecStart target exists (${rel})`, false, 'file not found in repo');
			continue;
		}
		checked++;
		const mode = statSync(abs).mode;
		const isExec = (mode & 0o111) !== 0;
		ok(
			`${unit}: ${rel} is executable`,
			isExec,
			isExec ? '' : `mode ${(mode & 0o777).toString(8)} — systemd cannot exec this; the unit dies with result=exit-code before running a line`
		);
	}
}
ok('at least one repo-shipped ExecStart target was checked', checked > 0, `checked ${checked}`);

// ── Hazard classes, all learned the hard way in one evening ──────────
// Each of these only manifests under systemd, which is to say only in
// production, which is why none of them were caught by review or by the
// 130-odd text-matching assertions that already covered this code.
for (const unit of units.sort()) {
	const body = readFileSync(join(unitDir, unit), 'utf8');
	const nnp = /NoNewPrivileges=true/.test(body);
	const m = /^ExecStart=[-@+!]*(\S+)/m.exec(body);
	if (!m || !m[1]!.startsWith('/opt/morphit/')) continue;
	const rel = m[1]!.slice('/opt/morphit/'.length);
	const abs = join(repo, rel);
	if (!existsSync(abs)) continue;
	const src = readFileSync(abs, 'utf8');
	// Strip comments AND single/double-quoted strings: every "hazard" found in
	// the monitor scripts turned out to be the word `sudo` inside operator hint
	// text ("install fail2ban: sudo apt install -y fail2ban"). A guard that
	// cannot tell advice from an invocation just trains people to ignore it.
	const code = src
		.split('\n')
		.filter((l) => !l.trim().startsWith('#'))
		.join('\n')
		.replace(/'[^']*'/g, "''")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""');

	if (nnp) {
		ok(
			`${unit}: no sudo under NoNewPrivileges (sudo is setuid and refuses; use runuser)`,
			!/(^|[;&|(]\s*|\$\()\s*sudo\s/m.test(code),
			'sudo cannot run in this unit'
		);
	}
	ok(
		`${unit}: no failure path silences the child it is reporting on`,
		!/2>\/dev\/null[^\n]*\|\|\s*die/.test(code),
		'the cause of the failure would be discarded'
	);
}

// ── EXDEV: moving OUT of the OS temp dir into a persistent path ──────
// Under PrivateTmp=true systemd gives the service its own /tmp on a tmpfs, so
// rename(2) across that boundary fails with EXDEV — the publish timer's second
// failure tonight. The risky shape is narrow: a temp created in the OS temp dir
// and renamed somewhere persistent. A `<target>.tmp` beside its target (the
// normal atomic-write pattern) is same-filesystem by construction and fine, and
// shell `mv` falls back to copy on EXDEV anyway. Guarding renameSync in general
// would flag five safe call sites and teach people to ignore this.
for (const rel of [
	'apps/indexer/scripts/snapshot-export.ts',
	'apps/indexer/scripts/snapshot-bootstrap.ts'
]) {
	const src = readFileSync(join(repo, rel), 'utf8');
	const usesOsTmp = /mkdtempSync\(\s*join\(\s*tmpdir\(\)/.test(src) || /tmpdir\(\)/.test(src);
	const renames = /renameSync\(/.test(src);
	if (!usesOsTmp || !renames) continue;
	// Check the CATCH BLOCK, not the file. `copyFileSync` also appears in the
	// import line, so a file-wide match stayed green with the fallback gutted —
	// the third time tonight a guard matched a comment or an import instead of
	// the code it was meant to protect.
	const code = src
		.split('\n')
		.filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
		.join('\n');
	const fallback = /catch \(e\)[\s\S]{0,400}?EXDEV[\s\S]{0,200}?copyFileSync\([\s\S]{0,120}?unlinkSync\(/.test(code);
	ok(
		`${rel}: a move out of the OS temp dir survives a cross-device boundary (PrivateTmp)`,
		fallback,
		'rename() would fail with EXDEV under systemd PrivateTmp'
	);
}

console.log('');
if (fails.length > 0) {
	console.error(`✗ ${fails.length} systemd-execstart-executable scenario(s) failed:`);
	for (const f of fails) console.error(`   - ${f}`);
	process.exit(1);
}
console.log(`✓ all ${pass} systemd-execstart-executable scenarios passed`);
