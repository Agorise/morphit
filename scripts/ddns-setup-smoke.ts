/**
 * ddns-setup-smoke.ts (cp596) — guards the provider-agnostic dynamic-DNS
 * mechanism (ops/ddns/*.sh) that replaces the old DuckDNS / free-hostname idea.
 *
 * We cannot exercise apt/systemd/sudo or a live provider from CI, so this smoke
 * asserts the STRUCTURE + SAFETY properties that must hold:
 *   - both scripts parse under a real POSIX shell (dash — Ubuntu's /bin/sh);
 *   - the updater keeps the provider SECRET off the command line (curl -K a
 *     0600 temp file — never `curl "$URL"`, which would leak via `ps`);
 *   - the updater is NON-FATAL (a DNS hiccup never takes the node down) and
 *     only calls the provider when the IP actually CHANGED;
 *   - the setup writes the secret config 0600 and installs a oneshot service +
 *     a boot/interval timer, then enables it;
 *   - the word "duckdns" appears NOWHERE in the mechanism (Ken: removed).
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const UPDATE = join(ROOT, 'ops/ddns/morphit-ddns-update.sh');
const SETUP = join(ROOT, 'ops/ddns/morphit-ddns-setup.sh');

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

const update = readFileSync(UPDATE, 'utf8');
const setup = readFileSync(SETUP, 'utf8');

console.log('── ddns-setup smoke (cp596) ─────────────────────────────');

// 1. POSIX syntax under a real shell. Prefer dash (Ubuntu /bin/sh); fall back
//    to sh if dash isn't installed on the runner.
function posixParses(path: string): boolean {
	for (const sh of ['dash', 'sh']) {
		const r = spawnSync(sh, ['-n', path], { encoding: 'utf8' });
		if (r.error) continue; // shell not present, try next
		return r.status === 0;
	}
	return false;
}
check('#syntax the updater parses under a POSIX shell (dash -n)', posixParses(UPDATE));
check('#syntax the setup script parses under a POSIX shell (dash -n)', posixParses(SETUP));

// 2. Secret safety — the update URL (which carries the provider key) must reach
//    curl via a config file, NEVER as an argv token that shows in `ps`.
check(
	'#secret the updater pushes via `curl -K` (config file, not argv)',
	/curl\s+-fsS\s+--max-time\s+30\s+-K\s+"\$CFG"/.test(update),
	'expected `curl -fsS --max-time 30 -K "$CFG"`'
);
check(
	'#secret the built URL is never curled directly as an argument',
	!/curl[^\n]*"\$URL"/.test(update),
	'a raw `curl "$URL"` would leak the key via ps'
);
check(
	'#secret the temp config file is created 0600 before the secret is written',
	/mktemp[\s\S]{0,120}chmod 600 "\$CFG"/.test(update) &&
		update.indexOf('chmod 600 "$CFG"') < update.indexOf("printf 'url ="),
	'chmod 600 must precede writing the URL into the temp file'
);

// 3. Non-fatal + change-detection.
check(
	'#robust missing config exits 0 (never fails the node)',
	/URL_TMPL"?\s*\]\s*;\s*then[\s\S]{0,160}exit 0/.test(update) ||
		/-z "\$URL_TMPL"[\s\S]{0,200}exit 0/.test(update),
	'an unconfigured updater must no-op with exit 0'
);
check(
	'#robust curl-absent exits 0',
	/command -v curl[\s\S]{0,80}exit 0/.test(update)
);
check(
	'#idempotent only pushes when the IP changed since last success',
	/STATE_FILE/.test(update) && /\[ "\$IP" = "\$LAST" \][\s\S]{0,120}exit 0/.test(update),
	'must compare current IP to the cached last-pushed IP and skip if equal'
);
check(
	'#substitution the {ip} token is replaced with the detected IP',
	/sed "s\|\{ip\}\|\$IP\|g"/.test(update)
);

// 4. Setup: secret config 0600 + units + enable.
check('#setup writes /etc/morphit/ddns.env then chmod 600', /ENV_FILE=\/etc\/morphit\/ddns\.env/.test(setup) && /chmod 600 "\$ENV_FILE"/.test(setup));
check('#setup refuses to run without MORPHIT_DDNS_UPDATE_URL', /-z "\$URL"[\s\S]{0,400}exit 1/.test(setup));
check('#setup installs the updater to a stable system path', /install -m 0755 "\$HERE\/morphit-ddns-update\.sh" "\$LIB\/morphit-ddns-update\.sh"/.test(setup));
check('#setup writes a oneshot service', /morphit-ddns\.service[\s\S]{0,400}Type=oneshot/.test(setup));
check('#setup service retries transient failures (SuccessExitStatus=0 1)', /SuccessExitStatus=0 1/.test(setup));
check('#setup service is hardened (ProtectSystem=strict, NoNewPrivileges)', /ProtectSystem=strict/.test(setup) && /NoNewPrivileges=true/.test(setup));
check('#setup writes a timer that fires on boot + on a schedule, persistently', /morphit-ddns\.timer[\s\S]{0,400}OnBootSec=/.test(setup) && /OnCalendar=\$TIMER_CALENDAR/.test(setup) && /Persistent=true/.test(setup) && /WantedBy=timers\.target/.test(setup));
check('#setup reloads systemd and enables the timer', /systemctl daemon-reload/.test(setup) && /systemctl enable --now morphit-ddns\.timer/.test(setup));

// 5. No DuckDNS anywhere in the mechanism (Ken removed the free-hostname idea).
check('#no-duckdns "duckdns" appears nowhere in the ddns mechanism', !/duckdns/i.test(update) && !/duckdns/i.test(setup));

// 6. Provider-agnostic: the examples name real registrars, not a single hardcoded one.
check('#agnostic the header documents at least Njalla + Namecheap as examples', /njal\.la/i.test(update) && /namecheap|park-your-domain/i.test(update));

console.log('');
console.log('──────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} ddns-setup checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} ddns-setup checks failed`);
	process.exit(1);
}
