#!/usr/bin/env tsx
/**
 * scripts/ipns-dht-rebroadcast-smoke.ts  (v1.9.6, Ken)
 *
 * The OPS half of the DHT-native IPNS model (the SIGN + chain + frontend half is
 * ipns-release-wiring-smoke.ts). Model: @morphit SIGNS an IPNS record ONCE per
 * release (key stays a CI secret), anchors it on-chain, and EVERY instance then
 * REBROADCASTS that already-signed record to the public DHT on a timer — WITHOUT
 * the private key. So `ipns://<name>` stays resolvable as long as one instance is
 * alive, and no instance can repoint it. This smoke pins the whole rebroadcast path:
 *   - ops/ipfs/morphit-ipns-rebroadcast.sh reads ipns_name + ipns_record from the
 *     instance's OWN /v1/release, base64-decodes the record, and `ipfs routing put`s
 *     it under /ipns/<name> WITHOUT the key (Kubo validates the signature on PUT);
 *     a Routing V1 HTTP PUT is documented as the fallback; a dry-run is supported
 *   - ops/ipfs/morphit-ipfs-setup.sh installs the script + a oneshot service + a
 *     ~4h timer and enables it (operator does nothing new)
 *   - NEITHER ops script ever references MORPHIT_IPNS_KEY — the key is CI-only; an
 *     instance only relays what @morphit already signed (the security property)
 *
 * Anti-pattern greps strip shell comments first (a comment explaining "the key is
 * CI-only" must not trip the no-key check); "documents X" greps keep comments.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let pass = 0,
	fail = 0;
const ok = (m: string) => (pass++, console.log(`  \u2713 ${m}`));
const bad = (m: string, d = '') => (fail++, console.log(`  \u2717 ${m}${d ? `\n      ${d}` : ''}`));
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const stripHash = (s: string) =>
	s
		.split('\n')
		.filter((l) => !/^\s*#/.test(l))
		.join('\n');

// ── 1. the rebroadcast script ────────────────────────────────────────
{
	const raw = read('ops/ipfs/morphit-ipns-rebroadcast.sh');
	const code = stripHash(raw);
	const checks: Array<[string, boolean]> = [
		['reads from the instance OWN /v1/release', /\/v1\/release/.test(code) && /MORPHIT_RELEASE_URL/.test(code)],
		['extracts ipns_name from the release', /ipns_name/.test(code)],
		['extracts ipns_record from the release', /ipns_record/.test(code)],
		['base64-decodes the record before PUT', /base64 -d/.test(code)],
		['refuses to PUT an invalid/empty record', /refusing to PUT/.test(raw)],
		['PUTs under the /ipns/<name> routing key', /KEY="\/ipns\/\$NAME"/.test(code) && /routing put "\$KEY"/.test(code)],
		['supports a dry-run (validate without PUT)', /MORPHIT_IPNS_DRYRUN/.test(code)],
		// cp591 — a hand-run must match the timer: the script sources the operator's
		// persisted config itself (systemd's EnvironmentFile isn't loaded for a manual
		// `sudo …rebroadcast.sh`, so without this it fell to the wrong 127.0.0.1 default
		// on non-localhost/BunkerWeb boxes).
		['sources /etc/morphit/ipfs-pin.env so a hand-run matches the timer', /\.\s+\/etc\/morphit\/ipfs-pin\.env/.test(code)],
		['skips cleanly when the release carries no record (older release / no key)', /nothing to rebroadcast/.test(raw)],
		['documents the Routing V1 HTTP PUT fallback', /routing\/v1\/ipns/.test(raw)],
		// THE security property: the instance never holds the signing key
		['NEVER references MORPHIT_IPNS_KEY (relay-only, no key on the box)', !/MORPHIT_IPNS_KEY/.test(code)]
	];
	for (const [n, okp] of checks) okp ? ok(`rebroadcast.sh: ${n}`) : bad(`rebroadcast.sh: ${n}`);
}

// ── 2. setup installs the script + oneshot service + ~4h timer ───────
{
	const raw = read('ops/ipfs/morphit-ipfs-setup.sh');
	const code = stripHash(raw);
	const checks: Array<[string, boolean]> = [
		['installs the rebroadcast script into /usr/local/lib/morphit', /install .*morphit-ipns-rebroadcast\.sh/.test(code)],
		['creates a oneshot rebroadcast service', /morphit-ipns-rebroadcast\.service/.test(code) && /Type=oneshot/.test(code)],
		['service runs the rebroadcast script', /ExecStart=.*morphit-ipns-rebroadcast\.sh/.test(code)],
		['service shares the pin EnvironmentFile (no new operator config)', /EnvironmentFile=-?\/etc\/morphit\/ipfs-pin\.env/.test(code)],
		['creates a ~4h rebroadcast timer', /morphit-ipns-rebroadcast\.timer/.test(code) && /OnUnitActiveSec=4h/.test(code)],
		['enables the rebroadcast timer', /enable --now morphit-ipns-rebroadcast\.timer/.test(code)]
	];
	for (const [n, okp] of checks) okp ? ok(`setup.sh: ${n}`) : bad(`setup.sh: ${n}`);
}

// ── 2b. the ANSIBLE ipfs role wires the SAME rebroadcast (wizard installs) ──
// The wizard runs the ansible playbook, so the ipfs role must arm rebroadcast
// exactly like the hand-managed setup.sh — otherwise a wizard-installed peer
// pins the release but never re-announces IPNS, and ipns://<name> silently
// depends on a hand-managed box or the primary staying up.
{
	const tasks = read('ops/ansible/roles/ipfs/tasks/main.yml');
	const svc = stripHash(read('ops/ansible/roles/ipfs/templates/morphit-ipns-rebroadcast.service.j2'));
	const timer = stripHash(read('ops/ansible/roles/ipfs/templates/morphit-ipns-rebroadcast.timer.j2'));
	const checks: Array<[string, boolean]> = [
		['role installs the rebroadcast script into /usr/local/lib/morphit', /morphit-ipns-rebroadcast\.sh/.test(tasks) && /\/usr\/local\/lib\/morphit\/morphit-ipns-rebroadcast\.sh/.test(tasks)],
		['role templates the rebroadcast service + timer', /morphit-ipns-rebroadcast\.service\.j2/.test(tasks) && /morphit-ipns-rebroadcast\.timer\.j2/.test(tasks)],
		['role enables the rebroadcast timer', /morphit-ipns-rebroadcast\.timer/.test(tasks) && /Enable \+ start the IPNS-rebroadcast timer/.test(tasks)],
		['service is a oneshot that runs the rebroadcast script', /Type=oneshot/.test(svc) && /ExecStart=.*morphit-ipns-rebroadcast\.sh/.test(svc)],
		['service shares the pin EnvironmentFile (no new operator config)', /EnvironmentFile=-?\/etc\/morphit\/ipfs-pin\.env/.test(svc)],
		['timer re-announces every ~4h', /OnUnitActiveSec=4h/.test(timer)],
		// key hygiene extends to the template: the unit must never carry the key
		['service template NEVER references MORPHIT_IPNS_KEY', !/MORPHIT_IPNS_KEY/.test(svc)]
	];
	for (const [n, okp] of checks) okp ? ok(`ansible ipfs role: ${n}`) : bad(`ansible ipfs role: ${n}`);
}

// ── 3. key hygiene across the whole ops surface ──────────────────────
{
	const reb = stripHash(read('ops/ipfs/morphit-ipns-rebroadcast.sh'));
	const setup = stripHash(read('ops/ipfs/morphit-ipfs-setup.sh'));
	!/MORPHIT_IPNS_KEY/.test(reb) && !/MORPHIT_IPNS_KEY/.test(setup)
		? ok('key hygiene: the IPNS signing key appears in NEITHER ops script (CI-only)')
		: bad('key hygiene: an ops script references the signing key');
	// the signer is the ONLY consumer of the key, and it lives under scripts/ (CI), not ops/
	/MORPHIT_IPNS_KEY/.test(read('scripts/ipns-sign.mjs'))
		? ok('the signer (scripts/ipns-sign.mjs, CI) is the sole key consumer')
		: bad('signer no longer reads the key?');
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 ipns-dht-rebroadcast smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 DHT rebroadcast wired: every instance re-announces the on-chain signed IPNS record to the DHT on a ~4h timer, WITHOUT the key');
console.log(`\u2713 all ${pass} ipns-dht-rebroadcast scenarios passed`);
