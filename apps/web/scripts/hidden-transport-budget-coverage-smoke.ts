#!/usr/bin/env tsx
/**
 * apps/web/scripts/hidden-transport-budget-coverage-smoke.ts
 *
 * No request in the browser may be bounded by a clearnet-sized timeout.
 *
 * WHY THIS EXISTS
 * The chat-identity read was found first: a flat 15s in the browser against a
 * server allowed 60s for the same lookup, which on a Tor/I2P instance turned
 * into a false "this peer's chat key looks tampered with". Fixing that one site
 * was not the fix. Behind it, all sized the same way and all broken the same
 * way, were the chain head that every chat send waits on, the key-reference
 * lookup, the profile batch, the chain-fee store, account creation, the direct
 * RPC rotator and a static version poll. Each failed in its own
 * unrelated-looking way — an unverifiable key, an unreachable instance, missing
 * avatars, a fee falling back to defaults — and nothing connected them.
 *
 * So the floor is applied inside `fetchWithTimeout`, where no call site can
 * miss it, and this guard EXECUTES that: it drives real requests through the
 * helper against a local server, on a clearnet page and on a hidden one, and
 * observes the budget that was actually applied. It then sweeps the source for
 * hand-rolled `setTimeout(() => …abort())` fetches that bypass the helper
 * entirely, since those are the only way back into the bug.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout } from '../src/lib/net/fetchWithTimeout';
import { INDEXER_TIMEOUT_HIDDEN_MS } from '../src/lib/net/transportBudget';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const SRC = resolve(WEB, 'src');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  ✗ ${m}`);
	if (d) console.log(`      ${d}`);
};

console.log('hidden-transport-budget-coverage — no clearnet budget on a hidden hop');
console.log('');

// ── 1. The floor is applied by the HELPER, observed by running it ────
// A server that never answers, and a budget far below the hidden floor. On a
// clearnet page the request must abort at roughly the budget; on a hidden page
// it must still be waiting, because the floor raised it.
{
	const server: Server = createServer(() => {
		/* accept the connection and never respond */
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;
	const url = `http://127.0.0.1:${port}/v1/anything`;

	const raced = async (hostname: string): Promise<'aborted' | 'still-waiting'> => {
		const saved = (globalThis as { window?: unknown }).window;
		(globalThis as { window?: unknown }).window = { location: { hostname } };
		try {
			const attempt = fetchWithTimeout(url, {}, 600).then(
				() => 'aborted' as const,
				() => 'aborted' as const
			);
			return await Promise.race([
				attempt,
				new Promise<'still-waiting'>((r) => setTimeout(() => r('still-waiting'), 2_500).unref?.())
			]);
		} finally {
			if (saved === undefined) delete (globalThis as { window?: unknown }).window;
			else (globalThis as { window?: unknown }).window = saved;
		}
	};

	if ((await raced('morphit.io')) === 'aborted')
		ok('on a clearnet page a 600ms budget aborts at 600ms — clearnet behaviour is unchanged');
	else bad('a clearnet request did not abort at its own budget');

	if ((await raced('abc.onion')) === 'still-waiting')
		ok('on a .onion page the same 600ms budget is raised past it — the floor is applied');
	else
		bad(
			'a request from a hidden origin still aborted at its clearnet budget — ' +
				'the floor is NOT being applied inside fetchWithTimeout'
		);

	server.closeAllConnections?.();
	await new Promise<void>((r) => server.close(() => r()));
}

// ── 2. The floor never SHORTENS a longer caller budget ───────────────
{
	const { withHiddenFloor } = await import('../src/lib/net/transportBudget');
	const saved = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = { location: { hostname: 'abc.onion' } };
	try {
		if (withHiddenFloor(300_000) === 300_000)
			ok('a caller asking for longer than the floor keeps its own budget');
		else bad('the floor shortened a longer caller budget');
		if (withHiddenFloor(1_000) === INDEXER_TIMEOUT_HIDDEN_MS)
			ok(`a short caller budget is raised to the ${INDEXER_TIMEOUT_HIDDEN_MS}ms floor`);
		else bad(`a short budget was not raised to the floor (got ${withHiddenFloor(1_000)})`);
	} finally {
		if (saved === undefined) delete (globalThis as { window?: unknown }).window;
		else (globalThis as { window?: unknown }).window = saved;
	}
}

