/**
 * kubo-no-phone-home-smoke.
 *
 * Kubo, as Morphit configures it, contacts no third party at runtime. Its
 * defaults do: AutoConf fetches conf.ipfs-mainnet.org at every start, routing
 * asks cid.contact / delegated-ipfs.dev over HTTP, IPNS records go to
 * delegated-ipfs.dev, DNS.Resolvers "auto" adds DoH resolvers, telemetry POSTs
 * to telemetry.ipshipyard.dev, and AutoTLS registers with libp2p.direct. A
 * clearnet node still has to seed the release on the public IPFS network, so
 * it keeps the DHT, with the bootstrap list written out instead of "auto".
 *
 * Always: the REAL ops/ipfs/morphit-ipfs-privacy.sh (MORPHIT_IPFS_PRIVACY_SCRIPT
 * overrides) applied to a fake `ipfs` that keeps Kubo 0.42's default values
 * for every key involved (read from a real `ipfs init --profile lowpower`):
 * after apply-base / apply-hidden no "auto" placeholder is left, AutoConf is
 * off and there is no HTTP router or IPNS publisher; and the Ansible role sets
 * the same Routing.Type as the script (no flapping).
 *
 * Live, with MORPHIT_TEST_KUBO (a Kubo 0.42 binary), as root with ip, nft and
 * unshare: a real repo gets the settings through the same script; then
 *  - the config holds no "auto" placeholder and the daemon starts;
 *  - control: with Kubo's defaults (only telemetry and AutoTLS off, as before
 *    this change) the daemon DOES look up conf.ipfs-mainnet.org and cid.contact
 *    (kubo-egress/run.sh sees attempts);
 *  - clearnet settings: no lookup of, or connection to, anything but the IPFS
 *    bootstrap peers (and a DNSLink name the probe itself asks for);
 *  - seeding: in a three-node network (kubo-egress/seed.sh) the node with
 *    these settings provides a file over the DHT, and another node finds it
 *    there and fetches it;
 *  - hidden-only settings: no attempt at all.
 * Without those it says so and skips the live part.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';

const SCRIPT =
	process.env.MORPHIT_IPFS_PRIVACY_SCRIPT ?? join(REPO, 'ops/ipfs/morphit-ipfs-privacy.sh');
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

// Kubo 0.42.0's values after `ipfs init --profile lowpower` for the keys a
// phone-home depends on.
const KUBO_DEFAULTS: Record<string, string> = {
	'Plugins.Plugins.telemetry.Config.Mode': '"auto"',
	'AutoTLS.Enabled': 'null',
	'AutoConf.Enabled': 'null',
	Bootstrap: '["auto"]',
	'DNS.Resolvers': '{".":"auto"}',
	'Routing.Type': '"autoclient"',
	'Routing.DelegatedRouters': '["auto"]',
	'Ipns.DelegatedPublishers': '["auto"]'
};
const work = mkdtempSync(join(tmpdir(), 'kubo-nph-'));
const fakeRun = (mode: string): Map<string, unknown> => {
	const dir = join(work, mode);
	const bin = join(dir, 'bin');
	mkdirSync(bin, { recursive: true });
	const cfg = join(dir, 'config.tsv');
	writeFileSync(
		cfg,
		Object.entries(KUBO_DEFAULTS)
			.map(([k, v]) => `${k}\t${v}\n`)
			.join('')
	);
	writeFileSync(
		join(bin, 'ipfs'),
		`#!/bin/sh
F=${cfg}
[ "$1" = config ] || exit 1
if [ "$2" = --json ]; then
  grep -v "^$3	" "$F" > "$F.n"; printf '%s\\t%s\\n' "$3" "$4" >> "$F.n"; mv "$F.n" "$F"; exit 0
fi
v=$(awk -F'\\t' -v k="$2" '$1==k {print $2}' "$F"); [ -n "$v" ] || exit 1; printf '%s\\n' "$v"
`
	);
	chmodSync(join(bin, 'ipfs'), 0o755);
	spawnSync('sh', [SCRIPT, `apply-${mode}`], {
		encoding: 'utf8',
		env: { PATH: `${bin}:/usr/bin:/bin`, IPFS_PATH: dir }
	});
	const out = new Map<string, unknown>();
	for (const line of readFileSync(cfg, 'utf8').split('\n').filter(Boolean)) {
		const [k, v] = line.split('\t');
		try {
			out.set(k!, JSON.parse(v!));
		} catch {
			out.set(k!, `(not JSON) ${v}`);
		}
	}
	return out;
};
/** Every string inside a value. */
const strings = (v: unknown): string[] =>
	typeof v === 'string'
		? [v]
		: Array.isArray(v)
			? v.flatMap(strings)
			: v && typeof v === 'object'
				? Object.values(v).flatMap(strings)
				: [];
