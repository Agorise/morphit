#!/usr/bin/env tsx
/**
 * scripts/ipfs-hidden-only-execution-smoke.ts
 *
 * A tor-only node ran a stock Kubo and its IPFS scripts talked to clearnet:
 *   - morphit-ipfs-seed.sh curled git.agorise.net for the tag's CID whenever it
 *     was not given one (and `morphit-ops upgrade` never gave one), downloaded
 *     the release from there when it had no local copy, and announced this box
 *     as a provider on the public DHT;
 *   - morphit-ipns-rebroadcast.sh wrote the IPNS record to the public DHT;
 *   - the Ansible ipfs role left Kubo on the public network (DHT, bootstrap,
 *     swarm on every interface, UPnP, mDNS).
 *
 * This EXECUTES the real scripts (and, when ansible-playbook is installed, the
 * real role tasks) against stub `ipfs` and `curl` binaries on PATH in a temp
 * dir, records every invocation, and asserts: on a hidden-only node no curl
 * reaches anything but loopback or a hidden address through its proxy, and no
 * DHT write happens; on a clearnet node the old behaviour is intact (which also
 * proves the recorders can see a clearnet call).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const SEED = join(ROOT, 'ops', 'ipfs', 'morphit-ipfs-seed.sh');
const REBROADCAST = join(ROOT, 'ops', 'ipfs', 'morphit-ipns-rebroadcast.sh');
const PRIVACY = join(ROOT, 'ops', 'ipfs', 'morphit-ipfs-privacy.sh');
const ROLE_TASKS = join(ROOT, 'ops', 'ansible', 'roles', 'ipfs', 'tasks', 'main.yml');
const ROLE_DEFAULTS = join(ROOT, 'ops', 'ansible', 'roles', 'ipfs', 'defaults', 'main.yml');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
};

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const ONION = `${'a'.repeat(56)}.onion`;

// Stub Kubo: config get/set against a JSON file (like the real repo), `add`
// prints $STUB_CID, everything is logged one JSON array per line.
const STUB_IPFS = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
fs.appendFileSync(process.env.STUB_LOG_IPFS, JSON.stringify(process.argv.slice(2)) + '\\n');
const cfgPath = path.join(process.env.IPFS_PATH, 'config');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--timeout'));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (args[0] === 'config' && args[1] === '--json') {
  const keys = args[2].split('.'); let o = cfg;
  for (const k of keys.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = JSON.parse(args[3]);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); process.exit(0);
}
if (args[0] === 'config') {
  let o = cfg;
  for (const k of args[1].split('.')) { if (o === null || typeof o !== 'object' || !(k in o)) process.exit(1); o = o[k]; }
  console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2)); process.exit(0);
}
if (args[0] === 'add') { console.log(process.env.STUB_CID); process.exit(0); }
process.exit(0);
`;

// Stub curl: logs its argv; answers the local /v1/release when told to; every
// other request fails like an unreachable host.
const STUB_CURL = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG_CURL, JSON.stringify(argv) + '\\n');
const url = argv.find((a) => /^https?:\\/\\//.test(a)) || '';
if (process.env.STUB_RELEASE_JSON && /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/v1\\/release$/.test(url)) {
  process.stdout.write(process.env.STUB_RELEASE_JSON); process.exit(0);
}
process.exit(7);
`;

const STOCK_KUBO = {
	Addresses: {
		Swarm: ['/ip4/0.0.0.0/tcp/4001'],
		Gateway: '/ip4/127.0.0.1/tcp/8082',
		API: '/ip4/127.0.0.1/tcp/5001'
	},
	Bootstrap: ['auto'],
	Routing: { Type: 'auto' },
	Gateway: { NoFetch: true }
};

interface Run {
	status: number;
	out: string;
	curl: string[][];
	ipfs: string[][];
}

function sandbox(): { dir: string; bin: string; repo: string } {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-ipfs-hidden-'));
	const bin = join(dir, 'bin');
	const repo = join(dir, 'repo');
	mkdirSync(bin);
	mkdirSync(repo);
	writeFileSync(join(bin, 'ipfs'), STUB_IPFS);
	writeFileSync(join(bin, 'curl'), STUB_CURL);
	chmodSync(join(bin, 'ipfs'), 0o755);
	chmodSync(join(bin, 'curl'), 0o755);
	writeFileSync(join(repo, 'config'), JSON.stringify(STOCK_KUBO, null, 2));
	return { dir, bin, repo };
}

function run(
	sb: { dir: string; bin: string; repo: string },
	script: string,
	args: string[],
	env: Record<string, string>
): Run {
	const logCurl = join(sb.dir, `curl-${Math.random()}.log`);
	const logIpfs = join(sb.dir, `ipfs-${Math.random()}.log`);
	writeFileSync(logCurl, '');
	writeFileSync(logIpfs, '');
	const r = spawnSync('sh', [script, ...args], {
		encoding: 'utf8',
		timeout: 120_000,
		env: {
			PATH: `${sb.bin}:${process.env.PATH}`,
			HOME: sb.dir,
			TMPDIR: sb.dir,
			IPFS_PATH: sb.repo,
			STUB_LOG_CURL: logCurl,
			STUB_LOG_IPFS: logIpfs,
			STUB_CID: CID,
			...env
		}
	});
	const lines = (p: string): string[][] =>
		readFileSync(p, 'utf8')
			.split('\n')
			.filter((l) => l !== '')
			.map((l) => JSON.parse(l) as string[]);
	return {
		status: r.status ?? -1,
		out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
		curl: lines(logCurl),
		ipfs: lines(logIpfs)
	};
}

/** Curl invocations that would leave the box in the clear: any URL that is not
 *  loopback, a hidden name through its local proxy, or a name pinned to
 *  loopback with --resolve. */
