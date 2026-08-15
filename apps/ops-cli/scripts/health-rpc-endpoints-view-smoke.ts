/**
 * morphit-ops health now shows a per-endpoint RPC breakdown (transport · host ·
 * latency · reachable) instead of only a "N/M reachable" count — so the operator
 * can see WHICH nodes are up, including the Tor/I2P/local ones. This smoke covers
 * the pure parse + format helpers.
 */
import {
	parseRpcEndpointRows,
	transportLabel,
	shortEndpoint
} from '../src/commands/health.ts';

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

// ── parseRpcEndpointRows ─────────────────────────────────────────────
const body = {
	endpoints: [
		{ url: 'http://127.0.0.1:8091', transport: 'local', healthy: true, latencyMs: 2 },
		{ url: 'https://rpc.drakernoise.com', transport: 'clearnet', healthy: true, latencyMs: 42 },
		{ url: 'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091', transport: 'tor', healthy: true, latencyMs: 187 },
		{ url: 'http://zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa.b32.i2p:8091', transport: 'i2p', healthy: false, latencyMs: null }
	]
};
const rows = parseRpcEndpointRows(body);
check('parses all 4 rows', rows.length === 4);
check('keeps transport buckets', rows.map((r) => r.transport).join() === 'local,clearnet,tor,i2p');
check('marks the i2p row unhealthy with null latency', rows[3]!.healthy === false && rows[3]!.latencyMs === null);
check('unknown transport → clearnet', parseRpcEndpointRows({ endpoints: [{ url: 'https://x', transport: 'weird', healthy: true }] })[0]!.transport === 'clearnet');
check('tolerates a non-object body', parseRpcEndpointRows(null).length === 0 && parseRpcEndpointRows('nope').length === 0);
check('tolerates a missing endpoints array', parseRpcEndpointRows({}).length === 0);
check('drops rows without a url', parseRpcEndpointRows({ endpoints: [{ transport: 'tor', healthy: true }] }).length === 0);

// ── transportLabel ──────────────────────────────────────────────────
check('tor → Tor', transportLabel('tor') === 'Tor');
check('i2p → I2P', transportLabel('i2p') === 'I2P');
check('local → local', transportLabel('local') === 'local');
check('clearnet → clearnet', transportLabel('clearnet') === 'clearnet');

// ── shortEndpoint ───────────────────────────────────────────────────
check('clearnet host kept as-is', shortEndpoint('https://rpc.drakernoise.com') === 'rpc.drakernoise.com');
check('loopback kept as-is with port', shortEndpoint('http://127.0.0.1:8091') === '127.0.0.1:8091');
{
	const s = shortEndpoint('http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091');
	check('onion elided (short, has …, keeps .onion:port)', s.length < 30 && s.includes('\u2026') && s.endsWith('.onion:8091'));
}
{
	const s = shortEndpoint('http://zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa.b32.i2p:8091');
	check('i2p elided and keeps .b32.i2p:port', s.includes('\u2026') && s.endsWith('.b32.i2p:8091'));
}

console.log(
	fail === 0
		? `\n\u2713 all ${pass} health-rpc-endpoints-view checks passed`
		: `\n\u2717 health-rpc-endpoints-view: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
