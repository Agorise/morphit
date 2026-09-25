/**
 * "Zero use of clearnet internet" is a claim about the NODE, so the node's relay
 * has to be asked.
 *
 * F32. `clearnet_eliminated` was computed from the indexer's configuration
 * alone. The relay is a separate process with its own chain endpoints — and it
 * is the one that broadcasts — so an instance whose indexer was hidden-only and
 * whose relay was not (every tor-only install, until this release) claimed zero
 * clearnet while its relay talked to clearnet RPC operators from its own
 * address. The relay now reports `hidden_only` on its /v1/health; the
 * operational sampler that already probed that endpoint reads it; the gate
 * requires it.
 *
 * The relay here is a real HTTP server on loopback, answered the way the relay
 * answers. The sampler talks to it with node:http, exactly as in production.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import dns from 'node:dns';
import type { AddressInfo } from 'node:net';
import {
	primeOperationalSnapshot,
	getOperationalSnapshot,
	__resetOperationalForTest,
	__operationalRefreshInFlightForTest,
	hiddenOnlyOf,
	needsPublicLookup
} from '$api/operationalHealth';
import { relayReportsHiddenOnly, _resetRelayPostureForTest } from '$indexer/relayPosture';
import {
	clearnetLegsFromConfig,
	computeClearnetEliminated,
	clearnetEliminationMissing
} from '$indexer/clearnetGate';
import {
	installHiddenServiceDispatcher,
	type HiddenDispatcherHandle
} from '$indexer/hiddenServiceDispatcher';

/** An indexer config that passes every OTHER leg, so the relay is the only
 *  thing that can decide the verdict. */
const HIDDEN_ONLY_INDEXER = {
	blurtRpcEndpoints: [],
	hiddenRpcEndpoints: [`http://${'a'.repeat(56)}.onion:8091`],
	instanceTorAddress: `${'b'.repeat(56)}.onion`,
	instanceI2pB32Address: `${'c'.repeat(52)}.b32.i2p`,
	instanceMatrixHomeserver: null
};

describe('the gate requires the relay', () => {
	it('everything else proven, relay hidden-only → zero clearnet', () => {
		expect(computeClearnetEliminated(clearnetLegsFromConfig(HIDDEN_ONLY_INDEXER, true))).toBe(true);
	});

	it('everything else proven, relay NOT hidden-only → no claim', () => {
		const legs = clearnetLegsFromConfig(HIDDEN_ONLY_INDEXER, false);
		expect(
			computeClearnetEliminated(legs),
			'the node claimed zero clearnet while its relay used clearnet RPC'
		).toBe(false);
		expect(clearnetEliminationMissing(legs), 'and says which leg is missing').toEqual([
			'relayHidden'
		]);
	});
});

// ── a relay, answering /v1/health on loopback ───────────────────────────────
let relay: http.Server;
let answer: Record<string, unknown> | null = null;
let relayPort = 0;

beforeEach(async () => {
	__resetOperationalForTest();
	_resetRelayPostureForTest();
	answer = { status: 'ok', rpc_endpoints_healthy: 1, rpc_endpoints_total: 1, hidden_only: true };
	relay = http.createServer((req, res) => {
		if (answer === null) {
			res.statusCode = 503;
			res.end();
			return;
		}
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(answer));
	});
	await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
	relayPort = (relay.address() as AddressInfo).port;
});

let handle: HiddenDispatcherHandle | null = null;
afterEach(async () => {
	await handle?.uninstall();
	handle = null;
	vi.restoreAllMocks();
	await new Promise<void>((r) => relay.close(() => r()));
});

const url = (): string => `http://127.0.0.1:${relayPort}/v1/health`;

/** Run one background sample to completion. */
async function sample(): Promise<void> {
	primeOperationalSnapshot(url());
	await settled();
}

/** Wait for the background sample to FINISH — a condition, not a guessed sleep. */
async function settled(): Promise<void> {
	await vi.waitFor(() => expect(__operationalRefreshInFlightForTest()).toBe(false), {
		timeout: 8_000
	});
}

