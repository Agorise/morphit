/**
 * The post-upgrade IPFS privacy heal (v1.18.0 deep-deep, H3).
 *
 * `morphit-ops upgrade` does not re-run Ansible, so without this heal every
 * EXISTING tor-only node would keep a stock Kubo that joins the public IPFS DHT
 * from its home IP. These run the heal with the REAL settings script
 * (ops/ipfs/morphit-ipfs-privacy.sh) against a stub `ipfs` that keeps its config
 * in a real JSON file, and a simulated service that can refuse to come back.
 * They assert the resulting config, whether the service is running, and — when
 * the restart fails — that the previous config is back byte for byte.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyAndVerifyIpfsPrivacy, type IpfsPrivacyRuntime } from '../src/lib/ipfsPrivacyHeal.ts';

const SCRIPT = join(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'ops',
	'ipfs',
	'morphit-ipfs-privacy.sh'
);

// A stub Kubo CLI: `config <key>`, `config --json <key> <value>`. Config lives
// in $IPFS_PATH/config as JSON, like the real one.
const STUB_IPFS = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const cfgPath = path.join(process.env.IPFS_PATH, 'config');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--timeout'));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const walk = (k) => k.split('.');
if (args[0] === 'config' && args[1] === '--json') {
  const keys = walk(args[2]); let o = cfg;
  for (const k of keys.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = JSON.parse(args[3]);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  process.exit(0);
}
if (args[0] === 'config') {
  let o = cfg;
  for (const k of walk(args[1])) { if (o === null || typeof o !== 'object' || !(k in o)) { console.error('Error: key has no attributes'); process.exit(1); } o = o[k]; }
  console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  process.exit(0);
}
process.exit(0);
`;

const STOCK = {
	Addresses: {
		Swarm: ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/udp/4001/quic-v1'],
		Gateway: '/ip4/0.0.0.0/tcp/8082'
	},
	Bootstrap: ['auto'],
	Routing: { Type: 'auto', DelegatedRouters: ['auto'] },
	Swarm: { DisableNatPortMap: false, ConnMgr: { HighWater: 80 } },
	Discovery: { MDNS: { Enabled: true } },
	Gateway: { NoFetch: true }
};

let dir: string;
let repo: string;
let bin: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'morphit-ipfs-heal-'));
	repo = join(dir, 'repo');
	bin = join(dir, 'bin');
	mkdirSync(repo);
	mkdirSync(bin);
	writeFileSync(join(bin, 'ipfs'), STUB_IPFS);
	chmodSync(join(bin, 'ipfs'), 0o755);
	writeFileSync(join(repo, 'config'), JSON.stringify(STOCK, null, 2));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function readCfg(): Record<string, any> {
	return JSON.parse(readFileSync(join(repo, 'config'), 'utf8'));
}

/** A runtime whose settings calls run the REAL script against the stub, and
 *  whose service is simulated: `startsWith(config)` decides if a restart works. */
function runtime(opts: {
	active: boolean;
	startsWith?: (cfg: Record<string, any>) => boolean;
}): IpfsPrivacyRuntime & { state: { active: boolean; restarts: number } } {
	const state = { active: opts.active, restarts: 0 };
	return {
		state,
		kuboPresent: () => true,
		runPrivacy: (mode) =>
			spawnSync('sh', [SCRIPT, mode], {
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, IPFS_PATH: repo },
				stdio: 'ignore'
			}).status ?? 1,
		readConfig: () => readFileSync(join(repo, 'config'), 'utf8'),
		writeConfig: (t) => (writeFileSync(join(repo, 'config'), t), true),
		isActive: () => state.active,
		restart: () => {
			state.restarts++;
			state.active = (opts.startsWith ?? (() => true))(readCfg());
			return state.active;
		},
		answers: () => state.active,
		sleep: async () => undefined,
		spinner: () => () => undefined
	};
}

const quiet = { info: () => undefined, warn: () => undefined };

