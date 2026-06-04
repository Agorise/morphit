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
	expect('all healthy: verdict line', /All 3 RPC endpoints reachable/.test(lines.at(-1)!), lines.at(-1));
}

// partial: some dead, at least one good
{
	const s = summarizeProbes([good('a', 60_700_000), dead('b'), dead('c', 'timeout')]);
	expect('partial: healthy=1 total=3', s.healthy === 1 && s.total === 3, `${s.healthy}/${s.total}`);
	expect('partial: headBlock from the one good endpoint', s.headBlock === 60_700_000);
	const lines = formatRpcProbeLines(s);
	expect('partial: verdict mentions reduced redundancy', /1 of 3 RPC endpoints reachable/.test(lines.at(-1)!), lines.at(-1));
	expect('partial: dead lines show the error', lines.some((l) => l.includes('DEAD') && l.includes('timeout')));
}

// all dead → the firefight case, loud verdict, head=null
{
	const s = summarizeProbes([dead('a'), dead('b', 'HTTP 502')]);
	expect('all dead: healthy=0', s.healthy === 0 && s.total === 2);
	expect('all dead: headBlock=null', s.headBlock === null);
	const lines = formatRpcProbeLines(s);
	expect(
		'all dead: verdict says node CANNOT sync',
		/All 2 RPC endpoints are unreachable/.test(lines.at(-1)!) && /CANNOT sync/.test(lines.at(-1)!),
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
