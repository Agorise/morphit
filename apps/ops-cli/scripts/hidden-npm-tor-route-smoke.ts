/**
 * hidden-npm-tor-route-smoke — proves that the npm a hidden-only upgrade runs
 * (lib/depsInstall.ts: torNpmEnv + startTorRegistryBridge) reaches the registry
 * ONLY through Tor's SOCKS port, by name, and opens no other connection.
 *
 * The whole run happens inside a fresh network namespace (`unshare -n`) whose
 * only interface is loopback: no route, no resolver. In it run a stand-in npm
 * registry (HTTPS, a certificate for registry.npmjs.org), a stand-in Tor SOCKS
 * port that relays `registry.npmjs.org:443` to it, the real bridge, and the
 * REAL `npm ci --ignore-scripts` with the real environment. If npm resolved a
 * name itself or dialled anything directly, it could not finish here. It must
 * finish, the package must be installed, and the SOCKS port must have been
 * asked for the registry by NAME.
 *
 * Then the UPDATE the upgrade tries first since morphitlat's v1.21.19 upgrade
 * (a full `npm ci` through Tor for 5 changed packages of 821, still running
 * after two hours): the release's lockfile changes one package of two, and the
 * REAL `npm install --ignore-scripts --no-save` runs over the installed tree
 * through the same chain. It must finish, fetch ONLY the changed package (the
 * unchanged one is never asked for again), install it, and leave the lockfile
 * byte for byte as the release shipped it.
 *
 * Needs openssl. Where network namespaces are not allowed (a CI container
 * without CAP_SYS_ADMIN), it runs the same install in the host's network
 * instead and says so: npm then trusts ONLY the stand-in registry's
 * certificate and the locked package's hash is the stand-in's, so npm can
 * only finish through the SOCKS chain (a direct connection would reach the
 * real registry, fail the certificate check and fail the hash). What that
 * mode cannot show is a local DNS lookup; the namespace mode does. Run: cd apps/ops-cli && tsx --tsconfig ../../tsconfig.smoke.json
 * scripts/hidden-npm-tor-route-smoke.ts
 */
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { startTorRegistryBridge, torNpmEnv } from '../src/lib/depsInstall.ts';

const SELF = fileURLToPath(import.meta.url);
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const canIsolate = (): boolean => {
	if (process.env.MORPHIT_SMOKE_NO_NETNS === '1') return false;
	const t = spawnSync('unshare', ['-n', 'true'], { stdio: 'ignore' });
	return !t.error && t.status === 0;
};
const isolated = process.argv[2] === '--inside';
if (!isolated && canIsolate()) {
	// Outer: re-run this file inside a network namespace with loopback only.
	const tsx = process.argv[0]!;
	const args = process.execArgv.concat([SELF, '--inside']);
	const r = spawnSync(
		'unshare',
		[
			'-n',
			'sh',
			'-c',
			'ip link set lo up 2>/dev/null || ifconfig lo up; exec "$0" "$@"',
			tsx,
			...args
		],
		{ stdio: 'inherit' }
	);
	if (r.error || r.status === null) {
		console.log('✗ could not create a network namespace (unshare -n) — this proof needs one');
		process.exit(1);
	}
	process.exit(r.status);
}

