#!/usr/bin/env tsx
/**
 * apps/web/scripts/hidden-chat-verify-budget-smoke.ts
 *
 * Opening a chat from a Tor/I2P instance must not accuse anyone of tampering.
 *
 * THE BUG, END TO END
 * the maintainer asked whether chat works when someone on morphitlat (zero clearnet,
 * hidden pool only) starts a conversation with someone on morphitir.b32.i2p.
 * It did not, and the way it failed was the worst available:
 *
 *   1. Starting a FIRST chat with a peer hits pubPin's `no_pin` branch, which
 *      refuses to trust the indexer on first contact and verifies the peer's
 *      chat key against the chain.
 *   2. The browser makes that chain read through its own instance
 *      (`POST /v1/chain/condenser`) on a flat 15-second budget.
 *   3. The instance performs the real RPC on its node pool. On a hidden-only
 *      instance every node is a `.onion` or `.b32.i2p`, where the indexer
 *      allows itself 60 SECONDS because a cold circuit or tunnel has to be
 *      built first.
 *
 * So the browser abandoned the request while the server it was waiting on was
 * still well inside its own budget — and the browser's request had crossed a
 * hidden transport just to arrive. On morphitlat the abort was the normal case.
 *
 *   4. `fetchLatestChatIdentityFromChainQuorum` caught the transport error and
 *      returned `null`.
 *   5. pubPin reads `null` as "the chain reports no key for this peer" and
 *      throws `chain_reports_none` — a TAMPER code.
 *   6. The user was told their indexer "may be out of sync, or fabricating
 *      data", shown a red security banner, and advised to try a different
 *      Morphit instance. For someone using a hidden-only instance precisely
 *      because the alternatives are blocked where they live, that advice is
 *      worse than useless.
 *
 * Two independent defects, so two independent fixes, and this smoke EXECUTES
 * both: the budget must exceed what the server is allowed to take, and a
 * transport failure must never be reportable as tampering even when it happens.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	chainRelayTimeoutMs,
	isHiddenOrigin,
	ChainRelayError,
	INDEXER_HIDDEN_RPC_TIMEOUT_MS
} from '../src/lib/net/chainRelay';
import { fetchWithTimeout } from '../src/lib/net/fetchWithTimeout';

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

console.log('hidden-chat-verify-budget — a slow tunnel is not a tamper signal');
console.log('');

// ── 1. Hidden origins are recognised ─────────────────────────────────
{
	const hidden = [
		'cshiq5xf4kqhcvtvmvhvxwbmvwqxnbqzsvxqz2xq4nfrqgv6cq6vhoad.onion',
		'CSHIQ5XF4KQHCVTVMVHVXWBMVWQXNBQZSVXQZ2XQ4NFRQGV6CQ6VHOAD.ONION',
		'eanad5snqk3l7xwvpnzcdmxqvhqmqvbvqzqhq3nqvqvqvqvqvqvq.b32.i2p',
		'morphit.i2p'
	];
	const clear = ['morphit.io', 'morphit.timeapp.foundation', 'localhost'];
	if (hidden.every(isHiddenOrigin)) ok('every .onion/.i2p hostname reads as a hidden origin');
	else
		bad(
			'a hidden hostname was not recognised',
			hidden.filter((h) => !isHiddenOrigin(h)).join(', ')
		);
	if (clear.every((h) => !isHiddenOrigin(h))) ok('clearnet hostnames are not treated as hidden');
	else bad('a clearnet hostname was treated as hidden', clear.filter(isHiddenOrigin).join(', '));
}

// ── 2. THE CROSS-LAYER INVARIANT ─────────────────────────────────────
// The browser must not give up while the server it is waiting on is still
// allowed to be working. This is the defect in one line.
{
	const hiddenBudget = chainRelayTimeoutMs('abc.b32.i2p');
	const clearBudget = chainRelayTimeoutMs('morphit.io');

	if (hiddenBudget > INDEXER_HIDDEN_RPC_TIMEOUT_MS)
		ok(
			`hidden budget ${hiddenBudget}ms exceeds the indexer's own ${INDEXER_HIDDEN_RPC_TIMEOUT_MS}ms ` +
				'ceiling for one hidden RPC read'
		);
	else
		bad(
			`hidden budget ${hiddenBudget}ms does NOT exceed the indexer's ${INDEXER_HIDDEN_RPC_TIMEOUT_MS}ms ` +
				'ceiling — the browser will abort while the server is still working, and the user will be ' +
				"told the peer's key looks tampered"
		);

	// The browser's own leg also crosses the hidden transport, so matching the
	// server exactly is not enough.
	if (hiddenBudget >= INDEXER_HIDDEN_RPC_TIMEOUT_MS + 10_000)
		ok(
			`hidden budget leaves ${hiddenBudget - INDEXER_HIDDEN_RPC_TIMEOUT_MS}ms for the browser↔instance leg`
		);
	else bad('hidden budget leaves under 10s of headroom for the browser↔instance hidden leg');

	if (clearBudget === 15_000)
		ok('clearnet budget is unchanged at 15s — no cost to ordinary instances');
	else bad(`clearnet budget changed to ${clearBudget}ms; it should stay 15000`);

	if (chainRelayTimeoutMs(null) === clearBudget)
		ok('no-window (SSR) falls back to the clearnet budget');
	else bad('the SSR fallback budget does not match clearnet');
}

// ── 2b. The indexer API budget, both hops ────────────────────────────
// The chain relay was only half of it. EVERY frontend indexer call ran on a
// flat 8s, which on a Tor/I2P instance aborts during tunnel setup — so chat,
// the orderbook and the unread badge all failed, each reporting its own
// unrelated-looking symptom. And the TARGET origin matters independently: the
// compare page fetching a peer's orderbook from a .b32.i2p address could not
// finish in 8s even from a clearnet page.
{
	const { indexerTimeoutMs, INDEXER_TIMEOUT_CLEARNET_MS, INDEXER_TIMEOUT_HIDDEN_MS } = await import(
		'../src/lib/net/transportBudget'
	);

	// Target origin hidden, page origin clearnet (the compare-page case).
	// Asserted against an ABSOLUTE floor, not against INDEXER_TIMEOUT_HIDDEN_MS:
	// comparing the function's output to the very constant it returns is an
	// assertion that cannot fail when that constant is wrong, which is precisely
	// the failure mode being guarded against.
	const toHidden = indexerTimeoutMs(
		'http://eanad5snqk3l7xwvpnzcdmxqvhqmqvbvqzqhq3nqvqvqvqvqvqvq.b32.i2p'
	);
	if (toHidden >= 30_000)
		ok(`a call aimed at a .b32.i2p instance gets a tunnel-sized budget (${toHidden}ms)`);
	else
		bad(
			`a call aimed at a hidden instance got only ${toHidden}ms — the compare page cannot ` +
				'finish a cross-instance fetch to a .b32.i2p peer in that time'
		);
	if (toHidden > indexerTimeoutMs('https://morphit.io'))
		ok('the hidden target budget is strictly longer than the clearnet one');
	else bad('the hidden and clearnet budgets are identical — the distinction is not being made');

	if (indexerTimeoutMs('https://morphit.io') === INDEXER_TIMEOUT_CLEARNET_MS)
		ok('a call aimed at a clearnet instance keeps the short budget');
	else bad('a clearnet target no longer uses the clearnet budget');

	// Same-origin ('' or a path) must not be mistaken for a hidden host.
	if (indexerTimeoutMs('') === INDEXER_TIMEOUT_CLEARNET_MS)
		ok("same-origin ('') is not read as hidden");
	else bad("same-origin ('') was misread as a hidden target");
	// A PATH that happens to end in a hidden TLD. Without the explicit
	// leading-slash guard this falls through to the bare-hostname branch and is
	// misread as a hidden host, silently putting a same-origin call on the long
	// budget. '/relay' would not catch that — it fails the suffix test anyway,
	// so it is an assertion that cannot fail.
	if (indexerTimeoutMs('/relay.i2p') === INDEXER_TIMEOUT_CLEARNET_MS)
		ok("a relative origin that ends in a hidden TLD ('/relay.i2p') is not read as a hidden host");
	else bad("a relative origin ('/relay.i2p') was misread as a hidden host");

	// Page origin hidden (every call a Tor/I2P visitor makes), target same-origin.
	const realWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = { location: { hostname: 'abc.onion' } };
	try {
		if (indexerTimeoutMs('') === INDEXER_TIMEOUT_HIDDEN_MS)
			ok('a same-origin call from a .onion page gets the hidden budget');
		else
			bad(
				`a same-origin call from a .onion page got ${indexerTimeoutMs('')}ms — ` +
					'every request a Tor/I2P visitor makes will abort during tunnel setup'
			);
	} finally {
		if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
		else (globalThis as { window?: unknown }).window = realWindow;
	}

	if (INDEXER_TIMEOUT_HIDDEN_MS >= 30_000)
		ok(`hidden indexer budget ${INDEXER_TIMEOUT_HIDDEN_MS}ms covers a cold circuit/tunnel build`);
	else
		bad(
			`hidden indexer budget ${INDEXER_TIMEOUT_HIDDEN_MS}ms is under the 30-60s a cold ` +
				'Tor circuit or I2P tunnel routinely takes'
		);
}

// ── 3. The abort is real — execute it ────────────────────────────────
// Everything above is arithmetic over constants. This proves the mechanism the
// arithmetic is about: a server slower than the budget really does abort, and
// the same server inside the budget really does succeed.
{
	const server: Server = createServer((_req, res) => {
		setTimeout(() => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"result":"ok"}');
		}, 400);
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;
	const url = `http://127.0.0.1:${port}/v1/chain/condenser`;

	// Budget shorter than the server's response time → abort, exactly as a 15s
	// browser budget behaves against a 60s-capable hidden instance.
	let aborted = false;
	try {
		await fetchWithTimeout(url, { method: 'POST' }, 150);
	} catch (err) {
		aborted = err instanceof Error && err.name === 'AbortError';
	}
	if (aborted) ok('a server slower than the budget aborts the request (the failure being fixed)');
	else
		bad('the request did NOT abort when the server outran the budget — this smoke proves nothing');

	// Budget longer than the server's response time → success, which is what
	// raising the hidden budget buys.
	let okStatus = 0;
	try {
		const res = await fetchWithTimeout(url, { method: 'POST' }, 5_000);
		okStatus = res.status;
	} catch (err) {
		okStatus = -1;
		bad(
			'a request inside its budget still failed',
			err instanceof Error ? err.message : String(err)
		);
	}
	if (okStatus === 200) ok('the same server inside the budget answers normally');
	else if (okStatus !== -1) bad(`expected 200 inside the budget, got ${okStatus}`);

	await new Promise<void>((r) => server.close(() => r()));
}

// ── 3b. The BODY read is inside the budget too ───────────────────────
// `fetch()` resolves on headers. Clearing the abort timer there left the body
// read with no timeout at all, so a connection that died or stalled mid-body —
// the most ordinary hidden-transport failure — never settled. Not slow: never.
// A spinner that spins forever is worse than a clean timeout, and it is the one
// symptom raising the ceilings cannot fix.
{
	const server: Server = createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.write('{"resu'); // headers + a partial body, then nothing, ever
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;
	const url = `http://127.0.0.1:${port}/v1/chain/condenser`;

	const started = Date.now();
	// Bounded by a watchdog, because the failure this checks for is "never
	// settles" — awaiting it directly would hang the smoke itself, and a smoke
	// that hangs is a CI bomb rather than a test result (cp142/cp143).
	const attempt = (async (): Promise<'aborted' | 'resolved'> => {
		try {
			const res = await fetchWithTimeout(url, { method: 'POST' }, 1_000);
			await res.json();
			return 'resolved';
		} catch (err) {
			return err instanceof Error && err.name === 'AbortError' ? 'aborted' : 'resolved';
		}
	})();
	const settled = await Promise.race([
		attempt,
		new Promise<'hung'>((r) => setTimeout(() => r('hung'), 8_000).unref?.())
	]);
	const elapsed = Date.now() - started;
	if (settled === 'aborted' && elapsed < 5_000)
		ok(
			`a stalled response BODY aborts within the budget (${elapsed}ms), instead of hanging forever`
		);
	else
		bad(
			`a stalled body did not abort within the budget (settled=${settled} after ${elapsed}ms) — ` +
				'the caller would wait forever and the UI would never resolve'
		);
	server.closeAllConnections?.();
	await new Promise<void>((r) => server.close(() => r()));
}

// ── 3c. A dead body read surfaces as ChainRelayError, not a raw throw ─
// chainRelay only wrapped the fetch call, so a connection that died mid-body
// rejected with a raw `TypeError: terminated`. That is not a ChainRelayError,
// so the transport check in chainVerify missed it, it was swallowed into
// `null`, and it came back out as the false tamper warning — the exact bug,
// re-entering one step later.
{
	const server: Server = createServer((_req, res) => {
		// The headers must LAND before the socket dies, or `fetch()` itself
		// rejects and the already-wrapped outer catch handles it — which is how
		// an earlier version of this scenario passed against the unfixed code
		// while testing nothing. Declaring a content-length we never satisfy and
		// destroying on a later tick puts the failure squarely in the body read.
		res.writeHead(200, { 'content-type': 'application/json', 'content-length': '40' });
		res.write('{"result":');
		setTimeout(() => res.destroy(), 120).unref?.();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;

	const realWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = {
		location: { hostname: '127.0.0.1', origin: `http://127.0.0.1:${port}` }
	};
	try {
		// MORPHIT_INDEXER_ORIGIN is '' (same origin), so resolveOrigin returns
		// window.location.origin — which the stub above points at the dying
		// server. No module patching needed; this exercises the real path.
		const { chainRelay } = await import('../src/lib/net/chainRelay');
		let caught: unknown = null;
		try {
			await chainRelay('get_accounts', [['alice']]);
		} catch (e) {
			caught = e;
		}
		if (caught instanceof ChainRelayError)
			ok('a connection that dies mid-body throws ChainRelayError, not a raw TypeError');
		else
			bad(
				'a mid-body failure did not become a ChainRelayError, so it can still reach a tamper code',
				`got ${caught === null ? 'no error' : (caught as Error).constructor.name}: ${String(caught)}`
			);
	} finally {
		if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
		else (globalThis as { window?: unknown }).window = realWindow;
		server.closeAllConnections?.();
		await new Promise<void>((r) => server.close(() => r()));
	}
}

// ── 3d. Every chain-backed endpoint shares the hidden floor ──────────
// `/v1/chain/condenser` was not the only same-origin route that makes the
// indexer talk to the chain. `/v1/chain/properties` (every chat send),
// `/v1/chain/key-references` and `/v1/broadcast` all do, and all had flat
// clearnet budgets — so raising only the relay left the chat send still dying
// at 15s while the identity check beside it succeeded.
{
	const { chainCallTimeoutMs, CHAIN_VIA_INDEXER_HIDDEN_MS } = await import(
		'../src/lib/net/transportBudget'
	);
	const realWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = { location: { hostname: 'abc.onion' } };
	try {
		for (const clearnet of [10_000, 15_000, 30_000]) {
			const got = chainCallTimeoutMs(clearnet);
			if (got >= CHAIN_VIA_INDEXER_HIDDEN_MS)
				ok(`a ${clearnet}ms chain-backed call is raised to ${got}ms on a hidden origin`);
			else bad(`a ${clearnet}ms chain-backed call got only ${got}ms on a hidden origin`);
		}
	} finally {
		if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
		else (globalThis as { window?: unknown }).window = realWindow;
	}
	// It is a FLOOR, never a ceiling: a caller that already allows longer keeps it.
	if (chainCallTimeoutMs(120_000, 'http://abc.onion') === 120_000)
		ok('a caller that already allows longer than the floor keeps its own budget');
	else bad('the hidden floor SHORTENED a longer caller budget');
	// And clearnet is untouched.
	for (const clearnet of [10_000, 15_000, 30_000]) {
		if (chainCallTimeoutMs(clearnet, 'https://morphit.io') === clearnet) continue;
		bad(`a clearnet chain call no longer uses its own ${clearnet}ms budget`);
	}
	ok('clearnet chain-backed calls keep their original budgets');

	// The call sites must actually USE it — a helper nothing calls is decoration.
	const { readFileSync } = await import('node:fs');
	for (const [file, needed] of [
		['../src/lib/blurt/broadcastTransport.ts', 2],
		['../src/lib/blurt/accountByKey.ts', 1],
		['../src/lib/stores/chainFee.ts', 1]
	] as const) {
		const src = readFileSync(new URL(file, import.meta.url), 'utf8');
		const uses = (src.match(/chainCallTimeoutMs\(/g) ?? []).length;
		if (uses >= needed)
			ok(`${file.split('/').pop()} routes ${uses} chain call(s) through the floor`);
		else
			bad(
				`${file.split('/').pop()} uses the floor ${uses} time(s), expected ${needed} — ` +
					'a flat budget there still aborts the whole flow on a hidden instance'
			);
	}
}

// ── 3e. Lokinet counts as hidden ─────────────────────────────────────
// The rest of the app already treats `.loki` as a hidden network — the URL
// validator accepts it, the footer and instances page render it. Omitting it
// here would have left a Lokinet instance on the clearnet budgets and therefore
// on the original bug, while everything around it disagreed.
{
	const { isHiddenHostname, indexerTimeoutMs, INDEXER_TIMEOUT_CLEARNET_MS } = await import(
		'../src/lib/net/transportBudget'
	);
	if (isHiddenHostname('someinstance.loki')) ok('a .loki hostname is recognised as hidden');
	else bad('.loki is not recognised as hidden, contradicting instanceUrl.ts and the footer');
	if (indexerTimeoutMs('http://someinstance.loki') > INDEXER_TIMEOUT_CLEARNET_MS)
		ok('a call aimed at a .loki instance gets the hidden budget');
	else bad('a .loki target still gets the clearnet budget');

	// Bare `host:port` must not slip through. `new URL('abc.onion:8080')` does
	// NOT throw — it parses as the scheme `abc.onion:` with an empty hostname —
	// so a naive URL-first check silently calls it clearnet.
	const { isHiddenOrigin } = await import('../src/lib/net/transportBudget');
	for (const shape of [
		'abc.onion:8080',
		'morphitir.b32.i2p:4444',
		'//abc.onion',
		'abc.onion/path'
	]) {
		if (isHiddenOrigin(shape)) ok(`"${shape}" is recognised as a hidden origin`);
		else bad(`"${shape}" was classified as clearnet`);
	}
	// ...without creating false positives.
	for (const shape of ['evil.onion.example.com', 'notonion', 'morphit.io:443', '/relay.i2p', '']) {
		if (!isHiddenOrigin(shape)) continue;
		bad(`"${shape}" was wrongly classified as hidden`);
	}
	ok('lookalike and relative inputs are not misread as hidden origins');

	// A TIMEOUT HELPER MUST BE TOTAL. `window.location.hostname` is typed as a
	// string but is not one everywhere the app runs: during prerender, in a
	// worker, or under a harness that stubs `window` with only
	// `location.origin`. An unguarded `.toLowerCase()` threw from inside the
	// budget calculation, so the request failed, retried, and failed the same
	// way — 7 unit tests hung for 12 seconds each before this was caught.
	const { currentHostname } = await import('../src/lib/net/transportBudget');
	const saved = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = { location: { origin: 'https://morphit.io' } };
	try {
		if (currentHostname() === null)
			ok('a window with no location.hostname yields null, not undefined');
		else bad(`currentHostname() returned ${String(currentHostname())} for a partial location`);
		const budget = indexerTimeoutMs();
		if (budget === INDEXER_TIMEOUT_CLEARNET_MS)
			ok('and the budget still computes rather than throwing mid-request');
		else bad(`budget was ${budget} with a partial window`);
	} catch (e) {
		bad(
			'computing a budget THREW with a partial window',
			e instanceof Error ? e.message : String(e)
		);
	} finally {
		if (saved === undefined) delete (globalThis as { window?: unknown }).window;
		else (globalThis as { window?: unknown }).window = saved;
	}
	for (const v of [undefined, null, '']) {
		if (isHiddenHostname(v as unknown as string)) {
			bad(`isHiddenHostname(${String(v)}) returned true`);
		}
	}
	ok('isHiddenHostname tolerates undefined / null / empty without throwing');
}

// ── 4. Unreachable must never be reportable as tampering ─────────────
// The budget fix makes the abort rare. This makes it harmless when it happens.
{
	const { PubPinError } = await import('../src/lib/chat/pubPin');
	const relayErr = new ChainRelayError('could not reach the indexer: AbortError');

	if (!(relayErr instanceof PubPinError))
		ok('a chain-relay failure is not a PubPinError, so it cannot be read as a tamper signal');
	else bad('ChainRelayError is being treated as a PubPinError');

	// peerPubFetch's contract: only PubPinError becomes `tamper_detected`.
	// Anything else must land in a non-accusatory branch.
	const src = (await import('node:fs')).readFileSync(
		new URL('../src/lib/chat/peerPubFetch.ts', import.meta.url),
		'utf8'
	);
	if (/ChainRelayError[\s\S]{0,200}kind:\s*'chain_unreachable'/.test(src))
		ok("peerPubFetch routes a relay failure to 'chain_unreachable', not 'tamper_detected'");
	else bad("peerPubFetch does not route ChainRelayError to a 'chain_unreachable' result");

	// And the quorum verifier must RE-THROW a transport error rather than
	// collapsing it into the null that pubPin reads as "the chain says none".
	const verifySrc = (await import('node:fs')).readFileSync(
		new URL('../src/lib/chat/chainVerify.ts', import.meta.url),
		'utf8'
	);
	const rethrows = verifySrc.match(/if \(err instanceof ChainRelayError\) throw err;/g) ?? [];
	if (rethrows.length >= 2)
		ok(
			`chainVerify re-throws transport failures in ${rethrows.length} places instead of returning null`
		);
	else
		bad(
			`chainVerify re-throws a transport failure in only ${rethrows.length} place(s); ` +
				'both the history fetch and the signature verify must do it, or a timeout still ' +
				'becomes chain_reports_none'
		);
}

// ── 5. The user-facing copy exists and does not accuse ───────────────
{
	const en = JSON.parse(
		(await import('node:fs')).readFileSync(
			new URL('../src/lib/i18n/locales/en.json', import.meta.url),
			'utf8'
		)
	) as Record<string, Record<string, Record<string, string>>>;

	const sec = en.chat?.security?.chain_unreachable;
	const panel = en.chat?.verify_peer?.error_chain_unreachable;

	if (typeof sec === 'string' && sec.length > 0) ok('chat.security.chain_unreachable exists');
	else bad('chat.security.chain_unreachable is missing');
	if (typeof panel === 'string' && panel.length > 0)
		ok('chat.verify_peer.error_chain_unreachable exists');
	else bad('chat.verify_peer.error_chain_unreachable is missing');

	// The whole point is that this message does NOT read as an accusation, and
	// does NOT send a censored user off to find another instance.
	const accusatory = /fabricat|tamper|another Morphit instance|different Morphit instance/i;
	for (const [name, copy] of [
		['chat.security.chain_unreachable', sec],
		['chat.verify_peer.error_chain_unreachable', panel]
	] as const) {
		if (typeof copy === 'string' && !accusatory.test(copy))
			ok(`${name} neither accuses the operator nor sends the user to another instance`);
		else bad(`${name} still reads as an accusation or redirects to another instance`, String(copy));
	}
}

console.log('');
console.log('─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} hidden-chat-verify-budget scenarios passed`);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
