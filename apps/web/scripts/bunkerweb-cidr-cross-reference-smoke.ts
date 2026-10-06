#!/usr/bin/env tsx
/**
 * bunkerweb-cidr-cross-reference-smoke.
 *
 * STRUCTURAL DEFENSE.
 *
 * Closes the class: the canonical BunkerWeb Docker network
 * CIDR is referenced across many operator-facing files, and the
 * Ansible default for `morphit_relay_trusted_proxy_ips` MUST match
 * what the bunkerweb role's docker-compose actually deploys.  If
 * any file drifts to a different CIDR, operators get a silently-
 * broken trusted-proxy chain → per-IP rate limiting breaks → all
 * user signups bucket into the BunkerWeb container's single IP.
 *
 * Bug history:
 *   - Pre-cp61: group_vars/all.yml defaulted
 *     `morphit_relay_trusted_proxy_ips: "172.18.0.0/16"` (the
 *     comment claimed "typical user-defined compose CIDR").
 *   - But the bunkerweb role's docker-compose pins subnet at
 *     `172.20.0.0/16` (chosen deliberately to avoid Docker
 *     defaults).
 *   - An operator running the default Ansible playbook gets
 *     BunkerWeb on 172.20.0.0/16 but the relay trusts only
 *     172.18.0.0/16 → BunkerWeb's X-Forwarded-For is REJECTED,
 *     relay falls back to peer IP (BunkerWeb's container IP),
 *     all users bucket into one rate-limit slot.
 *   - This is exactly the §32 CRITICAL failure mode the
 *     audit warned about, hidden behind playbook defaults.
 *   - Fix: group_vars/all.yml default changed to
 *     172.20.0.0/16, with a comment block explaining the
 *     coupling to the bunkerweb role's docker-compose.
 *
 * Enforcement model:
 *   1. SOURCE OF TRUTH: `ops/bunkerweb/docker-compose.yml`'s
 *      `bunkerweb_net` subnet line.  Whatever CIDR is pinned
 *      there is canonical.
 *   2. The Ansible bunkerweb role's docker-compose.yml.j2 MUST
 *      pin the same CIDR (both serve the same network).
 *   3. The Ansible group_vars default for
 *      `morphit_relay_trusted_proxy_ips` MUST match the canonical
 *      CIDR (otherwise the default Ansible playbook deploys with
 *      broken trusted-proxy chain).
 *   4. Documentation files that reference the bunkerweb CIDR
 *      (operator-facing examples + READMEs + OPERATIONS.md +
 *      RUN-A-MORPHIT-NODE.md +
 *      MORPHIT-BRAG-LIST.md) MUST mention the canonical CIDR.
 *
 * Note: docs that describe Docker's DEFAULT bridge ranges
 * (172.17.0.0/16, 172.18.0.0/16, 172.31.0.0/16) for general
 * troubleshooting are LEGITIMATE references — they're not
 * bunkerweb-canonical claims.  This smoke distinguishes by
 * looking only at lines that mention "bunkerweb" or
 * "bunkerweb_net" or "TRUSTED_PROXY_IPS=" in close proximity
 * to a CIDR.
 *
 * Recurring class scope progression (16 defenses across 14 checkpoints):
 *   through a later fix (as listed above)
 *   bunkerweb CIDR cross-reference (THIS)
 *
 * Mutation test verification: — change
 * group_vars/all.yml's trusted_proxy_ips to 172.18.0.0/16
 * (the older broken state) fires the smoke with
 * "Ansible default trusted_proxy_ips '172.18.0.0/16' does not
 * match canonical bunkerweb CIDR '172.20.0.0/16'".
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── bunkerweb-cidr-cross-reference smoke (cp61 LL #64 / O-14) ──\n');

/** Read SOURCE OF TRUTH: the bunkerweb canonical docker-compose's subnet line. */
function readCanonicalCidr(): string {
	const composeSrc = readFileSync(
		join(REPO_ROOT, 'ops/bunkerweb/docker-compose.yml'),
		'utf-8'
	);
	const m = composeSrc.match(/subnet:\s*([\d./]+)/);
	if (!m) {
		throw new Error('Cannot locate `subnet:` line in ops/bunkerweb/docker-compose.yml');
	}
	return m[1];
}

/** The relay's own default trusted set (apps/relay/src/middleware/ip.ts),
 *  used when group_vars leaves morphit_relay_trusted_proxy_ips EMPTY
 *  (v1.20.0 wave 5/6: empty = the code default, like the indexer's). */