const PLACEHOLDER_KEYS = [
	'Bootstrap',
	'DNS.Resolvers',
	'Routing.DelegatedRouters',
	'Ipns.DelegatedPublishers'
];
for (const mode of ['base', 'hidden'] as const) {
	const c = fakeRun(mode);
	const label = mode === 'base' ? 'clearnet' : 'hidden-only';
	check(
		`${label}: no "auto" placeholder left (${PLACEHOLDER_KEYS.join(', ')})`,
		PLACEHOLDER_KEYS.every((k) => !strings(c.get(k)).includes('auto')),
		PLACEHOLDER_KEYS.map((k) => `${k}=${JSON.stringify(c.get(k))}`).join(' ')
	);
	check(`${label}: AutoConf off (no conf.ipfs-mainnet.org)`, c.get('AutoConf.Enabled') === false);
	check(
		`${label}: no HTTP router and no IPNS publisher (no cid.contact, no delegated-ipfs.dev)`,
		JSON.stringify(c.get('Routing.DelegatedRouters')) === '[]' &&
			JSON.stringify(c.get('Ipns.DelegatedPublishers')) === '[]'
	);
	check(
		`${label}: telemetry and AutoTLS off`,
		c.get('Plugins.Plugins.telemetry.Config.Mode') === 'off' && c.get('AutoTLS.Enabled') === false
	);
	if (mode === 'base') {
		const boot = c.get('Bootstrap');
		check(
			'clearnet: the DHT, joined through the IPFS bootstrap peers written out',
			c.get('Routing.Type') === 'dht' &&
				Array.isArray(boot) &&
				boot.length > 0 &&
				boot.every(
					(a) => typeof a === 'string' && /^\/(dnsaddr|ip4|ip6)\/[^/]+(\/[^/]+)*\/p2p\/\w+$/.test(a)
				),
			`${JSON.stringify(c.get('Routing.Type'))} ${JSON.stringify(boot)}`
		);
		check(
			"clearnet: DNS through this server's own resolver (no DoH resolvers)",
			JSON.stringify(c.get('DNS.Resolvers')) === '{}'
		);
	} else check('hidden-only: no routing at all', c.get('Routing.Type') === 'none');
}
// The role's Routing.Type item, rendered as Ansible would on a clearnet node.
const roleRouting = spawnSync(
	'python3',
	[
		'-c',
		String.raw`import sys, yaml, jinja2
tasks = yaml.safe_load(open(sys.argv[1]))
def tb(v): return v if isinstance(v, bool) else str(v).strip().lower() in ('1','yes','true','on')
env = jinja2.Environment(undefined=jinja2.ChainableUndefined)
env.filters.update({'bool': tb, 'default': lambda v, d=None: d if v is None or isinstance(v, jinja2.Undefined) else v, 'ternary': lambda c, a, b=None: a if c else b})
for t in tasks:
    for it in (t.get('loop') or []):
        if isinstance(it, dict) and it.get('key') == 'Routing.Type':
            print(env.from_string(str(it['value'])).render(morphit_tor_only=False))`,
		join(REPO, 'ops/ansible/roles/ipfs/tasks/main.yml')
	],
	{ encoding: 'utf8' }
).stdout.trim();
check(
	'the Ansible role sets the same Routing.Type as the script on a clearnet node (no flapping)',
	roleRouting === `'"dht"'`,
	roleRouting
);

