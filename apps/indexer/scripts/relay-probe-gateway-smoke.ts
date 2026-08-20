/**
 * Regression: /v1/health used to report the relay DOWN while `morphit-ops
 * health` (on the host) saw it UP. Cause: the relay binds to the Docker bridge
 * gateway (e.g. 172.18.0.1); the CLI runs on the host where that's a local
 * interface, but the indexer runs in a CONTAINER where the gateway is only its
 * default route, never in networkInterfaces() — so it never probed there.
 * The fix adds the /proc/net/route default gateway to the relay candidates.
 */
import {
	parseDefaultGatewayV4,
	buildRelayCandidates
} from '../src/api/operationalHealth.ts';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}`);
	}
}

// ── parseDefaultGatewayV4 ───────────────────────────────────────────
// A real /proc/net/route: header, then a default route (dest 00000000) whose
// gateway 010012AC = 172.18.0.1 (little-endian: AC.12.00.01 → 172.18.0.1).
const routeText = [
	'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask',
	'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
	'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0'
].join('\n');
check('parses the bridge gateway 172.18.0.1 from /proc/net/route', parseDefaultGatewayV4(routeText) === '172.18.0.1');
check(
	'no default route → null',
	parseDefaultGatewayV4('Iface\tDestination\tGateway\n eth0\t000012AC\t00000000\t0001') === null
);
check('a 0.0.0.0 gateway is skipped', parseDefaultGatewayV4('h\neth0\t00000000\t00000000\t0003') === null);
check('garbage → null (no throw)', parseDefaultGatewayV4('not a route table') === null);

// ── buildRelayCandidates: the gateway must be a candidate ───────────
{
	// The bug scenario: configured is loopback, the container's own IP is
	// 172.18.0.5 (NOT the relay), and the gateway 172.18.0.1 IS the relay.
	const cands = buildRelayCandidates('http://127.0.0.1:8080/v1/health', ['172.18.0.5'], '172.18.0.1');
	check('includes the configured URL', cands.includes('http://127.0.0.1:8080/v1/health'));
	check('includes the container IP candidate', cands.includes('http://172.18.0.5:8080/v1/health'));
	check(
		'CRITICAL: includes the gateway (where the relay actually is)',
		cands.includes('http://172.18.0.1:8080/v1/health')
	);
}
{
	// No gateway available → just configured + interfaces, no crash.
	const cands = buildRelayCandidates('http://127.0.0.1:8080/v1/health', [], null);
	check('null gateway → only the configured URL', cands.length === 1);
}
{
	// Dedup: if an interface address equals the gateway, no duplicate.
	const cands = buildRelayCandidates('http://127.0.0.1:8080/v1/health', ['172.18.0.1'], '172.18.0.1');
	check('gateway == interface addr is de-duplicated', cands.filter((u) => u.includes('172.18.0.1')).length === 1);
}
{
	// cp771 — local probes use the relay's canonical /v1/health at the configured
	// port, NOT the configured path (a proxy path like /relay/... isn't what the
	// relay serves locally).
	const cands = buildRelayCandidates('http://127.0.0.1:9999/relay/v1/health', [], '10.0.0.1');
	check('reuses the configured port but canonicalises the path on the gateway candidate', cands.includes('http://10.0.0.1:9999/v1/health'));
}
// ── cp771: relay up/down is measured with ZERO config — every local address
//     (loopback, host IPs incl. the docker bridge, gateway) is auto-probed at
//     the relay's canonical /v1/health, even when RELAY_HEALTH_URL is empty ──
{
	// Empty configured URL → still auto-probes loopback + host IPs + gateway at 8080.
	const cands = buildRelayCandidates('', ['172.18.0.1'], '172.17.0.1');
	check('empty URL still probes loopback', cands.includes('http://127.0.0.1:8080/v1/health'));
	check('empty URL still probes the docker-bridge host IP (the real morphit.io case)', cands.includes('http://172.18.0.1:8080/v1/health'));
	check('empty URL still probes the gateway', cands.includes('http://172.17.0.1:8080/v1/health'));
}
{
	// A public https URL must NOT drag the local probes onto :443 — the relay
	// listens on 8080 locally, never on the public proxy port.
	const cands = buildRelayCandidates('https://morphit.io/relay/v1/health', ['172.18.0.1'], null);
	check('public URL honoured verbatim', cands.includes('https://morphit.io/relay/v1/health'));
	check('public URL does NOT misdirect the local host-IP probe to :443 (uses 8080 + /v1/health)', cands.includes('http://172.18.0.1:8080/v1/health'));
	check('public URL does NOT inherit the /relay/ proxy path locally', !cands.some((u) => u.includes('127.0.0.1') && u.includes('/relay/')));
}
{
	// An explicit non-standard relay port is reused for the local probes.
	const cands = buildRelayCandidates('http://127.0.0.1:9000/v1/health', ['10.0.0.5'], null);
	check('explicit relay port is reused on host-IP probes', cands.includes('http://10.0.0.5:9000/v1/health'));
}
{
	// cp772 — the LOCAL relay probe must bypass the global hidden-service router
	// (Tor/I2P) the indexer installs; going through it breaks the local fetch and
	// reads a healthy relay as down. Proven in the field + a bypass test.
	const oh = readFileSync(new URL('../src/api/operationalHealth.ts', import.meta.url), 'utf8');
	check('cp772: a dedicated direct dispatcher exists (new Agent from undici)',
		/import\s*\{[^}]*\bAgent\b[^}]*\}\s*from\s*'undici'/.test(oh) && /directRelayDispatcher\s*=\s*new Agent\(\)/.test(oh));
	check('cp772: probeRelay passes dispatcher: directRelayDispatcher (bypasses the global router)',
		/dispatcher:\s*directRelayDispatcher/.test(oh));
}

console.log(
	fail === 0
		? `\n\u2713 all ${pass} relay-probe-gateway checks passed`
		: `\n\u2717 relay-probe-gateway: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