describe('the indexer learns the relay’s posture from its /v1/health', () => {
	it('a relay that says hidden_only: true is recorded as such', async () => {
		await sample();
		expect(getOperationalSnapshot(url(), 0).relay).toEqual({ up: true, hidden_only: true });
		expect(relayReportsHiddenOnly()).toBe(true);
	});

	it('a relay that says false is not hidden-only', async () => {
		answer = { status: 'ok', hidden_only: false };
		await sample();
		expect(relayReportsHiddenOnly()).toBe(false);
	});

	/** A relay older than this release answers without the field. Silence is
	 *  not proof. */
	it('a relay that does not say is NOT hidden-only', async () => {
		answer = { status: 'ok' };
		await sample();
		expect(getOperationalSnapshot(url(), 0).relay.up).toBe(true);
		expect(relayReportsHiddenOnly()).toBe(false);
	});

	/** The posture is configuration; it changes only across a restart, and a
	 *  restarted relay answers again. A relay that is merely down keeps what it
	 *  last said — the claim must not flicker with the relay's uptime. */
	it('a relay that goes down keeps the posture it last reported', async () => {
		await sample();
		expect(relayReportsHiddenOnly()).toBe(true);
		answer = null; // 503 from here on
		// A fresh sample, by asking past the cache TTL (a reset would also wipe
		// the memory under test).
		getOperationalSnapshot(url(), Date.now() + 60_000);
		await vi.waitFor(() => expect(getOperationalSnapshot(url(), 0).relay.up).toBe(false), {
			timeout: 8_000
		});
		expect(relayReportsHiddenOnly(), 'the claim flickered with the relay’s uptime').toBe(true);
	});

	it('the public health relay block is still { up } alone', async () => {
		// The shape /v1/health serves is built in health.ts from `up` only; this
		// pins that the snapshot carrying more does not change what a caller of
		// the public shape could have relied on.
		await sample();
		expect(Object.keys(getOperationalSnapshot(url(), 0).relay).sort()).toEqual([
			'hidden_only',
			'up'
		]);
	});
});

describe('parsing what the relay said', () => {
	const b = (s: string): Buffer[] => [Buffer.from(s)];
	it.each([
		['{"hidden_only":true}', true],
		['{"hidden_only":false}', false],
		['{"status":"ok"}', null],
		['{"hidden_only":"true"}', null],
		['not json', null]
	])('%s → %s', (body, want) => {
		expect(hiddenOnlyOf(b(body))).toBe(want);
	});
});

describe('a hidden-only indexer does not look its relay’s name up', () => {
	it('needsPublicLookup: a public name yes; an address literal or a local name no', () => {
		expect(needsPublicLookup('https://relay.example.com/v1/health')).toBe(true);
		expect(needsPublicLookup('http://127.0.0.1:8080/v1/health')).toBe(false);
		expect(needsPublicLookup('http://203.0.113.9:8080/v1/health')).toBe(false);
		expect(needsPublicLookup('http://localhost:8080/v1/health')).toBe(false);
		expect(needsPublicLookup(`http://${'a'.repeat(56)}.onion/v1/health`)).toBe(false);
	});

	it('with the fail-closed router installed, a configured public relay URL is never resolved', async () => {
		handle = installHiddenServiceDispatcher({ torSocks: '', i2pHttpProxy: '' }, 'refuse');
		const lookups: string[] = [];
		const real = dns.lookup;
		vi.spyOn(dns, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) => {
			lookups.push(host);
			return (real as (...a: unknown[]) => unknown)(host, ...rest);
		}) as typeof dns.lookup);
		primeOperationalSnapshot('https://relay.example.com/v1/health');
		// The whole sample has run, so "no lookup" means none happened, not
		// "none happened yet".
		await settled();
		expect(lookups, 'the hidden-only indexer asked the resolver for a public name').not.toContain(
			'relay.example.com'
		);
	});

	it('control: without the router, the same configured URL IS looked up', async () => {
		const lookups: string[] = [];
		const real = dns.lookup;
		vi.spyOn(dns, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) => {
			lookups.push(host);
			return (real as (...a: unknown[]) => unknown)(host, ...rest);
		}) as typeof dns.lookup);
		primeOperationalSnapshot('https://relay.example.com/v1/health');
		await vi.waitFor(() => expect(lookups).toContain('relay.example.com'), { timeout: 8_000 });
	});
});
