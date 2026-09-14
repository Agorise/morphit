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

// The first heal probe asked for /api/v0/version — kubo's RPC API (port 5001),
// not a gateway path — and took wget's exit code as the verdict. The gateway
// 404'd it, busybox wget exited non-zero, and the script declared every box
// unreachable regardless of the firewall. Confirmed on morphit.io, where the
// seeder proved the same gateway was serving /ipfs/ fine in the same run.
ok(
	'heal probes a GATEWAY path, never the RPC API (the gateway on 8082 serves only /ipfs/ and /ipns/)',
	!/api\/v0\/version/.test(heal.replace(/^\s*#.*$/gm, '')) &&
		/host\.docker\.internal:\$\{PORT\}\/ipfs\//.test(heal)
);
ok(
	'heal treats ANY HTTP reply as reachable — a 400/404 proves the hop, only a timeout or refusal does not',
	/\*HTTP\/\*\) return 0/.test(heal)
);
ok(
	'seeder falls back to BunkerWeb SERVER_NAME for the origin (the one key that is always set)',
	/bunkerweb\.env/.test(seed) && /SERVER_NAME/.test(seed)
);
ok(
	'upgrade resolves the origin from SERVER_NAME too',
	/bunkerweb\.env'\), 'SERVER_NAME'/.test(upgrade)
);

// ── J. v1.17.4 — what three real upgrades showed ────────────────────
// the maintainer's standing rule: NO STEP RUNS SILENT. Every pause long enough to look like
// a hang must turn the braille spinner.
ok('upgrade wraps its silent steps in a spinner', /runStepWithSpinner/.test(upgrade));
ok(
	'the spinner runner uses async spawn, not spawnSync (spawnSync BLOCKS the event loop, so a wrapped spinner would sit frozen)',
	/spawn\(cmd/.test(upgrade) && /startDotsSpinner/.test(upgrade)
);
for (const step of ['npm ci', 'MCP server', 'IPFS', 'snapshot mirror']) {
	ok(`  …including: ${step}`, new RegExp(step.replace(/ /g, '\\s')).test(upgrade));
}

// All three instances reported "no public origin"/"no hidden address" while
// plainly having both: the settings live in morphit.env, which nothing read.
ok('seeder reads morphit.env, not just morphit.config.env', /ALTCFG=\/opt\/morphit\/morphit\.env/.test(seed));
ok('seeder looks for hidden addresses in morphit.env too', /"\$CFG" "\$ALTCFG"/.test(seed));
ok('upgrade reads morphit.env root-side too', /morphit\.env'\)/.test(upgrade));
ok(
	'the no-hidden-address line no longer claims the box "seeds over clearnet only" (it said that on a zero-clearnet node)',
	!/seeds over clearnet only/.test(seed)
);

// A hidden-only node has no release page, so notes came out blank.
ok('release notes fall back to the tarball on the hidden path', /RELEASE-NOTES\.md/.test(upgrade));

// Operator-facing output must not assert consequences a check did not establish.
ok(
	'heal no longer asserts hidden peers CANNOT upgrade from an unverified check',
	!/CANNOT upgrade from this box/.test(heal)
);
ok('heal says plainly that its check can be wrong', /can be wrong/.test(heal));
ok('heal states that nothing about it blocks the upgrade', /blocks the upgrade/.test(heal));

// ── K. self-row parity (v1.17.4) ────────────────────────────────────
// A node's own directory card was built from columns only the NETWORK probe
// writes — and the probe is skipped for self. So the one instance that had
// actually earned the 🏅 badge (morphitlat, zero-clearnet) was the only one that
// could not see it on its own site, and its status disagreed with every peer.
const probe = read('apps/indexer/src/indexer/federationProbe.ts');
const poller = read('apps/indexer/src/indexer/poller.ts');
const gate = read('apps/indexer/src/indexer/clearnetGate.ts');
const instApi = read('apps/indexer/src/api/instance.ts');

ok('the clearnet legs have ONE definition, shared by /v1/instance and the probe',
	/export function clearnetLegsFromConfig/.test(gate) && /clearnetLegsFromConfig\(config\)/.test(instApi));
ok('the self row writes its own cached_clearnet_eliminated', /cached_clearnet_eliminated = COALESCE/.test(probe));
ok('…from the locally computed gate', /localClearnetEliminated/.test(probe) && /localClearnetEliminated/.test(poller));
ok('COALESCE keeps a peer-observed value when we have none (never clobbers with null)',
	/COALESCE\(\$7, cached_clearnet_eliminated\)/.test(probe));
ok('the self row applies the same orderbook-activity rule peers apply to it',
	/selfStatus = 'quiet'/.test(probe) && /ORDERBOOK_ACTIVITY_GRACE_DAYS/.test(probe));
ok('the self activity lookup can never break the self tick', /label refinement only/.test(probe));
ok(
	'self status is relabelled only on POSITIVE evidence — an unanswered lookup never marks a busy instance quiet',
	/answered === false/.test(probe) && /Only ever relabel on POSITIVE evidence/.test(probe)
);

// ── L. dry-run + publisher self-install (v1.17.4) ───────────────────
const boot = read('apps/indexer/scripts/snapshot-bootstrap.ts');
ok('fast-sync has a --verify-only dry run', /has\('verify-only'\)/.test(boot));
ok(
	'the dry run stops BEFORE any database work, so it is safe from a laptop with no indexer DB',
	boot.indexOf('DRY RUN PASSED') < boot.indexOf('restoring into the indexer DB')
);
// Anchor on the EXIT itself, not on the first `has('verify-only')` — there is now
// an earlier one that defaults unused config, and indexOf would find that instead.
ok('the dry run still proves the bytes (it exits after the sha256/manifest gates)',
	boot.indexOf('refusing.') < boot.indexOf('DRY RUN PASSED'));
ok('the dry run says plainly that nothing was written', /nothing was written/.test(boot));
ok(
	'the dry run defaults the config it never uses, so a rehearsal needs no invented env vars',
	/MORPHIT_INDEXER_DATABASE_URL \?\?=/.test(boot) && /MORPHIT_INDEXER_PUBLIC_ORIGIN \?\?=/.test(boot)
);
ok(
	'…but NEVER defaults the chain id — that is the gate against restoring another chain\u2019s state',
	!/MORPHIT_INDEXER_CHAIN_ID \?\?=/.test(boot) && /still needs MORPHIT_INDEXER_CHAIN_ID/.test(boot)
);
ok('the pin script reports snapshot size in kB, not a floored 0 MB', /SIZE_BYTES\/1024\)\) kB/.test(pinScript));

// The publish timer failed on a box where a hand-run publish always worked:
// PrivateTmp=true puts /tmp on its own tmpfs, and rename() cannot cross devices.
const exportTs = read('apps/indexer/scripts/snapshot-export.ts');
ok(
	'snapshot-export survives a cross-device move (PrivateTmp puts /tmp on another filesystem, so rename() fails with EXDEV under systemd)',
	/EXDEV/.test(exportTs) && /copyFileSync/.test(exportTs) && /unlinkSync/.test(exportTs)
);
ok(
	'…and still rethrows anything that is NOT EXDEV rather than masking a real failure',
	/code !== 'EXDEV'\) throw e/.test(exportTs)
);
ok(
	'the publish script no longer discards the export\u2019s stderr (the cause of a failed export used to be thrown away)',
	!/snapshot-export\.ts --out "\$OUT" 2>\/dev\/null/.test(autopub) && /its output was/.test(autopub)
);
ok(
	'the dry run never queries Postgres — the server-version lookup is the first DB touch and sits BEFORE the early exit',
	/if \(has\('verify-only'\)\) \{\n\t\t\thostPgMajor = manifest\.pgMajor;/.test(boot)
);
ok(
	'…and the compatibility gate still runs in dry-run mode (chain + schema are exactly what it should check)',
	/pgMajor: hostPgMajor/.test(boot) && /verifyManifestCompatible\(manifest, target\)/.test(boot)
);

// The mirror ran bare `ipfs` as root, so kubo looked in /root/.ipfs — an empty
// repo with no daemon — and refused to fetch a CID the box was already serving.
const mirrorTs2 = read('apps/indexer/scripts/snapshot-mirror.ts');
ok('mirror runs kubo as the repo owner, not as root', /IPFS_USER/.test(mirrorTs2) && /IPFS_PATH=\$\{IPFS_REPO\}/.test(mirrorTs2));
ok('mirror pipes ipfs cat through the same privilege drop', /DROP_PRIV\.join\(' '\)/.test(mirrorTs2));
// sudo is setuid-root and REFUSES to run under NoNewPrivileges=true, which both
// snapshot units set. runuser is not setuid, so dropping privileges still works.
for (const [name, body] of [
	['mirror', mirrorTs2],
	['pin script', pinScript]
] as const) {
	ok(`${name}: prefers runuser over sudo (sudo cannot run under NoNewPrivileges)`, /runuser/.test(body));
	// Never rely on an inherited HOME to find a daemon's repo: `sudo -u` sets it,
	// `runuser -u X --` does not, so the same code works by hand and fails on a timer.
	ok(`${name}: passes IPFS_PATH explicitly instead of trusting HOME`, /IPFS_PATH=/.test(body));
}
ok(
	'pin script resolves IPFS_PATH BEFORE its first kubo call',
	pinScript.indexOf('IPFS_PATH="$(tr') < pinScript.indexOf('_try_strategy')
);
// BOTH privilege-drop tools failed on morphit.io for DIFFERENT reasons — sudo
// refused under NoNewPrivileges, runuser lacked CAP_SETUID. The job runs as root
// and the kubo CLI only reads $IPFS_PATH/api then speaks HTTP, so no user switch
// is needed at all. Probe and adapt rather than assume which tool a host allows.
ok('pin script PROBES how to reach kubo instead of assuming', /_try_strategy/.test(pinScript));
ok('…and can talk to kubo directly as root, needing no privilege drop at all', /direct\)\s+env IPFS_PATH=/.test(pinScript));
ok('…trying direct first, then runuser, then sudo', /for _s in direct runuser sudo/.test(pinScript));
ok('…and reporting which strategy it chose', /strategy: \$IPFS_STRATEGY/.test(pinScript));
// The script restarts ipfs.service itself (step 3), so its own probe must
// tolerate a daemon that is briefly absent instead of declaring it unreachable.
ok('pin script waits for the kubo API instead of failing on the first miss', /_i" -lt 15/.test(pinScript));
ok('…and reports what ipfs actually said when it finally gives up', /ipfs said/.test(pinScript));
// Third time tonight a swallowed child error cost a debugging round trip.
for (const [name, body] of [
	['pin script', pinScript],
	['publish script', autopub]
] as const) {
	ok(`${name}: no failure path discards the child's output`, !/2>\/dev\/null 2>&1/.test(body));
}
ok(
	'both snapshot units still set NoNewPrivileges (the fix is the right tool, not weaker hardening)',
	/NoNewPrivileges=true/.test(mirrorSvc) && /NoNewPrivileges=true/.test(publishSvc)
);
ok(
	'mirror startup guard proves the REPO is reachable, not just that the binary exists (`--version` needs no repo, so it cannot tell "no kubo" from "wrong repo")',
	/ipfs\(\['id'/.test(mirrorTs2) && !/ipfs\(\['--version'\]/.test(mirrorTs2)
);

ok('upgrade installs the PUBLISH units too (Ansible never runs on a manual install)',
	/morphit-snapshot-publish\.service/.test(upgrade) && /morphit-snapshot-publish\.timer/.test(upgrade));
ok(
	'publishing is enabled ONLY on explicit opt-in — an upgrade must never make a box start signing snapshots by surprise',
	/snapshot-publish\.env/.test(upgrade)
);

// ── M. the publish path actually runs (v1.17.4) ─────────────────────
// `python3 -` reads the PROGRAM from stdin. Piping data in while ALSO supplying
// the program via a heredoc silently discards the pipe, so json.load(sys.stdin)
// sees an empty stream. pin-indexer-snapshot.sh did exactly that, which is why
// it could never publish and why no indexer_snapshot_v1 had ever been anchored.
ok(
	'pin script passes the manifest via the ENVIRONMENT, never a pipe that a heredoc would swallow',
	/MANIFEST_JSON="\$MANIFEST_JSON" python3 -/.test(pinScript) &&
		/json\.loads\(os\.environ\["MANIFEST_JSON"\]\)/.test(pinScript)
);
ok(
	'no shipped script pipes data into `python3 -` while also heredoc-ing the program',
	![pinScript, autopub, read('ops/snapshot-mirror.sh'), read('ops/ipfs/morphit-ipfs-seed.sh')].some((b) =>
		/\|\s*python3\s+-\s*<</.test(b)
	)
);

// ── N. the release guard must not gate on a third party ─────────────
// It downloaded the FULL ~33 MB tarball through a public gateway on every poll
// round, so each round waited on a cold multi-megabyte transfer. On a healthy
// release that routinely burned the whole budget ("40+ rounds"), while the
// instance's own origin — the path the federation actually uses, and the one the
// seeder had verified seconds earlier — was never consulted at all.
const guard = read('scripts/verify-cid-public.sh');
ok('the guard checks THIS instance\u2019s own origin first', /SELF_ORIGIN/.test(guard));
ok(
	'…and passes on that alone, without waiting on any public gateway',
	/That is the path the federation uses/.test(guard)
);
ok(
	'public gateways are checked for RESOLVABILITY (metadata.json), not a 33 MB download',
	/_serves_metadata/.test(guard) &&
		!/curl -fsSL --max-time 150[^\n]*morphit-latest\.tar\.gz/.test(guard)
);
ok(
	'the tarball warm-up is backgrounded and explicitly not waited on',
	/not waited on/.test(guard) && /tar\.gz" >\/dev\/null 2>&1 & \)/.test(guard)
);
ok(
	'a failure distinguishes "your own box is broken" from "third parties are slow"',
	/NOT just slow propagation/.test(guard)
);

// ── O. hidden-only nodes must route chain reads (v1.17.8) ───────────
// `installHiddenServiceDispatcher` is what sends .onion/.b32.i2p fetches through
// Tor/i2pd. It was called ONLY from the indexer service (main.ts), so the service
// read the chain happily over I2P while any standalone script beside it sent the
// same request straight at a .b32.i2p hostname with no proxy and got
// "fetch failed". That is what stopped morphitlat — a zero-clearnet box — from
// mirroring, and it would have stopped fast-sync there too.
for (const rel of [
	'apps/indexer/scripts/snapshot-mirror.ts',
	'apps/indexer/scripts/snapshot-bootstrap.ts'
]) {
	const src = read(rel);
	ok(`${rel}: installs the hidden-service dispatcher`, /installHiddenServiceDispatcher/.test(src));
	ok(
		`${rel}: …and fails CLOSED on a hidden-only node rather than reaching for clearnet`,
		/blurtRpcEndpoints\.length === 0 \? 'refuse' : 'allow'/.test(src)
	);
	// Anchor on the line immediately after config load, NOT on where
	// `callCondenser` appears in the file: in snapshot-bootstrap that call lives
	// in a helper defined near the top but invoked much later, so comparing
	// textual positions reports a false failure. Textual order is not execution
	// order — the third guard I have written tonight that confused the two.
	ok(
		`${rel}: …installed immediately after the config is loaded, before any chain read`,
		/const config = loadConfig\(\);\n\tinstallHiddenRouting\(config\);/.test(src)
	);
}

// ── P. the kubo Host header (v1.17.8) ───────────────────────────────
// A kubo gateway treats an unrecognised DNS-style Host as a possible DNSLink
// domain. With Gateway.NoFetch=true it cannot resolve one, so the request HANGS
// and nginx returns its stock 404 — which is what silently broke morphitir's
// clearnet /ipfs/ route while its Tor/I2P paths kept working. Proven on the box:
// Host: host.docker.internal timed out, Host: 127.0.0.1 answered instantly.
const ngx = read('ops/bunkerweb/frontend/nginx.conf');
const ipfsBlocks = ngx.split(/location \/ipfs\/|location \/ipns\//).slice(1);
ok('nginx has both IPFS gateway blocks', ipfsBlocks.length === 2, `found ${ipfsBlocks.length}`);
for (const [i, blk] of ipfsBlocks.entries()) {
	const head = blk.slice(0, 400);
	ok(
		`nginx IPFS block ${i + 1}: forwards an IP literal Host, never the client's $host`,
		/proxy_set_header Host 127\.0\.0\.1;/.test(head) && !/proxy_set_header Host \$host;/.test(head)
	);
}
ok(
	'…and NOT `localhost` (kubo ships localhost as a SUBDOMAIN gateway — it would redirect /ipfs/<cid>)',
	!/proxy_set_header Host localhost;/.test(ngx)
);
ok('the heal probe sends the same Host so it stops lying', /--header='Host: 127\.0\.0\.1'/.test(heal));

// ── Q. the mirror must wait for PEERS, not just a live API ──────────
// morphitir's swarm was 0 when the mirror ran right after an upgrade restart;
// `pin add` then sat through its whole 10-minute budget on an empty DHT.
ok('mirror waits for a non-empty swarm before fetching', /swarm', 'peers'/.test(mirrorTs2));
ok('…and defers cleanly rather than stalling', /no swarm peers after/.test(mirrorTs2));

console.log('');
if (fails.length > 0) {
	console.error(`✗ ${fails.length} snapshot-mirror-wiring scenario(s) failed:`);
	for (const f of fails) console.error(`   - ${f}`);
	process.exit(1);
}
console.log(`✓ all ${pass} snapshot-mirror-wiring scenarios passed`);
