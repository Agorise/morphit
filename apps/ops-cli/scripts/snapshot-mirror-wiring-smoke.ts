#!/usr/bin/env tsx
/**
 * apps/ops-cli/scripts/snapshot-mirror-wiring-smoke.ts
 *
 * Guards the two things this release fixes that a pure-logic smoke cannot see:
 *
 * 1. THE ORPHAN. `snapshot-autopublish.sh`, `pin-indexer-snapshot.sh` and both
 *    publish systemd units existed in the tree for releases while NOTHING
 *    installed, enabled or triggered them — a complete engine with no ignition.
 *    So the newest published snapshot was whatever someone last made by hand,
 *    and a newcomer's fast-sync tail grew by ~28,800 blocks every day. Shipped
 *    units that no role installs are invisible to every other smoke, so this one
 *    asserts the whole chain: script → unit → timer → Ansible → upgrade.
 *
 * 2. THE BASHISM. The v1.17.2 seeder self-verify used `${@:3}`, which is a bash
 *    substring expansion. /bin/sh is dash on Ubuntu and dies "Bad substitution"
 *    the first time the helper is called — under `set -eu` that aborted the
 *    whole self-verify block AND the CID echo after it, so the release's
 *    flagship per-transport check never ran on a single real box. A syntax-only
 *    check would not have caught it either (dash parses the definition fine and
 *    only fails at CALL time), so the guard is textual.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => {
	const p = join(repo, rel);
	return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

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

const seed = read('ops/ipfs/morphit-ipfs-seed.sh');
const heal = read('ops/ipfs/morphit-gateway-firewall-heal.sh');
const mirrorSh = read('ops/snapshot-mirror.sh');
const mirrorTs = read('apps/indexer/scripts/snapshot-mirror.ts');
const mirrorSvc = read('ops/systemd/morphit-snapshot-mirror.service');
const mirrorTimer = read('ops/systemd/morphit-snapshot-mirror.timer');
const publishSvc = read('ops/systemd/morphit-snapshot-publish.service');
const publishTimer = read('ops/systemd/morphit-snapshot-publish.timer');
const ipfsRole = read('ops/ansible/roles/ipfs/tasks/main.yml');
const ipfsDefaults = read('ops/ansible/roles/ipfs/defaults/main.yml');
const bunkerRole = read('ops/ansible/roles/bunkerweb/tasks/main.yml');
const upgrade = read('apps/ops-cli/src/commands/upgrade.ts');
const bootstrap = read('apps/indexer/scripts/snapshot-bootstrap.ts');

// ── A. POSIX safety in the shipped /bin/sh scripts ───────────────────
for (const [name, body] of [
	['morphit-ipfs-seed.sh', seed],
	['morphit-gateway-firewall-heal.sh', heal]
] as const) {
	const src = body.replace(/^\s*#.*$/gm, ''); // ignore comments (they discuss the bug)
	ok(`${name}: declares /bin/sh`, /^#!\/bin\/sh/.test(body));
	ok(
		`${name}: no \${@:n} / \${*:n} bashism (dash dies "Bad substitution" at call time)`,
		!/\$\{[@*]:[0-9]/.test(src)
	);
	// `[[:space:]]` etc. are POSIX character classes inside a bracket expression,
	// not the bash `[[ ]]` keyword — exclude them or every sed in the tree trips.
	ok(`${name}: no [[ ]] bashism`, !/\[\[(?!:)/.test(src));
	ok(`${name}: no <<< herestring bashism`, !/<<</.test(src));
	ok(`${name}: no mapfile/readarray bashism`, !/\b(mapfile|readarray)\b/.test(src));
}

// ── B. The seeder's probes can't kill the script or cry wolf ─────────
ok(
	'seed: the curl helper swallows curl\'s exit status (a refused probe is the thing being diagnosed, not a reason to abort under set -e)',
	/_code\(\)[\s\S]{0,400}?\|\|\s*true/.test(seed)
);
ok(
	'seed: the frontend probe pins the real hostname to loopback (--resolve), because BunkerWeb 403s a Host: 127.0.0.1 request on a HEALTHY box',
	/--resolve/.test(seed) && /MORPHIT_INSTANCE_ORIGIN/.test(seed)
);
ok(
	'seed: a 403/429 from our own probe is reported as INCONCLUSIVE, not as a firewall fault',
	/403/.test(seed) && /429/.test(seed) && /inconclusive/i.test(seed)
);
ok(
	'seed: reachability probes use the small sibling file, not the ~33 MB tarball (a hidden-transport body fetch outruns any sane timeout)',
	/PROBE_PATH=/.test(seed) && /metadata\.json/.test(seed)
);
ok('seed: still checks Tor end to end', /socks5-hostname/.test(seed));
ok('seed: still checks I2P end to end', /4444/.test(seed));

// ── C. Firewall self-heal: exists, multi-strategy, verifies, never fails ──
ok('heal script is shipped', heal.length > 0);
ok('heal: observes from INSIDE the frontend container (the only honest vantage point)', /docker exec/.test(heal));
ok('heal: strategy A is ufw', /ufw allow from/.test(heal));
ok('heal: strategy B falls through to iptables', /iptables -I INPUT/.test(heal));
ok('heal: strategy C restarts the frontend', /docker restart/.test(heal));
ok('heal: re-probes to VERIFY rather than trusting an exit code', (heal.match(/probe\b/g) ?? []).length >= 4);
ok('heal: reads the CIDR from the real docker network instead of hardcoding', /docker network inspect/.test(heal));
ok('heal: reads the gateway port from kubo instead of assuming 8082', /ipfs config Addresses\.Gateway/.test(heal));
ok('heal: distinguishes "gateway not listening" from "firewall dropping"', /not LISTENING/.test(heal));
ok('heal: says which strategy worked', /healed via/.test(heal));
ok('heal: always exits 0 — can never fail an upgrade', !/exit 1/.test(heal));
ok(
	'heal: VALIDATES the discovered subnet is RFC1918 before opening a port to it (a bogus or over-wide answer must never become a firewall rule)',
	/192\.168\.\*\/\*/.test(heal) && /ignoring non-private subnet/.test(heal)
);
ok('heal: the fallback on an invalid subnet is the pinned CIDR, never a wider one', /CIDR="\$FALLBACK_CIDR"/.test(heal));
ok(
	'upgrade runs the heal BEFORE seeding, so the seed verifies an already-healed path',
	upgrade.indexOf('morphit-gateway-firewall-heal.sh') > 0 &&
		upgrade.indexOf('morphit-gateway-firewall-heal.sh') < upgrade.indexOf('morphit-ipfs-seed.sh')
);

