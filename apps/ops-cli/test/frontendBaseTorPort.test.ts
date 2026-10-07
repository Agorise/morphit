/**
 * "Docker pulls through Tor" means through TOR's SocksPort (the one the
 * indexer uses, MORPHIT_INDEXER_TOR_SOCKS), not any SOCKS proxy on 127.0.0.1:
 * another local SOCKS proxy (an ssh -D tunnel, a VPN client) carries the pull
 * out over clearnet.
 */
import { describe, expect, it } from 'vitest';
import {
	daemonJsonProxiesAllowTor,
	dockerDaemonPullsThroughTor
} from '../src/lib/proxyConfigHeal.ts';

const TOR = '127.0.0.1:9050';

describe("Docker's proxy is compared with Tor's configured SocksPort", () => {
	it('daemon.json: a SOCKS proxy on another local port is not Tor', () => {
		expect(
			daemonJsonProxiesAllowTor(
				'{"proxies":{"https-proxy":"socks5h://127.0.0.1:1080","http-proxy":"socks5h://127.0.0.1:1080"}}',
				TOR
			)
		).toBe(false);
		expect(
			daemonJsonProxiesAllowTor(
				'{"proxies":{"https-proxy":"socks5://127.0.0.1:9150"}}',
				'127.0.0.1:9150'
			)
		).toBe(true);
		expect(
			daemonJsonProxiesAllowTor(
				'{"proxies":{"https-proxy":"socks5://127.0.0.1:9050"}}',
				'127.0.0.1:9150'
			)
		).toBe(false);
	});
	it("the running daemon's environment: only Tor's SocksPort counts", () => {
		const env = (p: string) => () => [
			`HTTPS_PROXY=${p}`,
			`HTTP_PROXY=${p}`,
			'NO_PROXY=localhost,127.0.0.0/8,::1'
		];
		const run = (p: string, tor = TOR) =>
			dockerDaemonPullsThroughTor({
				daemonJson: () => null,
				daemonEnv: env(p),
				torSocks: () => tor
			});
		expect(run('socks5://127.0.0.1:9050')).toBe(true);
		expect(run('socks5h://127.0.0.1:9050')).toBe(true);
		expect(run('socks5://127.0.0.1:1080')).toBe(false);
		expect(run('socks5://127.0.0.1:9050', '127.0.0.1:9150')).toBe(false);
		expect(run('socks5://127.0.0.1:9150', '127.0.0.1:9150')).toBe(true);
		expect(run('http://127.0.0.1:9050')).toBe(false);
		// Go reads HTTPS_PROXY before https_proxy: the upper-case one decides.
		expect(
			dockerDaemonPullsThroughTor({
				daemonJson: () => null,
				daemonEnv: () => [
					'HTTPS_PROXY=socks5://127.0.0.1:1080',
					'https_proxy=socks5://127.0.0.1:9050'
				],
				torSocks: () => TOR
			})
		).toBe(false);
		// no daemon environment readable: not proof of anything
		expect(
			dockerDaemonPullsThroughTor({
				daemonJson: () => null,
				daemonEnv: () => null,
				torSocks: () => TOR
			})
		).toBe(false);
	});
});
