/**
 * The relay health probe asks only this box, and only the relay decides its
 * posture.
 *
 * The probe sent an HTTP request to the default gateway on every refresh —
 * on a host that is the LAN or provider router — and whichever candidate
 * answered first with a `hidden_only` decided the relay posture fed to the
 * clearnet gate, so anything else answering on the relay port (another
 * container on the bridge, a service on another interface, the gateway) could
 * make a node claim its relay reaches the chain only over hidden services.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';

import {
	primeOperationalSnapshot,
	getOperationalSnapshot,
	relayProbeCandidates,
	parseDefaultGatewayV4,
	__resetOperationalForTest,
	__operationalRefreshInFlightForTest,
	__setInContainerForTest
} from '$api/operationalHealth';
import { relayReportsHiddenOnly, _resetRelayPostureForTest } from '$indexer/relayPosture';

const ownAddress = Object.values(networkInterfaces())
	.flat()
	.find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
const gateway = ((): string | null => {
	try {
		return parseDefaultGatewayV4(readFileSync('/proc/net/route', 'utf8'));
	} catch {
		return null;
	}
})();

beforeEach(() => {
	__resetOperationalForTest();
	_resetRelayPostureForTest();
});
afterEach(() => {
	__setInContainerForTest(null);
});

describe.skipIf(gateway === null)('the default gateway', () => {
	it('is never asked on a host', () => {
		__setInContainerForTest(false);
		expect(relayProbeCandidates('').some((u) => u.includes(`//${gateway}:`))).toBe(false);
	});
	it('is asked inside a container, where it is the bridge the relay listens on', () => {
		__setInContainerForTest(true);
		expect(relayProbeCandidates('').some((u) => u.includes(`//${gateway}:`))).toBe(true);
	});
});

describe.skipIf(ownAddress === undefined)('who may set the relay posture', () => {
	let other: http.Server;
	afterEach(async () => {
		await new Promise<void>((r) => other.close(() => r()));
	});

	it('something else answering on the relay port, on another interface, is not the relay', async () => {
		// Nothing on loopback; another service on this box's own address says
		// hidden_only: true.
		other = http.createServer((_req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ status: 'ok', hidden_only: true }));
		});
		await new Promise<void>((r) => other.listen(0, ownAddress, r));
		const port = (other.address() as AddressInfo).port;
		const configured = `http://127.0.0.1:${port}/v1/health`;

		primeOperationalSnapshot(configured);
		await vi.waitFor(() => expect(__operationalRefreshInFlightForTest()).toBe(false), {
			timeout: 8_000
		});
		const relay = getOperationalSnapshot(configured, 0).relay;
		expect(relay.hidden_only, 'a non-loopback answer set the relay posture').toBeNull();
		expect(relayReportsHiddenOnly()).not.toBe(true);
	});
});