// ── 3. Nothing bypasses the helper with its own abort timer ──────────
// A hand-rolled `setTimeout(() => ctrl.abort(), N)` around a bare `fetch` is
// the one way back into this bug, because it never reaches the floor. Two such
// copies existed (the indexer client and the profile cache); both now compute
// their budget from the shared helpers. Any NEW one has to do the same.
{
	const ALLOWED =
		/transportBudget|indexerTimeoutMs|chainCallTimeoutMs|withHiddenFloor|requestTimeoutMs/;

	function walk(dir: string, out: string[] = []): string[] {
		for (const e of readdirSync(dir)) {
			const p = resolve(dir, e);
			if (statSync(p).isDirectory()) walk(p, out);
			else if (p.endsWith('.ts') || p.endsWith('.svelte')) out.push(p);
		}
		return out;
	}

	const offenders: string[] = [];
	let inspected = 0;
	for (const abs of walk(SRC)) {
		if (abs.includes('.test.')) continue;
		// The shared helper is where the floor is COMPUTED, so its own timer is
		// necessarily built from the already-raised value. It is the one
		// unavoidable exception, and scenario 4 pins it by name and by behaviour
		// so it cannot become a hiding place.
		if (abs.endsWith('lib/net/fetchWithTimeout.ts')) continue;
		const src = readFileSync(abs, 'utf8');
		// An abort driven by a timer — the hand-rolled shape.
		const re = /setTimeout\(\s*\(\s*\)\s*=>\s*[A-Za-z_$][\w$.]*\.abort\(\)\s*,\s*([^)]+)\)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(src))) {
			inspected++;
			const budget = m[1]!.trim();
			// A bare numeric literal, or a constant that is plainly a number, is
			// a clearnet budget that never sees the floor.
			if (!ALLOWED.test(budget)) {
				offenders.push(`${relative(WEB, abs)}: setTimeout(… abort(), ${budget})`);
			}
		}
	}

	// The sweep must actually be finding these shapes, or it passes vacuously.
	if (inspected >= 2) ok(`swept ${inspected} hand-rolled abort timers outside fetchWithTimeout`);
	else
		bad(
			`found only ${inspected} hand-rolled abort timers — the pattern this sweep ` +
				'matches has changed and it is no longer looking at anything'
		);

	if (offenders.length === 0)
		ok('every hand-rolled abort timer computes its budget from the shared transport helpers');
	else
		bad(
			`${offenders.length} fetch(es) bound by a clearnet budget that never reaches the hidden floor`,
			offenders.join('\n      ')
		);
}

// ── 4. fetchWithTimeout itself still routes through the floor ────────
// Pinned by name as well as by behaviour: deleting the call would make
// scenario 1 fail, but naming it makes the failure legible.
{
	const src = readFileSync(resolve(SRC, 'lib/net/fetchWithTimeout.ts'), 'utf8');
	if (/withHiddenFloor\(\s*timeoutMs/.test(src))
		ok('fetchWithTimeout raises the caller budget through withHiddenFloor');
	else bad('fetchWithTimeout no longer applies the hidden floor to its caller budget');
	if (/unref\?\.\(\)/.test(src) && !/\}\s*finally\s*\{\s*clearTimeout/.test(src))
		ok('and its timer stays armed across the body read rather than being cleared on headers');
	else
		bad(
			'fetchWithTimeout clears its timer in a finally again — the body read would be ' +
				'unbounded and a stalled response would never settle'
		);
}

console.log('');
console.log('─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} hidden-transport-budget-coverage scenarios passed`);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
