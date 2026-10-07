/**
 * gateway-cidr-guard — the IPFS gateway firewall heal opens Kubo's gateway
 * port to the docker bridge's subnet as `docker network inspect` reports it.
 * That value becomes a ufw/iptables source rule, so only a subnet INSIDE an
 * RFC1918 range may be honoured: "10.0.0.0/1", "172.16.0.0/4" or
 * "192.168.0.0/0" start like private ranges but cover the internet, and would
 * open the gateway to everyone — on a hidden-only node, letting a scan for
 * Morphit CIDs find its IP (review G5). Runs the script's own function.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'ops', 'ipfs', 'morphit-gateway-firewall-heal.sh');
const src = readFileSync(SCRIPT, 'utf8');
const m = /^private_cidr_ok\(\) \{[\s\S]*?^\}/m.exec(src);

const CASES: [string, boolean][] = [
	['172.20.0.0/16', true],
	['10.0.0.0/8', true],
	['10.42.0.0/16', true],
	['172.16.0.0/12', true],
	['192.168.1.0/24', true],
	['10.0.0.0/1', false],
	['172.16.0.0/4', false],
	['172.20.0.0/11', false],
	['192.168.0.0/0', false],
	['192.168.0.0/15', false],
	['198.51.100.0/24', false],
	['100.64.0.0/10', false],
	['10.0.0.0/33', false],
	['10.0.0.0', false],
	['10.0.0.256/16', false],
	['', false]
];

let pass = 0;
let fail = 0;
if (!m) {
	console.log('  ✗ the script has no private_cidr_ok() to check the subnet with');
	fail++;
} else {
	for (const [cidr, want] of CASES) {
		const r = spawnSync('sh', ['-c', `set -u\n${m[0]}\nprivate_cidr_ok "$1"`, 'x', cidr]);
		const got = r.status === 0;
		if (got === want) {
			pass++;
			console.log(`  ✓ ${cidr || '(empty)'} → ${want ? 'accepted' : 'refused'}`);
		} else {
			fail++;
			console.log(`  ✗ ${cidr || '(empty)'}: expected ${want ? 'accepted' : 'refused'}`);
		}
	}
	// The heal uses it on the docker answer (call site).
	if (/private_cidr_ok "\$\{?CIDR/.test(src)) pass++;
	else {
		fail++;
		console.log('  ✗ the heal does not check the docker subnet with private_cidr_ok');
	}
}
if (fail > 0) {
	console.log(`✗ ${fail} of ${pass + fail} gateway-cidr-guard scenarios FAILED`);
	process.exit(1);
}
console.log(`✓ all ${pass} gateway-cidr-guard scenarios passed`);
