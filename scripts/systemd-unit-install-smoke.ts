/**
 * systemd-unit-install smoke (beta14).
 *
 * Guards `ops/scripts/install-systemd-units.sh` — the installer that
 * re-points the core systemd units at whatever path the repo was
 * actually cloned to (the `~/morphit`-vs-`/opt/morphit` fix that
 * retires the old `systemctl edit` drop-in note).
 *
 * What it checks:
 *
 *   1. The installer exists and is a real script (shebang).
 *   2. It self-locates the repo root from its own location
 *      (so it works wherever you cloned), substitutes the hardcoded
 *      `/opt/morphit` base, and runs `systemctl daemon-reload`.
 *   3. It targets exactly the three monorepo services
 *      (indexer / relay / matrix-bot) — and NOT morphit-mcp or the
 *      mint-acts oneshot, whose separate restricted directories are
 *      a deliberate least-privilege isolation.
 *   4. Applying the installer's substitution to each core unit with
 *      a sentinel checkout path leaves NO `/opt/morphit` behind,
 *      lands the sentinel path in WorkingDirectory, and preserves
 *      the [Unit]/[Service]/[Install] structure.
 *   5. The mcp + mint-acts units still reference their own isolated
 *      directories (isolation not flattened).
 *   6. Inline-comment guard: no unit file carries an inline `#`
 *      comment on a directive line — systemd treats it as part of
 *      the value and silently misparses it (the matrix-bot
 *      `MemoryDenyWriteExecute` defect fixed in the same pass).
 *
 * Runtime: a few ms (pure file reads + string ops). No root, no
 * systemd needed — it tests the substitution logic, not the live
 * `systemctl` behaviour (which is the operator's real-box step).
 *
 * To tamper-test: re-introduce an inline comment in any unit, or
 * point the installer at a different DEFAULT_DIR, and re-run.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const INSTALLER = join(REPO, 'ops/scripts/install-systemd-units.sh');
const UNIT_DIR = join(REPO, 'ops/systemd');

const DEFAULT_DIR = '/opt/morphit';
const SENTINEL = '/home/tester/morphit-checkout';
const CORE_UNITS = [
	'morphit-indexer.service',
	'morphit-relay.service',
	'morphit-matrix-bot.service'
];
const ISOLATED_UNITS = ['morphit-mcp.service', 'morphit-relay-mint-acts.service'];

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
const check = (name: string, passed: boolean, detail?: string) =>
	results.push({ name, passed, detail });

// ── 1. Installer exists + is a script ──────────────────────────────
const installerExists = existsSync(INSTALLER);
check('installer script exists at ops/scripts/install-systemd-units.sh', installerExists);

const installer = installerExists ? readFileSync(INSTALLER, 'utf8') : '';
check(
	'installer has a shebang',
	installer.startsWith('#!') && /bash/.test(installer.split('\n')[0])
);

// ── 2. Self-locating + substitution + daemon-reload ────────────────
check(
	'installer self-locates repo root from its own path',
	/BASH_SOURCE\[0\]/.test(installer) && /\.\.\/\.\./.test(installer)
);
check(
	`installer rewrites the hardcoded ${DEFAULT_DIR} base`,
	installer.includes(`DEFAULT_DIR="${DEFAULT_DIR}"`) &&
		/sed "s#\$\{DEFAULT_DIR\}#\$\{REPO_DIR\}#g"/.test(installer)
);
check('installer runs systemctl daemon-reload', /systemctl daemon-reload/.test(installer));

// ── 3. Targets the 3 monorepo units, not the isolated ones ─────────
for (const u of CORE_UNITS) {
	check(`installer targets ${u}`, installer.includes(u));
}
for (const u of ISOLATED_UNITS) {
	check(
		`installer does NOT touch ${u} (isolation preserved)`,
		!installer.includes(u)
	);
}

// ── 4. Substitution correctness on each core unit ──────────────────
const substitute = (text: string) => text.split(DEFAULT_DIR).join(SENTINEL);
for (const u of CORE_UNITS) {
	const p = join(UNIT_DIR, u);
	if (!existsSync(p)) {
		check(`${u} present in ops/systemd/`, false, `missing: ${p}`);
		continue;
	}
	const out = substitute(readFileSync(p, 'utf8'));
	check(`${u}: no ${DEFAULT_DIR} survives substitution`, !out.includes(DEFAULT_DIR));
	const wd = out.split('\n').find((l) => l.startsWith('WorkingDirectory='));
	check(
		`${u}: WorkingDirectory points into the checkout`,
		wd !== undefined && wd.includes(SENTINEL)
	);
	check(
		`${u}: [Unit]/[Service]/[Install] sections preserved`,
		out.includes('[Unit]') && out.includes('[Service]') && out.includes('[Install]')
	);
}

// ── 5. Isolated units keep their own restricted dirs ───────────────
{
	const mcp = join(UNIT_DIR, 'morphit-mcp.service');
	const mint = join(UNIT_DIR, 'morphit-relay-mint-acts.service');
	check(
		'morphit-mcp keeps its own /opt/morphit-mcp dir',
		existsSync(mcp) && readFileSync(mcp, 'utf8').includes('/opt/morphit-mcp')
	);
	check(
		'morphit-relay-mint-acts keeps its own /opt/morphit-relay dir',
		existsSync(mint) && readFileSync(mint, 'utf8').includes('/opt/morphit-relay')
	);
}

// ── 6. Inline-comment guard across ALL units ───────────────────────
// systemd only treats a line as a comment when it STARTS with '#'
// (or ';'); an inline '# ...' after a directive value is parsed as
// part of the value and misparsed. Flag any directive line carrying
// a '#'.
{
	const fs = readFileSync; // alias to keep the loop terse
	const allUnits = [...CORE_UNITS, ...ISOLATED_UNITS];
	const offenders: string[] = [];
	for (const u of allUnits) {
		const p = join(UNIT_DIR, u);
		if (!existsSync(p)) continue;
		const lines = fs(p, 'utf8').split('\n');
		lines.forEach((line, i) => {
			// A directive line looks like Key=Value. Comments/sections
			// start with # or [. Documentation= URLs legitimately have
			// no '#'. If a Key=Value line contains '#', it's an inline
			// comment (or a stray '#') systemd would misparse.
			if (/^[A-Za-z][A-Za-z0-9]*=/.test(line) && line.includes('#')) {
				offenders.push(`${u}:${i + 1}  ${line.trim()}`);
			}
		});
	}
	check(
		'no unit carries an inline # comment on a directive line',
		offenders.length === 0,
		offenders.join('\n      ')
	);
}

// ── report ─────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log(`  ${ANSI_GREEN}✓${ANSI_RESET} ${r.name}`);
	} else {
		console.log(`  ${ANSI_RED}✗${ANSI_RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`✗ ${failed} of ${results.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(`✓ all ${results.length} scenarios passed`);
}
