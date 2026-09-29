/**
 * rpc-endpoint-probe-smoke (beta5 item B).
 *
 * Unit-tests the PURE aggregation + rendering of the config-time RPC
 * endpoint validation (summarizeProbes / formatRpcProbeLines). The
 * actual network probe (probeRpcEndpoint) hits live RPC and is covered
 * by integration use in `init`/`doctor`, not here — but the verdict
 * logic an operator relies on (all-dead, partial, healthy, head-block
 * max) is deterministic and tested here.
 */

import {
	summarizeProbes,
	formatRpcProbeLines,
	type RpcProbeResult
} from '../src/init/chainCheck.ts';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, detail = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (detail) console.log(`      ${detail}`);
};
const expect = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : bad(name, detail));

const good = (url: string, head: number, ms = 100): RpcProbeResult => ({
	url,
	ok: true,
	latencyMs: ms,
	headBlock: head,
	error: null
});
const dead = (url: string, error = 'getaddrinfo ENOTFOUND'): RpcProbeResult => ({
	url,
	ok: false,
	latencyMs: null,
	headBlock: null,
	error
});

// all healthy → head = max reported
{
	const s = summarizeProbes([good('a', 60_700_000), good('b', 60_700_002), good('c', 60_699_998)]);
	expect('all healthy: healthy=3 total=3', s.healthy === 3 && s.total === 3, `${s.healthy}/${s.total}`);
	expect('all healthy: headBlock = max', s.headBlock === 60_700_002, `got ${s.headBlock}`);
	const lines = formatRpcProbeLines(s);
	expect('all healthy: verdict line', /All 3 probed clearnet RPC endpoints answered/.test(lines.at(-1)!), lines.at(-1));
}

// partial: some dead, at least one good
{
	const s = summarizeProbes([good('a', 60_700_000), dead('b'), dead('c', 'timeout')]);
	expect('partial: healthy=1 total=3', s.healthy === 1 && s.total === 3, `${s.healthy}/${s.total}`);
	expect('partial: headBlock from the one good endpoint', s.headBlock === 60_700_000);
	const lines = formatRpcProbeLines(s);
	// D12: no hand-prune advice, no alarm — a blip is normal and the pool routes
	// around it; point at the authoritative /v1/health for the full count.
	expect('partial: verdict states the reachable count without alarm', /1 of 3 clearnet RPC endpoints answered/.test(lines.at(-1)!), lines.at(-1));
	expect('partial: verdict does NOT advise replacing/pruning a node', !/consider replac|replace the dead|should (replace|prune)|prune the/i.test(lines.at(-1)!), lines.at(-1));
	expect('partial: verdict points at the authoritative /v1/health', /v1\/health/.test(lines.at(-1)!), lines.at(-1));
	expect('partial: down lines show the error (not "DEAD")', lines.some((l) => l.includes('down now') && l.includes('timeout')) && !lines.some((l) => l.includes('DEAD')));
}

// none answered the host-side probe → must NOT assert "cannot sync/broadcast"
// (the hidden Tor/I2P nodes aren't probed here; /v1/health is authoritative).
{
	const s = summarizeProbes([dead('a'), dead('b', 'HTTP 502')]);
	expect('none answered: healthy=0', s.healthy === 0 && s.total === 2);
	expect('none answered: headBlock=null', s.headBlock === null);
	const lines = formatRpcProbeLines(s);
	expect(
		'none answered: verdict does NOT assert the node cannot sync/broadcast',
		!/cannot sync|cannot broadcast/i.test(lines.at(-1)!),
		lines.at(-1)
	);
	expect(
		'none answered: verdict names the hidden nodes + /v1/health as the real picture',
		/hidden/i.test(lines.at(-1)!) && /v1\/health/.test(lines.at(-1)!),
		lines.at(-1)
	);
}

// empty list
{
	const s = summarizeProbes([]);
	expect('empty: total=0 head=null', s.total === 0 && s.headBlock === null);
	expect('empty: verdict says none configured', /No RPC endpoints are configured/.test(formatRpcProbeLines(s).at(-1)!));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 rpc-endpoint-probe smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} rpc-endpoint-probe scenarios passed`);