describe('IPFS privacy heal', { timeout: 30_000 }, () => {
	it('hidden-only node on a stock Kubo: leaves the public IPFS network, restarts, is running', async () => {
		const rt = runtime({ active: true });
		const out = await applyAndVerifyIpfsPrivacy({
			hiddenOnly: true,
			runtime: rt,
			...quiet,
			tries: 3
		});
		expect(out).toEqual({ kind: 'applied', mode: 'hidden' });
		const c = readCfg();
		expect(c.Routing.Type).toBe('none');
		expect(c.Routing.DelegatedRouters).toEqual([]);
		expect(c.Bootstrap).toEqual([]);
		expect(c.Addresses.Swarm).toEqual([]);
		expect(c.Swarm.DisableNatPortMap).toBe(true);
		expect(c.Discovery.MDNS.Enabled).toBe(false);
		expect(c.AutoConf.Enabled).toBe(false);
		expect(c.AutoTLS.Enabled).toBe(false);
		expect(c.Provide.Enabled).toBe(false);
		expect(c.Plugins.Plugins.telemetry.Config.Mode).toBe('off');
		// Untouched: the gateway that serves the release over Tor/I2P.
		expect(c.Addresses.Gateway).toBe('/ip4/0.0.0.0/tcp/8082');
		expect(c.Gateway.NoFetch).toBe(true);
		expect(rt.state).toEqual({ active: true, restarts: 1 });
	});

	it('already private: changes nothing and restarts nothing', async () => {
		await applyAndVerifyIpfsPrivacy({
			hiddenOnly: true,
			runtime: runtime({ active: true }),
			...quiet
		});
		const before = readFileSync(join(repo, 'config'), 'utf8');
		const rt = runtime({ active: true });
		const out = await applyAndVerifyIpfsPrivacy({ hiddenOnly: true, runtime: rt, ...quiet });
		expect(out).toEqual({ kind: 'already-private', mode: 'hidden' });
		expect(readFileSync(join(repo, 'config'), 'utf8')).toBe(before);
		expect(rt.state.restarts).toBe(0);
	});

	it('the daemon will not start on the new settings: previous config restored byte for byte, service back up', async () => {
		const before = readFileSync(join(repo, 'config'), 'utf8');
		const rt = runtime({ active: true, startsWith: (c) => c.Routing?.Type !== 'none' });
		const out = await applyAndVerifyIpfsPrivacy({
			hiddenOnly: true,
			runtime: rt,
			...quiet,
			tries: 3
		});
		expect(out).toEqual({ kind: 'rolled-back' });
		expect(readFileSync(join(repo, 'config'), 'utf8')).toBe(before);
		expect(rt.state.active).toBe(true);
		expect(rt.state.restarts).toBe(2);
	});

	it('a service that was not running is configured but not started', async () => {
		const rt = runtime({ active: false });
		const out = await applyAndVerifyIpfsPrivacy({ hiddenOnly: true, runtime: rt, ...quiet });
		expect(out).toEqual({ kind: 'applied-not-running', mode: 'hidden' });
		expect(readCfg().Routing.Type).toBe('none');
		expect(rt.state).toEqual({ active: false, restarts: 0 });
	});

	it('clearnet node: only telemetry is turned off; routing and swarm stay as they were', async () => {
		const rt = runtime({ active: true });
		const out = await applyAndVerifyIpfsPrivacy({
			hiddenOnly: false,
			runtime: rt,
			...quiet,
			tries: 3
		});
		expect(out).toEqual({ kind: 'applied', mode: 'base' });
		const c = readCfg();
		expect(c.Plugins.Plugins.telemetry.Config.Mode).toBe('off');
		expect(c.Routing.Type).toBe('auto');
		expect(c.Bootstrap).toEqual(['auto']);
		expect(c.Addresses.Swarm).toEqual(STOCK.Addresses.Swarm);
	});
});
