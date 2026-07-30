/**
 * upgrade-notify-smoke.ts (cp598) — guards the desktop "an upgrade is available"
 * notification (ops/desktop/*.sh).  Ken: when a new release lands, a system
 * notification should pop up on grandma's screen telling her to run
 * `sudo morphit-ops` and upgrade.
 *
 * We can't render a real toast in CI, so this asserts the STRUCTURE + SAFETY:
 *   - the notifier compares the RUNNING version (/v1/health) to the LATEST
 *     on-chain release (/v1/release) with a version-aware check, and only
 *     notifies when latest is strictly NEWER — via curl only (no Node/repo);
 *   - it is NON-FATAL + quiet (never errors out the user session) and notifies
 *     ONCE per new version (state file, written only if the toast fired);
 *   - the toast tells the user exactly what to do: `sudo morphit-ops`;
 *   - the notifier is a USER script (does NOT require root); the SETUP is root
 *     and installs a system-wide USER timer that is enabled globally, so it
 *     runs in the desktop user's session where notify-send can reach the screen.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const NOTIFY = join(ROOT, 'ops/desktop/morphit-upgrade-notify.sh');
const SETUP = join(ROOT, 'ops/desktop/morphit-upgrade-notify-setup.sh');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}
function posixParses(path: string): boolean {
	for (const sh of ['dash', 'sh']) {
		const r = spawnSync(sh, ['-n', path], { encoding: 'utf8' });
		if (r.error) continue;
		return r.status === 0;
	}
	return false;
}

const notify = readFileSync(NOTIFY, 'utf8');
const setup = readFileSync(SETUP, 'utf8');

console.log('── upgrade-notify smoke (cp598) ─────────────────────────');

// Notifier — syntax + detection logic.
check('#syntax notifier parses under a POSIX shell (dash -n)', posixParses(NOTIFY));
check('#source reads the RUNNING version from /v1/health', /\/v1\/health/.test(notify));
check('#source reads the LATEST on-chain version from /v1/release', /\/v1\/release/.test(notify));
check(
	'#compare uses a version-aware comparison (sort -V), not lexical',
	/sort -V/.test(notify),
	'lexical compare would treat 1.9.10 < 1.9.7'
);
check(
	'#compare only notifies when latest is strictly newer',
	/\[ "\$RUNNING" = "\$LATEST" \][\s\S]{0,40}exit 0/.test(notify) &&
		/NEWEST="?\$\([\s\S]{0,120}sort -V[\s\S]{0,80}\[ "\$NEWEST" = "\$LATEST" \][\s\S]{0,30}exit 0/.test(notify),
	'must exit when equal, and exit unless the newest of the two is LATEST'
);
check('#curl-only decides via curl, not node/morphit-ops', /curl -fsS/.test(notify) && !/morphit-ops upgrade|npx |tsx /.test(notify));

// Notifier — safety.
check('#nonfatal notify-send absent exits 0', /command -v notify-send[\s\S]{0,40}exit 0/.test(notify));
check('#nonfatal curl absent exits 0', /command -v curl[\s\S]{0,40}exit 0/.test(notify));
check('#nonfatal a missing version exits 0 (indexer not up / no release yet)', /-n "\$RUNNING" \] && \[ -n "\$LATEST" \] \|\| exit 0/.test(notify));
check(
	'#once-per-version skips if this exact latest was already toasted',
	/STATE_FILE[\s\S]{0,120}"\$LATEST"[\s\S]{0,20}exit 0/.test(notify)
);
check(
	'#once-per-version records the version ONLY if the toast fired',
	/if notify-send[\s\S]{0,600}printf '%s\\n' "\$LATEST" > "\$STATE_FILE"/.test(notify),
	'writing state on a failed toast would silently suppress the real notification'
);
check('#action the toast tells the user to run `sudo morphit-ops`', /notify-send[\s\S]{0,400}sudo morphit-ops/.test(notify));
check('#user-scope the notifier does NOT require root (it runs in the user session)', !/id -u.*!=.*0|Run as root/.test(notify));

// Setup — root, installs a system-wide user timer, enabled globally.
check('#syntax setup parses under a POSIX shell (dash -n)', posixParses(SETUP));
check('#setup requires root', /id -u.*-eq 0|Run as root \(sudo\)/.test(setup));
check('#setup installs the notifier to a stable system path', /install -m 0755 "\$HERE\/morphit-upgrade-notify\.sh" "\$LIB\/morphit-upgrade-notify\.sh"/.test(setup));
check('#setup writes USER units under /etc/systemd/user', /USER_UNIT_DIR=\/etc\/systemd\/user/.test(setup) && /morphit-upgrade-notify\.service/.test(setup) && /morphit-upgrade-notify\.timer/.test(setup));
check('#setup service is oneshot running the notifier', /morphit-upgrade-notify\.service[\s\S]{0,500}Type=oneshot[\s\S]{0,120}ExecStart=\$LIB\/morphit-upgrade-notify\.sh/.test(setup));
check('#setup timer checks after login + periodically, persistently', /OnStartupSec=/.test(setup) && /OnUnitActiveSec=/.test(setup) && /Persistent=true/.test(setup) && /WantedBy=timers\.target/.test(setup));
check('#setup enables the timer GLOBALLY (all desktop sessions)', /systemctl --global enable morphit-upgrade-notify\.timer/.test(setup));
check('#setup best-effort installs libnotify-bin for notify-send', /libnotify-bin/.test(setup));

console.log('');
console.log('──────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} upgrade-notify checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} upgrade-notify checks failed`);
	process.exit(1);
}