// ── D. The mirror chain: script → unit → timer → Ansible → upgrade ───
ok('mirror shell wrapper is shipped', mirrorSh.length > 0);
ok('mirror TS job is shipped', mirrorTs.length > 0);
ok('mirror systemd service is shipped', mirrorSvc.length > 0);
ok('mirror systemd timer is shipped', mirrorTimer.length > 0);
ok('mirror service ExecStart points at the shipped wrapper', /ExecStart=.*snapshot-mirror\.sh/.test(mirrorSvc));
ok('mirror timer runs the mirror service', /Unit=morphit-snapshot-mirror\.service/.test(mirrorTimer));
ok(
	'mirror timer fires periodically so a box that never upgrades again stays current',
	/OnUnitActiveSec=/.test(mirrorTimer) && /Persistent=true/.test(mirrorTimer)
);
ok('mirror timer spreads the federation out (no thundering herd on the DHT)', /RandomizedDelaySec=/.test(mirrorTimer));

ok('ANSIBLE installs the mirror service', /morphit-snapshot-mirror\.service/.test(ipfsRole));
ok('ANSIBLE installs the mirror timer', /morphit-snapshot-mirror\.timer/.test(ipfsRole));
ok('ANSIBLE enables + starts the mirror timer', /name: morphit-snapshot-mirror\.timer[\s\S]{0,200}enabled: true/.test(ipfsRole));
ok('ANSIBLE installs the publish units too (they were orphaned in the tree)', /morphit-snapshot-publish\.service/.test(ipfsRole));
ok(
	'publishing is OFF by default — an ordinary instance must never start signing snapshots under its own account',
	/morphit_snapshot_publisher: false/.test(ipfsDefaults) &&
		/morphit_snapshot_publisher \| default\(false\)/.test(ipfsRole)
);
ok('UPGRADE refreshes the mirror on every upgrade', /snapshot-mirror\.sh/.test(upgrade));
ok('upgrade only mirrors when this box actually runs IPFS', /systemctl is-active --quiet ipfs/.test(upgrade));

