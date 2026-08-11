/**
 * hiddenServiceFetch — SOCKS5 wire helpers + network classification (Layer 6).
 * The byte-level SOCKS5 handshake and the URL→network mapping are the fiddly,
 * security-relevant parts; they're pure, so we test them without a live socket.
 */
import { describe, it, expect } from 'vitest';
import {
	socks5Greeting,
	parseSocks5Greeting,
	socks5ConnectRequest,
	parseSocks5ConnectReply,
	hiddenNetworkOf,
	hiddenServiceProxyConfigFromEnv
} from '$indexer/hiddenServiceFetch';

const ONION = 'uecm7rzkz2zek6wefgth2qsuhbynlwdtx6b45y65tzde6ulror6ccpqd.onion';

describe('SOCKS5 greeting', () => {
	it('offers version 5, no-auth', () => {
		expect([...socks5Greeting()]).toEqual([0x05, 0x01, 0x00]);
	});
	it('accepts a no-auth reply', () => {
		expect(parseSocks5Greeting(Buffer.from([0x05, 0x00])).ok).toBe(true);
	});
	it('rejects an auth-required reply', () => {
		const r = parseSocks5Greeting(Buffer.from([0x05, 0x02]));
		expect(r.ok).toBe(false);
	});
	it('rejects a wrong version', () => {
		expect(parseSocks5Greeting(Buffer.from([0x04, 0x00])).ok).toBe(false);
	});
	it('rejects a short reply', () => {
		expect(parseSocks5Greeting(Buffer.from([0x05])).ok).toBe(false);
	});
});

describe('SOCKS5 CONNECT request (ATYP=domain, Tor resolves the onion)', () => {
	it('lays out version/cmd/atyp/len/host/port correctly', () => {
		const req = socks5ConnectRequest('example.onion', 80);
		expect(req[0]).toBe(0x05); // version
		expect(req[1]).toBe(0x01); // CONNECT
		expect(req[2]).toBe(0x00); // reserved
		expect(req[3]).toBe(0x03); // ATYP domain
		expect(req[4]).toBe('example.onion'.length);
		expect(req.subarray(5, 5 + 13).toString('ascii')).toBe('example.onion');
		expect(req.readUInt16BE(req.length - 2)).toBe(80);
	});
	it('encodes a non-default port', () => {
		const req = socks5ConnectRequest('x.onion', 8443);
		expect(req.readUInt16BE(req.length - 2)).toBe(8443);
	});
});

describe('SOCKS5 CONNECT reply', () => {
	it('accepts success (0x00)', () => {
		expect(parseSocks5ConnectReply(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])).ok).toBe(true);
	});
	it('reports "connection refused" (0x05) as target-unreachable', () => {
		const r = parseSocks5ConnectReply(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/refused/);
	});
	it('reports "host unreachable" (0x04)', () => {
		const r = parseSocks5ConnectReply(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/unreachable/);
	});
});

describe('hiddenNetworkOf', () => {
	it('classifies a v3 onion as tor', () => {
		expect(hiddenNetworkOf(`http://${ONION}/v1/health`)).toBe('tor');
	});
	it('classifies .b32.i2p and named .i2p as i2p', () => {
		expect(hiddenNetworkOf(`http://${'a'.repeat(52)}.b32.i2p/`)).toBe('i2p');
		expect(hiddenNetworkOf('http://morphit.i2p/')).toBe('i2p');
	});
	it('classifies .loki as loki', () => {
		expect(hiddenNetworkOf('http://morphit.loki/')).toBe('loki');
	});
	it('returns null for clearnet', () => {
		expect(hiddenNetworkOf('https://morphit.example/')).toBeNull();
	});
	it('rejects a non-v3-length onion (not tor)', () => {
		expect(hiddenNetworkOf('http://short.onion/')).toBeNull();
	});
});

describe('proxy config from env', () => {
	it('defaults to co-located Tor + i2pd', () => {
		const c = hiddenServiceProxyConfigFromEnv({});
		expect(c.torSocks).toBe('127.0.0.1:9050');
		expect(c.i2pHttpProxy).toBe('127.0.0.1:4444');
	});
	it('honours overrides', () => {
		const c = hiddenServiceProxyConfigFromEnv({
			MORPHIT_INDEXER_TOR_SOCKS: '10.0.0.9:9150',
			MORPHIT_INDEXER_I2P_HTTP_PROXY: '10.0.0.9:4447'
		} as NodeJS.ProcessEnv);
		expect(c.torSocks).toBe('10.0.0.9:9150');
		expect(c.i2pHttpProxy).toBe('10.0.0.9:4447');
	});
});