// ── live: a real Kubo, every attempt recorded ────────────────────────────
const BIN = process.env.MORPHIT_TEST_KUBO ?? '';
const has = (b: string): boolean => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
const live =
	BIN !== '' && existsSync(BIN) && process.getuid?.() === 0 && ['ip', 'nft', 'unshare'].every(has);
if (!live) check('skipped the live part: needs root, ip, nft, unshare and MORPHIT_TEST_KUBO', true);
else {
	const H = join(REPO, 'apps/ops-cli/scripts/kubo-egress');
	const noProxy = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k))
	) as NodeJS.ProcessEnv;
	const kubo = (repo: string, ...args: string[]) =>
		spawnSync(BIN, args, { encoding: 'utf8', env: { ...noProxy, IPFS_PATH: repo } });
	const binDir = join(work, 'kbin');
	mkdirSync(binDir);
	cpSync(BIN, join(binDir, 'ipfs'));
	const privacy = (repo: string, mode: string) =>
		spawnSync('sh', [SCRIPT, mode], {
			encoding: 'utf8',
			env: { ...noProxy, IPFS_PATH: repo, PATH: `${binDir}:/usr/bin:/bin` }
		});
	/** A repo as Morphit's installers make it, then `privacy` applied. */
	const makeRepo = (name: string, mode: 'base' | 'hidden' | 'control'): string => {
		const repo = join(work, name);
		kubo(repo, 'init', '--profile', 'lowpower');
		kubo(repo, 'config', 'Addresses.API', '/ip4/127.0.0.1/tcp/5001');
		kubo(repo, 'config', 'Addresses.Gateway', '/ip4/127.0.0.1/tcp/8082');
		kubo(repo, 'config', '--json', 'Gateway.NoFetch', 'true');
		if (mode === 'control') {
			// Before this change: only telemetry and AutoTLS were turned off.
			kubo(repo, 'config', '--json', 'Plugins.Plugins.telemetry.Config.Mode', '"off"');
			kubo(repo, 'config', '--json', 'AutoTLS.Enabled', 'false');
			kubo(repo, 'config', 'Routing.Type', 'auto');
		} else privacy(repo, `apply-${mode}`);
		return repo;
	};
	const observe = (repo: string, name: string) => {
		const out = join(work, `out-${name}`);
		spawnSync('bash', [join(H, 'run.sh'), BIN, repo, out, '20', join(H, 'act.sh')], {
			stdio: 'ignore',
			timeout: 300_000
		});
		const dns = existsSync(join(out, 'dns.log'))
			? [
					...new Set(
						readFileSync(join(out, 'dns.log'), 'utf8')
							.split('\n')
							.filter(Boolean)
							.map((l) => l.split(' ')[0]!)
					)
				]
			: [];
		let sink: string[] = [];
		try {
			const j = JSON.parse(readFileSync(join(out, 'sink.json'), 'utf8')) as {
				nftables: Array<{ set?: { elem?: Array<{ concat: unknown[] }> } }>;
			};
			sink = j.nftables.flatMap((x) => x.set?.elem ?? []).map((e) => e.concat.join(' '));
		} catch {
			sink = ['(no record)'];
		}
		const daemon = existsSync(join(out, 'daemon.log'))
			? readFileSync(join(out, 'daemon.log'), 'utf8')
			: '';
		return { dns, sink, daemon };
	};
	const THIRD =
		/(^|\.)(ipfs-mainnet\.org|cid\.contact|delegated-ipfs\.dev|ipshipyard\.dev|libp2p\.direct|eth\.limo|eth\.link)$/;

	const control = observe(makeRepo('control', 'control'), 'control');
	check(
		"control — Kubo's defaults look up conf.ipfs-mainnet.org and cid.contact (the harness sees attempts)",
		control.dns.includes('conf.ipfs-mainnet.org') && control.dns.includes('cid.contact'),
		control.dns.join(' ')
	);

	const base = makeRepo('base', 'base');
	const shown = kubo(base, 'config', 'show').stdout;
	let placeholders: string[] = [];
	try {
		const c = JSON.parse(shown) as Record<string, unknown>;
		placeholders = [
			strings(c.Bootstrap),
			strings((c.DNS as { Resolvers?: unknown })?.Resolvers),
			strings((c.Routing as { DelegatedRouters?: unknown })?.DelegatedRouters),
			strings((c.Ipns as { DelegatedPublishers?: unknown })?.DelegatedPublishers)
		]
			.flat()
			.filter((s) => s === 'auto');
	} catch {
		placeholders = ['(config show failed)'];
	}
	check(
		'clearnet, real Kubo: `ipfs config show` has no "auto" placeholder',
		placeholders.length === 0,
		placeholders.join(' ')
	);
	const b = observe(base, 'base');
	check(
		'clearnet, real Kubo: the daemon starts with AutoConf off (no AutoConf error)',
		/Daemon is ready/.test(b.daemon) &&
			!/autoconf/i.test(
				b.daemon
					.split('\n')
					.filter((l) => /ERROR/.test(l))
					.join('\n')
			)
	);
	const BOOT_DNS = new Set([
		'_dnsaddr.bootstrap.libp2p.io',
		'_dnsaddr.va1.bootstrap.libp2p.io',
		'_dnslink.en.wikipedia-on-ipfs.org'
	]);
	check(
		"clearnet, real Kubo: no third-party name looked up (only the bootstrap peers, and the probe's own DNSLink name)",
		b.dns.every((n) => BOOT_DNS.has(n)) && !b.dns.some((n) => THIRD.test(n)),
		b.dns.join(' ')
	);
	const OK_DST =
		/^(10\.201\.0\.1 udp 53|104\.131\.131\.82 (tcp|udp) 4001|224\.0\.0\.251 udp 5353|239\.255\.255\.250 udp 1900)$/;
	check(
		'clearnet, real Kubo: connections only to the bootstrap peer (plus LAN discovery and DNS)',
		b.sink.every((d) => OK_DST.test(d)),
		b.sink.join(', ')
	);

	const seedOut = join(work, 'seed');
	spawnSync('bash', [join(H, 'seed.sh'), BIN, base, SCRIPT, seedOut], {
		stdio: 'ignore',
		timeout: 400_000
	});
	const res = existsSync(join(seedOut, 'result.txt'))
		? readFileSync(join(seedOut, 'result.txt'), 'utf8')
		: '';
	const a = /^a=(\S+)/m.exec(res)?.[1] ?? '?';
	check(
		'seeding: the node with these settings provides the file over the DHT',
		/^provide_rc=0$/m.test(res),
		res.split('\n').slice(0, 4).join(' | ')
	);
	check(
		'seeding: another node finds it on the DHT and fetches it',
		new RegExp(`^findprovs=.*${a}`, 'm').test(res) && /^cat=morphit seeding proof/m.test(res),
		res.split('\n').slice(3, 6).join(' | ')
	);

	const h = observe(makeRepo('hidden', 'hidden'), 'hidden');
	check(
		'hidden-only, real Kubo: no name looked up and nothing sent',
		h.dns.length === 0 && h.sink.length === 0,
		`${h.dns.join(' ')} ${h.sink.join(', ')}`
	);
}
rmSync(work, { recursive: true, force: true });
console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} kubo-no-phone-home checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} kubo-no-phone-home checks failed`);
process.exit(1);