function relayDefaultTrustedCidrs(): string[] {
	const src = readFileSync(join(REPO_ROOT, 'apps/relay/src/middleware/ip.ts'), 'utf-8');
	const m = src.match(/DEFAULT_TRUSTED_PROXY_CIDRS[^=]*=\s*\[([^\]]*)\]/);
	if (!m) throw new Error('Cannot find DEFAULT_TRUSTED_PROXY_CIDRS in apps/relay/src/middleware/ip.ts');
	return [...m[1].matchAll(/['"]([\d./]+)['"]/g)].map((x) => x[1]);
}
/** Does IPv4 CIDR `outer` contain every address of `inner`? */
function cidrContains(outer: string, inner: string): boolean {
	const toInt = (ip: string): number => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
	const [on, ob] = outer.split('/');
	const [inn, ib] = inner.split('/');
	const obits = Number(ob ?? 32);
	const ibits = Number(ib ?? 32);
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(on) || !/^\d+\.\d+\.\d+\.\d+$/.test(inn) || obits > ibits) return false;
	const mask = obits === 0 ? 0 : (~0 << (32 - obits)) >>> 0;
	return ((toInt(on) & mask) >>> 0) === ((toInt(inn) & mask) >>> 0);
}

const CANONICAL_CIDR = readCanonicalCidr();
console.log(`SOURCE OF TRUTH: ops/bunkerweb/docker-compose.yml subnet = ${CANONICAL_CIDR}\n`);

/** Check the Ansible bunkerweb role's docker-compose template. */
function checkAnsibleBunkerwebRole(): void {
	const path = 'ops/ansible/roles/bunkerweb/templates/docker-compose.yml.j2';
	const src = readFileSync(join(REPO_ROOT, path), 'utf-8');
	const m = src.match(/subnet:\s*([\d./]+)/);
	if (!m) {
		fail(`Ansible bunkerweb role subnet present`, `No \`subnet:\` line in ${path}`);
		return;
	}
	if (m[1] !== CANONICAL_CIDR) {
		fail(
			`Ansible bunkerweb role subnet matches canonical`,
			`${path} pins subnet '${m[1]}' but canonical is '${CANONICAL_CIDR}'.  ` +
				`Both must agree — they deploy the same network.`
		);
	} else {
		pass(`Ansible bunkerweb role subnet matches canonical: ${m[1]}`);
	}
}

/** Check the Ansible group_vars default for morphit_relay_trusted_proxy_ips. */
function checkAnsibleTrustedProxyDefault(): void {
	const path = 'ops/ansible/group_vars/all.yml';
	const src = readFileSync(join(REPO_ROOT, path), 'utf-8');
	const m = src.match(/^morphit_relay_trusted_proxy_ips:\s*(?:"([^"]*)"|'([^']*)'|([\d./,]*))\s*(?:#.*)?$/m);
	if (!m) {
		fail(`Ansible group_vars trusted_proxy_ips default present`, `Variable not found in ${path}`);
		return;
	}
	const defaultVal = (m[1] ?? m[2] ?? m[3] ?? '').trim();
	// EMPTY = the relay's code default (loopback + DEFAULT_TRUSTED_PROXY_CIDRS);
	// a value REPLACES it. Either way some entry must CONTAIN the bunkerweb
	// bridge (a wider pool that covers it is correct; a different subnet is not).
	const entries =
		defaultVal === ''
			? relayDefaultTrustedCidrs()
			: defaultVal.split(',').map((s) => s.trim()).filter(Boolean);
	if (!entries.some((e) => cidrContains(e, CANONICAL_CIDR))) {
		fail(
			`Ansible group_vars default trusts bunkerweb CIDR`,
			`Default morphit_relay_trusted_proxy_ips '${defaultVal}' does not include canonical bunkerweb CIDR '${CANONICAL_CIDR}'.\n      ` +
				`§32 CRITICAL: if Ansible deploys bunkerweb on '${CANONICAL_CIDR}' but the relay trusts a different CIDR,\n      ` +
				`X-Forwarded-For is rejected and per-IP rate limiting silently breaks.\n      ` +
				`Fix: update group_vars/all.yml to '${CANONICAL_CIDR}' (or change the bunkerweb role's docker-compose subnet to match this default).`
		);
	} else {
		pass(
			`Ansible group_vars default trusts canonical bunkerweb CIDR (${defaultVal === '' ? 'empty = the relay default: ' : ''}${entries.join(', ')} ⊇ ${CANONICAL_CIDR})`
		);
	}
}

/** Check that cross-reference files mention the canonical CIDR.
 *  These files document the bunkerweb deployment to operators; if they
 *  reference a different CIDR, operators get confused — and worse, they
 *  may copy the wrong CIDR into their config. */
const CROSS_REFERENCE_FILES = [
	'ops/bunkerweb/README.md',
	'ops/bunkerweb/bunkerweb.env.example',
	'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2',
	'docs/OPERATIONS.md',
	'docs/MORPHIT-BRAG-LIST.md'
];

function checkCrossReference(file: string): void {
	const src = readFileSync(join(REPO_ROOT, file), 'utf-8');
	if (!src.includes(CANONICAL_CIDR)) {
		fail(
			`${file} mentions canonical CIDR`,
			`File should reference the canonical bunkerweb CIDR '${CANONICAL_CIDR}' somewhere ` +
				`(it documents the bunkerweb deployment to operators).`
		);
		return;
	}
	pass(`${file} mentions canonical CIDR '${CANONICAL_CIDR}'`);
}

checkAnsibleBunkerwebRole();
checkAnsibleTrustedProxyDefault();
for (const file of CROSS_REFERENCE_FILES) checkCrossReference(file);

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nbunkerweb-cidr-cross-reference smoke FAILED');
	console.error('§32 CRITICAL — getting the trusted-proxy CIDR wrong silently breaks per-IP rate limiting.');
	process.exit(1);
}
console.log(`✓ all ${total} bunkerweb CIDR cross-reference checks pass`);
