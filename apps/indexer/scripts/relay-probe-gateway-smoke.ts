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
	// Port + path preserved from the configured URL.
	const cands = buildRelayCandidates('http://127.0.0.1:9999/health', [], '10.0.0.1');
	check('preserves the configured port + path on the gateway candidate', cands.includes('http://10.0.0.1:9999/health'));
}
// ── cp769: loopback is ALWAYS a candidate (empty/misconfigured RELAY_HEALTH_URL
//     must not make a healthy bare-metal relay read down) ──────────────────
{
	// Empty configured URL → still probes loopback on the default port/path.
	const cands = buildRelayCandidates('', [], null);
	check('empty configured URL still yields a loopback candidate', cands.includes('http://127.0.0.1:8080/v1/health'));
}
{
	// A non-loopback configured URL → loopback is added alongside it, port/path preserved.
	const cands = buildRelayCandidates('http://relay.example:9000/v1/health', [], null);
	check('non-loopback configured URL still adds a loopback candidate (port/path preserved)', cands.includes('http://127.0.0.1:9000/v1/health'));
}
{
	// Garbage configured URL → loopback default still present, no throw.
	const cands = buildRelayCandidates('not a url', [], null);
	check('unparseable configured URL still yields the default loopback candidate', cands.includes('http://127.0.0.1:8080/v1/health'));
}

console.log(
	fail === 0
		? `\n\u2713 all ${pass} relay-probe-gateway checks passed`
		: `\n\u2717 relay-probe-gateway: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