// ── E. The mirror job verifies before it serves ──────────────────────
ok('mirror: reads the newest SIGNED op, not an arbitrary CID', /selectNewestSnapshotOp/.test(mirrorTs));
ok('mirror: gates on chain_id', /chain_id/.test(mirrorTs));
ok('mirror: verifies the pinned bytes against the on-chain sha256', /createHash\('sha256'\)/.test(mirrorTs));
ok('mirror: unpins rather than serving bytes it could not verify', /pin', 'rm'/.test(mirrorTs));
ok('mirror: replaces the superseded snapshot (never accumulates)', /superseded/.test(mirrorTs));
ok('mirror: re-asserts the pin when kubo no longer holds it (state file alone is not proof)', /pin', 'ls'/.test(mirrorTs));
ok('mirror: never fails the caller', /process\.exit\(0\)/.test(mirrorTs));

// ── F. Fast-sync reaches zero-clearnet nodes ─────────────────────────
ok('bootstrap builds its sources through the mirror resolver', /buildSnapshotSources/.test(bootstrap));
ok('bootstrap discovers peers from the chain history it already fetched', /extractPeerAddressesFromHistory/.test(bootstrap));
ok('bootstrap routes .onion fetches through Tor SOCKS with in-Tor DNS', /--socks5-hostname/.test(bootstrap));
ok('bootstrap routes .b32.i2p fetches through the i2pd proxy', /I2P_HTTP_PROXY/.test(bootstrap));
ok(
	'bootstrap fails CLOSED on a hidden-only node with no private source (never silently reaches for clearnet)',
	/hidden-only and no federation peer/.test(bootstrap)
);

// ── G. The firewall rule still exists on the Ansible path ────────────
ok('ansible still opens the gateway port to the bunkerweb CIDR', /IPFS gateway \(hidden release seeding\)/.test(bunkerRole));
ok('…gated on this box actually hosting IPFS', /enable_ipfs \| default\(true\) \| bool/.test(bunkerRole));

// ── H. Publisher stays single-signer ────────────────────────────────
ok('publish timer exists for the canonical box', publishTimer.length > 0 && publishSvc.length > 0);
const autopub = read('ops/snapshot-autopublish.sh');
const pinScript = read('ops/pin-indexer-snapshot.sh');
ok('publish job still guards on being caught up before anchoring anything', /sync\.behind/.test(autopub));
ok(
	'publish job reads the payload path the pin script TELLS it, instead of scanning the filesystem for it',
	/MORPHIT_SNAPSHOT_PAYLOAD=/.test(pinScript) && /MORPHIT_SNAPSHOT_PAYLOAD=/.test(autopub)
);
ok(
	'publish job no longer runs a whole-filesystem `find /` scan',
	!/find \/ -maxdepth/.test(autopub.replace(/^\s*#.*$/gm, ''))
);
ok(
	'publish job logs the snapshot size every run, so growth is visible before it becomes a problem',
	/kB\)/.test(autopub) && /SNAP_BYTES/.test(autopub)
);
ok(
	'the superseded spec points readers at what actually shipped',
	/SUPERSEDED IN PART/.test(read('docs/FEDERATED-INDEXER-SNAPSHOT-SPEC.md')) &&
		/OPERATIONS\.md §52/.test(read('docs/FEDERATED-INDEXER-SNAPSHOT-SPEC.md'))
);

// ── I. v1.17.3 — the real-upgrade regressions ───────────────────────
const canarySetup = read('scripts/canary/setup.sh');
const canaryGen = read('scripts/canary/generate.sh');
const deployMcp = read('ops/scripts/deploy-mcp.sh');

// `grep` exits 1 on no-match; `pipefail` propagates it; a command-substitution
// assignment returning non-zero aborts the script. This killed canary SETUP right
// after the operator-name prompt on every instance whose config lacked the key,
// and sat in the weekly REFRESH too, where it would have let a published canary
// go stale silently. Guard both.
for (const [name, body] of [
	['canary setup.sh', canarySetup],
	['canary generate.sh', canaryGen]
] as const) {
	const risky = body
		.split('\n')
		.filter((l) => !l.trim().startsWith('#'))
		.filter((l) => /^\s*\w+="?\$\(/.test(l) && /\bgrep\b/.test(l) && !/\|\|\s*true/.test(l));
	ok(
		`${name}: no grep-in-assignment can abort the script under \`set -euo pipefail\``,
		risky.length === 0,
		risky.map((l) => l.trim().slice(0, 80)).join(' | ')
	);
}
ok('canary setup falls back to more than one source for the instance origin', /MORPHIT_INSTANCE_ORIGIN/.test(canarySetup));
ok('canary setup offers a Tor-only box its .onion as the origin default', /var\/lib\/tor/.test(canarySetup));

// The seeder runs as the unprivileged `ipfs` user and cannot read Tor's hostname
// file, so every instance reported "no hidden address configured".
ok('upgrade resolves the box\u2019s own addresses as root and passes them down', /seedAddrArgs/.test(upgrade));
ok('seeder accepts the caller-resolved addresses', /MORPHIT_SEED_ONION/.test(seed) && /MORPHIT_SEED_ORIGIN/.test(seed));
ok('seeder tries more than one source for the public origin', /MORPHIT_INDEXER_PUBLIC_ORIGIN/.test(seed));
ok(
	'seeder NEVER reads a hidden address from indexer.env (that file lists OTHER operators\u2019 Blurt RPC onions \u2014 probing one would report a stranger\u2019s node as our seeder)',
	/deliberately NOT \/etc\/morphit\/indexer\.env/.test(seed) &&
		!/_onion=\$\(grep[^\n]*indexer\.env/.test(seed)
);
ok('seeder names where it looked when it finds no origin', /looked in MORPHIT_SEED_ORIGIN/.test(seed));

// Ansible never runs on a hand-built install, so the upgrade must install the
// timer itself or the whole feature is inert on the canonical box.
ok('upgrade installs + enables the mirror timer itself (Ansible never runs on a manual install)',
	/enable', '--now', 'morphit-snapshot-mirror\.timer/.test(upgrade));
ok('timer install is idempotent (skips an identical unit already in place)', /=== incoming\) continue/.test(upgrade));

ok('npm update-notifier is silenced at the last step that can emit it', /npm_config_update_notifier=false/.test(deployMcp));

console.log('');
if (fails.length > 0) {
	console.error(`✗ ${fails.length} snapshot-mirror-wiring scenario(s) failed:`);
	for (const f of fails) console.error(`   - ${f}`);
	process.exit(1);
}
console.log(`✓ all ${pass} snapshot-mirror-wiring scenarios passed`);