// ── Inside the namespace (or, where none can be made, the host's network) ──
if (!isolated) {
	console.log(
		'  • no network namespace can be made here: running in the host network; npm can only finish through the SOCKS chain (stand-in certificate and package hash), but a local DNS lookup is not observable in this mode'
	);
}
const work = mkdtempSync(join(tmpdir(), 'morphit-npm-tor-'));
try {
	// 0. The namespace really has no way out.
	if (isolated) {
		const dns = spawnSync('getent', ['hosts', 'registry.npmjs.org'], {
			encoding: 'utf8',
			timeout: 15_000
		});
		check('the namespace cannot resolve registry.npmjs.org itself', dns.status !== 0);
	}

	// 1. Packages, as the registry would serve them.
	const tarballs = new Map<string, string>();
	const pack = (name: string, version: string): string => {
		const src = join(work, `pkgsrc-${name}-${version}`);
		const pkgDir = join(src, 'package');
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, 'package.json'),
			JSON.stringify({ name, version, main: 'index.js' })
		);
		writeFileSync(join(pkgDir, 'index.js'), `module.exports = '${name}@${version}';\n`);
		const tgz = join(work, `${name}-${version}.tgz`);
		spawnSync('tar', ['-czf', tgz, '-C', src, 'package']);
		tarballs.set(`/${name}/-/${name}-${version}.tgz`, tgz);
		return `sha512-${createHash('sha512').update(readFileSync(tgz)).digest('base64')}`;
	};
	const integrity = pack('left-pad', '1.3.0');
	const rightIntegrity = pack('right-pad', '2.0.0');
	const nextIntegrity = pack('left-pad', '1.3.1');
	const served: string[] = [];

	// 2. The registry, with a certificate for its real name.
	const cert = join(work, 'c.pem');
	const key = join(work, 'k.pem');
	spawnSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-days',
			'1',
			'-subj',
			'/CN=registry.npmjs.org',
			'-addext',
			'subjectAltName=DNS:registry.npmjs.org',
			'-keyout',
			key,
			'-out',
			cert
		],
		{ stdio: 'ignore' }
	);
	const registry = createHttpsServer(
		{ key: readFileSync(key), cert: readFileSync(cert) },
		(req, res) => {
			served.push(req.url ?? '');
			const tgz = tarballs.get(req.url ?? '');
			if (tgz !== undefined) {
				res.writeHead(200, { 'content-type': 'application/octet-stream' });
				res.end(readFileSync(tgz));
				return;
			}
			res.writeHead(404);
			res.end();
		}
	);
	await new Promise<void>((r) => registry.listen(0, '127.0.0.1', r));
	const regPort = (registry.address() as AddressInfo).port;

	// 3. "Tor": a SOCKS5 port that relays registry.npmjs.org:443 to the registry.
	const asked: string[] = [];
	const socks = createNetServer((s) => {
		let acc = Buffer.alloc(0);
		let greeted = false;
		const onData = (d: Buffer): void => {
			acc = Buffer.concat([acc, d]);
			if (!greeted && acc.length >= 3) {
				greeted = true;
				acc = acc.subarray(3);
				s.write(Buffer.from([0x05, 0x00]));
			}
			if (greeted && acc.length >= 5 && acc[3] === 0x03 && acc.length >= 7 + acc[4]!) {
				const host = acc.subarray(5, 5 + acc[4]!).toString('ascii');
				const port = acc.readUInt16BE(5 + acc[4]!);
				asked.push(`${host}:${port}`);
				s.removeListener('data', onData);
				if (host !== 'registry.npmjs.org' || port !== 443) {
					s.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					return;
				}
				const up = netConnect({ host: '127.0.0.1', port: regPort }, () => {
					s.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
					up.pipe(s);
					s.pipe(up);
				});
				up.on('error', () => s.destroy());
			} else if (greeted && acc.length >= 4 && acc[3] !== 0x03) {
				asked.push(`(address, not a name: atyp ${acc[3]})`);
				s.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
			}
		};
		s.on('data', onData);
		s.on('error', () => undefined);
	});
	await new Promise<void>((r) => socks.listen(0, '127.0.0.1', r));
	const socksPort = (socks.address() as AddressInfo).port;

	// 4. A project locked to the package, installed the way the upgrade does it.
	const proj = join(work, 'proj');
	mkdirSync(proj);
	const project = (left: string, leftIntegrity: string): void => {
		const deps = { 'left-pad': left, 'right-pad': '2.0.0' };
		writeFileSync(
			join(proj, 'package.json'),
			JSON.stringify({ name: 'p', version: '1.0.0', dependencies: deps })
		);
		writeFileSync(
			join(proj, 'package-lock.json'),
			JSON.stringify(
				{
					name: 'p',
					version: '1.0.0',
					lockfileVersion: 3,
					requires: true,
					packages: {
						'': { name: 'p', version: '1.0.0', dependencies: deps },
						'node_modules/left-pad': {
							version: left,
							resolved: `https://registry.npmjs.org/left-pad/-/left-pad-${left}.tgz`,
							integrity: leftIntegrity
						},
						'node_modules/right-pad': {
							version: '2.0.0',
							resolved: 'https://registry.npmjs.org/right-pad/-/right-pad-2.0.0.tgz',
							integrity: rightIntegrity
						}
					}
				},
				null,
				2
			) + '\n'
		);
	};
	project('1.3.0', integrity);
	const bridge = await startTorRegistryBridge({ socksHost: '127.0.0.1', socksPort });
	const env = {
		...torNpmEnv(process.env, bridge.port),
		npm_config_cafile: cert,
		npm_config_cache: join(work, 'cache'),
		npm_config_prefer_offline: 'false',
		npm_config_userconfig: join(work, 'npmrc-none'),
		npm_config_globalconfig: join(work, 'npmrc-none-g')
	};
	const npm = (args: readonly string[]): Promise<number> =>
		new Promise<number>((r) => {
			const c = spawn('npm', [...args], {
				cwd: proj,
				env,
				stdio: ['ignore', 'pipe', 'pipe']
			});
			let out = '';
			c.stdout.on('data', (d) => (out += d));
			c.stderr.on('data', (d) => (out += d));
			c.on('close', (n) => {
				if (n !== 0) console.log(out.split('\n').slice(-15).join('\n'));
				r(n ?? 1);
			});
		});
	const code = await npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
	check(
		isolated
			? 'real npm ci finished inside the loopback-only namespace'
			: 'real npm ci finished through the SOCKS chain (host network)',
		code === 0,
		`exit ${code}`
	);
	check('the package is installed', existsSync(join(proj, 'node_modules', 'left-pad', 'index.js')));
	check(
		'Tor was asked for the registry by NAME',
		asked.includes('registry.npmjs.org:443'),
		asked.join(', ')
	);
	check(
		'Tor was asked for nothing else',
		asked.every((a) => a === 'registry.npmjs.org:443'),
		asked.join(', ')
	);
	check(
		'the bridge was asked only for the registry',
		bridge.asked.every((a) => a === 'registry.npmjs.org:443'),
		bridge.asked.join(', ')
	);

	// 5. The update: the release changes left-pad only; the installed tree stays.
	project('1.3.1', nextIntegrity);
	const releaseLock = readFileSync(join(proj, 'package-lock.json'), 'utf8');
	// An empty download cache, as on a node whose last install came from the
	// offline bundle: whatever is not in node_modules must be fetched.
	rmSync(join(work, 'cache'), { recursive: true, force: true });
	served.length = 0;
	asked.length = 0;
	const upd = await npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save']);
	const version = (n: string): string => {
		try {
			return JSON.parse(readFileSync(join(proj, 'node_modules', n, 'package.json'), 'utf8'))
				.version;
		} catch {
			return '';
		}
	};
	check(
		isolated
			? 'real npm install (the update) finished inside the loopback-only namespace'
			: 'real npm install (the update) finished through the SOCKS chain (host network)',
		upd === 0,
		`exit ${upd}`
	);
	check(
		'the update fetched ONLY the changed package',
		served.length === 1 && served[0] === '/left-pad/-/left-pad-1.3.1.tgz',
		served.join(', ')
	);
	check(
		'the changed package is updated and the unchanged one kept',
		version('left-pad') === '1.3.1' && version('right-pad') === '2.0.0',
		`left-pad ${version('left-pad')}, right-pad ${version('right-pad')}`
	);
	check(
		"the release's lockfile is left byte for byte as shipped",
		readFileSync(join(proj, 'package-lock.json'), 'utf8') === releaseLock
	);
	check(
		'during the update, Tor was asked for the registry by name and nothing else',
		asked.length > 0 && asked.every((a) => a === 'registry.npmjs.org:443'),
		asked.join(', ')
	);

	await bridge.close();
	registry.close();
	socks.close();
} finally {
	rmSync(work, { recursive: true, force: true });
}

console.log(
	fail === 0
		? `✓ all ${pass} hidden-npm-tor-route checks hold`
		: `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
