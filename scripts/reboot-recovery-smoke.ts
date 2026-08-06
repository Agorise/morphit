/**
 * reboot-recovery-smoke.ts (cp597) — enforces UNATTENDED recovery.
 *
 * Ken's hard requirement: after a power cut and/or an ISP IP change, grandma's
 * node must come back online AND be reachable again with ZERO intervention —
 * she only turns the PC back on.  Home or VPS, no exceptions.
 *
 * We can't reboot a real box in CI, so this asserts every link in the recovery
 * chain that makes "just turn it on" true:
 *   1. the always-on services (indexer, relay, mcp) auto-START on boot
 *      ([Install] WantedBy), auto-RESTART on failure with a paced RestartSec,
 *      and NEVER latch into a permanent 'failed' state (StartLimitIntervalSec=0)
 *      while a dependency is still coming up;
 *   2. indexer + relay wait for the network AND Docker (the DB is a container),
 *      so they don't fail-fast before the DB even exists;
 *   3. the relay unlocks its encrypted active key UNATTENDED at boot
 *      (systemd encrypted credential — no passphrase prompt);
 *   4. the reverse proxy + dockerised DB survive a power cut (restart policy);
 *   5. the Ansible install ENABLES the services + the Docker/Postgres daemons;
 *   6. dynamic DNS re-pushes the (possibly new) IP right after boot
 *      (OnBootSec + Persistent), so a home node is reachable again on its own.
 *
 * If any of these regress, "she just turns it on" quietly breaks — hence a smoke.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SYSTEMD = join(ROOT, 'ops/systemd');

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

/** Effective directive lines of a unit file (comments + blanks stripped), so a
 *  comment that merely NAMES a directive can never satisfy a check. */
function directives(unit: string): string[] {
	return readFileSync(join(SYSTEMD, unit), 'utf8')
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith('#'));
}
const has = (lines: string[], re: RegExp): boolean => lines.some((l) => re.test(l));

console.log('── reboot-recovery smoke (cp597) ────────────────────────');

// 1 + 2 — always-on services.
for (const svc of ['morphit-indexer.service', 'morphit-relay.service', 'morphit-mcp.service']) {
	const d = directives(svc);
	check(`#autostart ${svc} has [Install] WantedBy (enabled = auto-starts on boot)`, has(d, /^WantedBy=/));
	check(`#restart ${svc} restarts automatically (Restart=on-failure|always)`, has(d, /^Restart=(on-failure|always)$/));
	check(`#pace ${svc} spaces restarts (RestartSec set)`, has(d, /^RestartSec=/));
	check(
		`#no-deadlatch ${svc} disables the start-rate-limit (StartLimitIntervalSec=0)`,
		has(d, /^StartLimitIntervalSec=0$/),
		'without this a fast fail-loop at boot (DB not ready yet) can latch the unit failed forever'
	);
	check(`#net-order ${svc} waits for the network (After=…network-online…)`, has(d, /^After=.*network-online\.target/));
}
// indexer + relay must also wait for the Docker daemon (containerised DB).
for (const svc of ['morphit-indexer.service', 'morphit-relay.service']) {
	check(`#docker-order ${svc} waits for docker.service (the DB is a container)`, has(directives(svc), /^After=.*docker\.service/));
}

// 3 — relay unattended unlock (no passphrase prompt after a reboot).
check(
	'#unattended-unlock the relay decrypts its active key via a systemd encrypted credential',
	has(directives('morphit-relay.service'), /^LoadCredentialEncrypted=relay_passphrase:/),
	'a plaintext prompt would mean the relay never comes back without grandma typing it'
);

// 4 — reverse proxy + dockerised DB survive a power cut.
for (const rel of ['ops/bunkerweb/docker-compose.yml', 'ops/ansible/roles/bunkerweb/templates/docker-compose.yml.j2']) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	const restarts = [...text.matchAll(/^\s*restart:\s*(\S+)/gm)].map((m) => m[1]);
	check(`#proxy-restart ${rel} sets a restart policy on every service (≥3)`, restarts.length >= 3, `found ${restarts.length}`);
	check(
		`#proxy-restart ${rel} every restart policy is always/unless-stopped`,
		restarts.length > 0 && restarts.every((r) => r === 'unless-stopped' || r === 'always'),
		`saw: ${restarts.join(', ') || '(none)'}`
	);
}

// 5 — Ansible ENABLES the pieces (so they auto-start on the grandma install).
const morphitRole = readFileSync(join(ROOT, 'ops/ansible/roles/morphit/tasks/main.yml'), 'utf8');
for (const name of ['morphit-indexer', 'morphit-relay']) {
	const re = new RegExp(`name:\\s*${name}\\s*\\n\\s*enabled:\\s*true\\s*\\n\\s*state:\\s*started`, 'm');
	check(`#ansible-enable morphit role enables + starts ${name}`, re.test(morphitRole));
}
check(
	'#ansible-enable postgres role enables the postgresql daemon',
	/name:\s*postgresql\s*\n\s*enabled:\s*true/m.test(readFileSync(join(ROOT, 'ops/ansible/roles/postgres/tasks/main.yml'), 'utf8'))
);
check(
	'#ansible-enable bunkerweb role enables the docker daemon',
	/name:\s*docker\s*\n\s*enabled:\s*true/m.test(readFileSync(join(ROOT, 'ops/ansible/roles/bunkerweb/tasks/main.yml'), 'utf8'))
);

// 6 — dynamic DNS re-pushes the IP right after boot (home reachability).
const ddns = readFileSync(join(ROOT, 'ops/ddns/morphit-ddns-setup.sh'), 'utf8');
check('#ddns-boot the ddns timer fires shortly after boot (OnBootSec)', /morphit-ddns\.timer[\s\S]{0,400}OnBootSec=/.test(ddns));
check('#ddns-boot the ddns timer is Persistent (catches a missed boot tick)', /Persistent=true/.test(ddns));
check('#ddns-boot the ddns timer auto-starts on boot (enabled)', /systemctl enable --now morphit-ddns\.timer/.test(ddns));

console.log('');
console.log('──────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} reboot-recovery checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} reboot-recovery checks failed`);
	process.exit(1);
}