function clearnetCurls(calls: string[][]): string[] {
	const bad: string[] = [];
	for (const argv of calls) {
		for (const a of argv) {
			if (!/^https?:\/\//.test(a)) continue;
			const host = new URL(a).hostname;
			const viaTor = argv.includes('--socks5-hostname') && host.endsWith('.onion');
			const viaI2p = argv.includes('-x') && host.endsWith('.i2p');
			const pinned = argv.some((x) => x === `${host}:443:127.0.0.1`);
			if (host === '127.0.0.1' || viaTor || viaI2p || pinned) continue;
			bad.push(a);
		}
	}
	return bad;
}
const dhtWrites = (calls: string[][]): string[][] =>
	calls.filter((a) => a.includes('routing') && (a.includes('provide') || a.includes('put')));

// A tiny release tarball the stager can hash, copy and read notes from.
function tarball(dir: string): string {
	const src = join(dir, 'src');
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, 'RELEASE-NOTES-v9.9.9.md'), '# notes\n');
	const out = join(dir, 'morphit-v9.9.9.tar.gz');
	spawnSync('tar', ['-czf', out, '-C', src, '.']);
	return out;
}

console.log('\nipfs-hidden-only-execution-smoke\n' + '─'.repeat(56));

// ── morphit-ipfs-seed.sh ────────────────────────────────────────────
{
	const sb = sandbox();
	try {
		const tb = tarball(sb.dir);
		const seedEnv = { MORPHIT_SEED_ONION: ONION, MORPHIT_SEED_ORIGIN: `http://${ONION}` };

		// Hidden-only, told by the caller, no CID given (what upgrade used to do).
		let r = run(sb, SEED, ['v9.9.9'], {
			...seedEnv,
			MORPHIT_SEED_HIDDEN_ONLY: '1',
			MORPHIT_STAGE_TARBALL: tb
		});
		check(
			'seed, hidden-only (caller says so), no CID: seeds the local copy (exit 0, ipfs add ran)',
			r.status === 0 && r.ipfs.some((a) => a.includes('add')),
			r.out.slice(-400)
		);
		check(
			'seed, hidden-only: no curl leaves the box in the clear (no anchor fetch)',
			clearnetCurls(r.curl).length === 0,
			clearnetCurls(r.curl).join(' ')
		);
		check(
			'seed, hidden-only: nothing announced to the public DHT',
			dhtWrites(r.ipfs).length === 0,
			JSON.stringify(dhtWrites(r.ipfs))
		);
		check(
			'seed, hidden-only: still verifies the release over its .onion (through Tor)',
			r.curl.some((a) => a.includes('--socks5-hostname') && a.some((x) => x.includes(ONION)))
		);

		// Hidden-only inferred from Kubo's own config (a hand-run seed).
		writeFileSync(
			join(sb.repo, 'config'),
			JSON.stringify({ ...STOCK_KUBO, Routing: { Type: 'none' } }, null, 2)
		);
		r = run(sb, SEED, ['v9.9.9'], { ...seedEnv, MORPHIT_STAGE_TARBALL: tb });
		check(
			'seed, hidden-only (Kubo Routing.Type=none): no clearnet curl, no DHT write',
			r.status === 0 && clearnetCurls(r.curl).length === 0 && dhtWrites(r.ipfs).length === 0,
			`${clearnetCurls(r.curl).join(' ')} ${JSON.stringify(dhtWrites(r.ipfs))}`
		);

		// Hidden-only with no local copy: must not download it over clearnet.
		r = run(sb, SEED, ['v9.9.9'], { ...seedEnv, MORPHIT_SEED_HIDDEN_ONLY: '1' });
		check(
			'seed, hidden-only, no local tarball: refuses (non-zero) without any clearnet download',
			r.status !== 0 &&
				clearnetCurls(r.curl).length === 0 &&
				!r.ipfs.some((a) => a.includes('add')),
			`${r.status} ${clearnetCurls(r.curl).join(' ')}`
		);

		// The CID assertion still works when upgrade passes the on-chain CID.
		r = run(sb, SEED, ['v9.9.9', CID], {
			...seedEnv,
			MORPHIT_SEED_HIDDEN_ONLY: '1',
			MORPHIT_STAGE_TARBALL: tb
		});
		check('seed, hidden-only, matching on-chain CID: passes', r.status === 0);
		r = run(sb, SEED, ['v9.9.9', 'bafybeiwrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwr'], {
			...seedEnv,
			MORPHIT_SEED_HIDDEN_ONLY: '1',
			MORPHIT_STAGE_TARBALL: tb
		});
		check('seed, hidden-only, different on-chain CID: fails loud (exit 1)', r.status === 1);

		// Control: a clearnet node keeps its behaviour, and the recorders see it.
		writeFileSync(join(sb.repo, 'config'), JSON.stringify(STOCK_KUBO, null, 2));
		r = run(sb, SEED, ['v9.9.9'], { ...seedEnv, MORPHIT_STAGE_TARBALL: tb });
		check(
			'seed, clearnet node (control): still fetches the tag anchor and announces to the DHT',
			clearnetCurls(r.curl).some((u) => u.includes('distribution-anchor.env')) &&
				dhtWrites(r.ipfs).length === 1,
			r.out.slice(-300)
		);

		// Piped into `morphit-ops upgrade` (no terminal), the seed says its
		// results only: no step-by-step lines, no staged-file listing, no bare
		// CID line, no public-gateway hint. A verbose run still shows them.
		const steps = [
			/staging v9\.9\.9/,
			/ipfs add \(timeout/,
			/stage-release-dir: staged/,
			/^\s+morphit-v9\.9\.9\.tar\.gz$/m,
			/announcing to the network/,
			/Resolve: https:\/\/ipfs\.io/,
			new RegExp(`^${CID}$`, 'm')
		];
		const piped = run(sb, SEED, ['v9.9.9', CID], { ...seedEnv, MORPHIT_STAGE_TARBALL: tb });
		check(
			'seed, piped (an upgrade): only results — no step lines, file listing, bare CID or gateway hint',
			piped.status === 0 && steps.every((re) => !re.test(piped.out)),
			steps
				.filter((re) => re.test(piped.out))
				.map(String)
				.join(' ')
		);
		check(
			'seed, piped: still says the CID matches the anchored one',
			/✓ CID matches the anchored ipfs_cid/.test(piped.out),
			piped.out.slice(-300)
		);
		const verbose = run(sb, SEED, ['v9.9.9', CID], {
			...seedEnv,
			MORPHIT_STAGE_TARBALL: tb,
			MORPHIT_SEED_VERBOSE: '1'
		});
		check(
			'seed, verbose (a hand run): shows every step and the staged files',
			verbose.status === 0 &&
				[steps[0]!, steps[1]!, steps[2]!, steps[3]!].every((re) => re.test(verbose.out)),
			verbose.out.slice(-400)
		);
	} finally {
		rmSync(sb.dir, { recursive: true, force: true });
	}
}

// ── morphit-ipns-rebroadcast.sh ─────────────────────────────────────
{
	const sb = sandbox();
	try {
		const release = JSON.stringify({
			version: '9.9.9',
			distribution: {
				ipns_name: 'k51qzi5uqu5dexample',
				ipns_record: Buffer.from('signed-record').toString('base64')
			}
		});
		const env = {
			STUB_RELEASE_JSON: release,
			MORPHIT_RELEASE_URL: 'http://127.0.0.1:8081/v1/release'
		};
		let r = run(sb, REBROADCAST, [], { ...env, MORPHIT_IPFS_HIDDEN_ONLY: 'yes' });
		check(
			'rebroadcast, hidden-only (ipfs-pin.env says so): no DHT put, exits 0',
			r.status === 0 && dhtWrites(r.ipfs).length === 0,
			JSON.stringify(dhtWrites(r.ipfs))
		);
		writeFileSync(
			join(sb.repo, 'config'),
			JSON.stringify({ ...STOCK_KUBO, Routing: { Type: 'none' } }, null, 2)
		);
		r = run(sb, REBROADCAST, [], env);
		check(
			'rebroadcast, hidden-only (Kubo Routing.Type=none, healed node): no DHT put',
			r.status === 0 && dhtWrites(r.ipfs).length === 0,
			JSON.stringify(dhtWrites(r.ipfs))
		);
		writeFileSync(join(sb.repo, 'config'), JSON.stringify(STOCK_KUBO, null, 2));
		r = run(sb, REBROADCAST, [], env);
		check(
			'rebroadcast, clearnet node (control): puts the record to the DHT',
			dhtWrites(r.ipfs).length === 1,
			r.out.slice(-300)
		);
	} finally {
		rmSync(sb.dir, { recursive: true, force: true });
	}
}

// ── morphit-ipfs-privacy.sh ─────────────────────────────────────────
{
	const sb = sandbox();
	try {
		let r = run(sb, PRIVACY, ['check-hidden'], {});
		check(
			'privacy: a stock Kubo is reported as not private (check-hidden exits 1)',
			r.status === 1
		);
		r = run(sb, PRIVACY, ['apply-hidden'], {});
		const c = JSON.parse(readFileSync(join(sb.repo, 'config'), 'utf8'));
		check(
			'privacy: apply-hidden leaves the public network (Routing none, no bootstrap, no swarm, no UPnP, no mDNS, no AutoConf)',
			r.status === 0 &&
				c.Routing.Type === 'none' &&
				c.Bootstrap.length === 0 &&
				c.Addresses.Swarm.length === 0 &&
				c.Swarm.DisableNatPortMap === true &&
				c.Discovery.MDNS.Enabled === false &&
				c.AutoConf.Enabled === false &&
				c.Addresses.Gateway === STOCK_KUBO.Addresses.Gateway,
			JSON.stringify(c)
		);
		r = run(sb, PRIVACY, ['check-hidden'], {});
		check('privacy: after apply, check-hidden exits 0 (idempotent)', r.status === 0);
	} finally {
		rmSync(sb.dir, { recursive: true, force: true });
	}
}

// ── the Ansible ipfs role's config tasks, executed ──────────────────
{
	const ansible = spawnSync('sh', ['-c', 'command -v ansible-playbook'], {
		encoding: 'utf8'
	}).stdout.trim();
	if (ansible === '') {
		check('ansible role tasks (skipped: ansible-playbook not installed here)', true);
	} else {
		const tasks = parseYaml(readFileSync(ROLE_TASKS, 'utf8')) as Array<Record<string, unknown>>;
		const wanted = tasks.filter((t) => {
			const n = String(t.name ?? '');
			return (
				n.startsWith('Keep the node small') ||
				n === "Check Kubo's privacy settings" ||
				n === "Apply Kubo's privacy settings"
			);
		});
		check('ansible: found the three Kubo config tasks in the role', wanted.length === 3);
		for (const tor of [true, false]) {
			const sb = sandbox();
			try {
				// The role runs the INSTALLED copy of the script; point it at the repo's.
				const local = wanted.map((t) => {
					const c: Record<string, unknown> = { ...t };
					delete c.become;
					delete c.become_user;
					delete c.notify;
					// `command` or `shell` (v1.20.0, C12: "Keep the node small" is a
					// check-then-set shell script so its notify can fire), with the
					// script as `cmd:` or as the module's bare value.
					const mod = ['ansible.builtin.command', 'ansible.builtin.shell'].find((m) => m in c);
					if (mod === undefined)
						throw new Error(`task "${String(t.name)}" is neither command nor shell`);
					const v = c[mod] as string | { cmd: string };
					const swap = (s: string): string =>
						s.replace('/usr/local/lib/morphit/morphit-ipfs-privacy.sh', PRIVACY);
					c[mod] = typeof v === 'string' ? swap(v) : { ...v, cmd: swap(v.cmd) };
					return c;
				});
				const book = [
					{
						hosts: 'localhost',
						connection: 'local',
						gather_facts: false,
						vars_files: [ROLE_DEFAULTS],
						tasks: local
					}
				];
				writeFileSync(join(sb.dir, 'book.yml'), JSON.stringify(book));
				// Extra vars: the role's defaults file (vars_files) would outrank play vars.
				const extra = JSON.stringify({ morphit_tor_only: tor, morphit_ipfs_repo: sb.repo });
				const r = spawnSync(ansible, ['-i', 'localhost,', '-e', extra, join(sb.dir, 'book.yml')], {
					encoding: 'utf8',
					timeout: 180_000,
					env: {
						...process.env,
						PATH: `${sb.bin}:${process.env.PATH}`,
						STUB_LOG_IPFS: join(sb.dir, 'ipfs.log'),
						STUB_LOG_CURL: join(sb.dir, 'curl.log'),
						ANSIBLE_LOCALHOST_WARNING: 'False',
						ANSIBLE_INVENTORY_UNPARSED_WARNING: 'False'
					}
				});
				const c = JSON.parse(readFileSync(join(sb.repo, 'config'), 'utf8'));
				if (tor) {
					check(
						'ansible, tor-only: Kubo ends up off the public network (Routing none, no bootstrap/swarm/UPnP/mDNS, telemetry off)',
						r.status === 0 &&
							c.Routing.Type === 'none' &&
							c.Bootstrap.length === 0 &&
							c.Addresses.Swarm.length === 0 &&
							c.Swarm.DisableNatPortMap === true &&
							c.Discovery.MDNS.Enabled === false &&
							c.Plugins?.Plugins?.telemetry?.Config?.Mode === 'off',
						`${r.status} ${(r.stdout ?? '').slice(-600)} ${JSON.stringify(c)}`
					);
				} else {
					// Round 2, item 6: no AutoConf fetch, no HTTP routers (cid.contact);
					// it seeds over the public DHT with the bootstrap list written out
					// (behaviour: apps/ops-cli:kubo-no-phone-home-smoke, a real Kubo).
					check(
						'ansible, clearnet node: DHT only (no AutoConf, no HTTP routers), bootstrap peers written out, telemetry off',
						r.status === 0 &&
							c.Routing.Type === 'dht' &&
							JSON.stringify(c.Routing.DelegatedRouters) === '[]' &&
							c.AutoConf?.Enabled === false &&
							Array.isArray(c.Bootstrap) &&
							c.Bootstrap.length > 0 &&
							!c.Bootstrap.includes('auto') &&
							c.Plugins?.Plugins?.telemetry?.Config?.Mode === 'off',
						`${r.status} ${(r.stdout ?? '').slice(-600)} ${JSON.stringify(c)}`
					);
				}
			} finally {
				rmSync(sb.dir, { recursive: true, force: true });
			}
		}
	}
}

console.log('─'.repeat(56));
if (fail > 0) {
	console.log(`✗ ${fail} of ${pass + fail} ipfs hidden-only execution checks failed`);
	process.exit(1);
}
console.log(`✓ all ${pass} ipfs hidden-only execution checks passed`);
