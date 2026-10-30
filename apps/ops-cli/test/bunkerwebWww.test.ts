/**
 * www.<domain> on a BunkerWeb instance (v1.21.11): which domains get a www,
 * the settings-file change, the DNS verdict (against a real DNS server on
 * 127.0.0.1), and the heal's decisions on a simulated box: BunkerWeb that runs
 * the settings it last loaded, a certificate, certbot that Let's Encrypt only
 * lets add www when www really reaches the web build. The run against real
 * certbot 2.9.0, Pebble, nginx and docker compose is recorded in the audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	certbotArgs,
	certNameOf,
	dnsLookup,
	healBunkerWebWww,
	planWwwEnv,
	serverNames,
	upstreamResolvers,
	webrootFor,
	applyWaitMs,
	WWW_REDIRECT_KEY,
	wwwAliasFor,
	wwwDnsVerdict,
	wwwRedirectConf,
	type ApplyResult,
	type Lookup,
	type WwwRuntime
} from '../src/lib/bunkerwebWww.ts';
import { envValues } from '../src/lib/bunkerwebPrivacy.ts';
import { startMiniDns } from './helpers/miniDns.ts';

const D = 'vigilante.trading';
const W = 'www.vigilante.trading';
const ENV = '/etc/bunkerweb/bunkerweb.env';
const BUILD = '/opt/morphit/apps/web/build';
const RENEWAL = `/etc/letsencrypt/renewal/${D}.conf`;
const OLD_ENV = `# Managed by Ansible
SERVER_NAME=${D}
SERVER_TYPE=http
MULTISITE=no
AUTO_LETS_ENCRYPT=no
USE_CUSTOM_SSL=yes
CUSTOM_SSL_CERT=/etc/letsencrypt/live/${D}/fullchain.pem
CUSTOM_SSL_KEY=/etc/letsencrypt/live/${D}/privkey.pem
AUTO_REDIRECT_HTTP_TO_HTTPS=yes
LOG_FORMAT='$host [$time_local] "$request_method $uri" $status $body_bytes_sent'
CUSTOM_HEADER=Onion-Location: http://abc.onion
`;
const PROD = 'https://acme-v02.api.letsencrypt.org/directory';
const conf = (server = PROD) => `version = 2.9.0
archive_dir = /etc/letsencrypt/archive/${D}
cert = /etc/letsencrypt/live/${D}/cert.pem

[renewalparams]
account = 0123abcd
authenticator = webroot
webroot_path = ${BUILD},
server = ${server}
key_type = ecdsa
[[webroot_map]]
${D} = ${BUILD}
`;

const lk = (...addrs: string[]): Lookup => ({ addrs, sure: true });

class Box {
	files = new Map<string, string>([
		[ENV, OLD_ENV],
		[RENEWAL, conf()]
	]);
	dns: Record<string, Lookup> = { [D]: lk('203.0.113.10'), [W]: lk('203.0.113.10') };
	/** The settings file the running edge container was created with. */
	live = OLD_ENV;
	/** The running edge's settings cannot be read. */
	liveUnknown = false;
	cert = [D];
	served = [D];
	hidden = false;
	envPath: string | null = ENV;
	envNote: string | null = null;
	composeOk = true;
	applyResult: ApplyResult = 'loaded';
	/** Nothing can be restarted at all. */
	restartable = true;
	/** BunkerWeb was started by Docker Compose (it can be recreated). */
	canRecreate = true;
	/** A recreate reads the settings file (false: Compose recreated the
	 *  containers from another file). */
	recreateReadsFile = true;
	/** BunkerWeb ignores CUSTOM_CONF_* from its environment. */
	ignoreEnvRule = false;
	schedConf = false;
	schedConfWorks = true;
	/** No answer at all on this machine (curl 7). */
	noAnswer = false;
	/** The site's answer once BunkerWeb has loaded the new settings (null: 200). */
	siteAfter: string | null = null;
	/** The site's answer while BunkerWeb is still loading (null: 200). */
	siteWhilePending: string | null = null;
	pendingSeen = false;
	/** BunkerWeb keeps serving the old certificate through this many reloads. */
	stickyCert = 0;
	hasCertbot = true;
	certbotOut: string | null = null;
	servesChallenge = true;
	backupOk = true;
	timeLeft = 30 * 60_000;
	background = true;
	source: {
		readsFile: boolean;
		overrides: string[];
		values?: ReadonlyMap<string, string>;
	} | null = { readsFile: true, overrides: [] };
	applies: string[] = [];
	certbotCalls: string[][] = [];
	perms = 0;
	lookups: string[] = [];
	writes: string[] = [];
	modes: Record<string, number | undefined> = {};
	loadedOnce = false;
	/** BunkerWeb 1.5 (single site): nginx serves the names of its site list,
	 *  and its scheduler only ever puts the first name of SERVER_NAME there. */
	bw15 = false;
	sites: string[] = [D];
	siteDb: 'sqlite' | 'other' | 'missing' = 'sqlite';
	/** Adding to the site list changes nothing nginx serves (another cause). */
	sitesIgnored = false;
	added: string[][] = [];
	/** `nginx -T` can be read in the edge. */
	nginxReadable = false;
	ruleCopiesRemoved = 0;
	refusal: string | null = null;

	/** The names the running nginx answers for. */
	servedNames(): string[] {
		if (!this.bw15) return serverNames(this.live);
		const live = serverNames(this.live);
		return this.sitesIgnored ? this.sites.slice(0, 1) : this.sites.filter((n) => live.includes(n));
	}
	nginxText(): string {
		const env =
			!this.ignoreEnvRule && envValues(this.live).get(WWW_REDIRECT_KEY) === wwwRedirectConf(D);
		return [
			'# configuration file /etc/nginx/api.conf:',
			'server {',
			'\tserver_name bwapi;',
			'}',
			'# configuration file /etc/nginx/server.conf:',
			'server {',
			`\tserver_name ${this.servedNames().join(' ')};`,
			'}',
			...(env
				? [
						'# configuration file /etc/bunkerweb/configs/server-http/morphit_www_redirect.conf:',
						'# CREATED BY ENV',
						wwwRedirectConf(D)
					]
				: []),
			...(this.schedConf
				? [
						'# configuration file /etc/bunkerweb/configs/server-http/morphit-www-redirect.conf:',
						wwwRedirectConf(D)
					]
				: []),
			''
		].join('\n');
	}

	ruleLive(): boolean {
		const v = envValues(this.live);
		const named = this.servedNames().includes(W);
		const env = !this.ignoreEnvRule && v.get(WWW_REDIRECT_KEY) === wwwRedirectConf(D);
		return named && (env || (this.schedConf && this.schedConfWorks));
	}
	readonly rt: WwwRuntime = {
		hiddenOnly: () => this.hidden,
		envFile: () => ({ path: this.envPath, note: this.envNote }),
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, t, mode) => {
			this.writes.push(p);
			this.modes[p] = mode;
			this.files.set(p, t);
			return true;
		},
		removeFile: (p) => void this.files.delete(p),
		backup: (p, t) => {
			if (!this.backupOk) return null;
			this.files.set(`${p}.bak-1`, t);
			return `${p}.bak-1`;
		},
		composeAccepts: () => this.composeOk,
		lookup: async (n) => (this.lookups.push(n), this.dns[n] ?? lk()),
		liveEnv: () => (this.liveUnknown ? null : envValues(this.live)),
		apply: (why, recreate) => {
			this.applies.push(`${why}|${recreate}`);
			if (applyWaitMs(this.timeLeft) === null) return 'no-time';
			if (!this.restartable || (recreate && !this.canRecreate)) return 'not-restarted';
			if (this.applyResult === 'pending') this.pendingSeen = true;
			if (this.applyResult !== 'loaded') return this.applyResult;
			if (this.refusal !== null) return 'refused';
			// A recreate reads the settings file; a scheduler restart only its
			// config files and the certificate.
			if (recreate && this.recreateReadsFile) this.live = this.files.get(ENV)!;
			this.loadedOnce = true;
			if (this.stickyCert > 0) this.stickyCert--;
			else this.served = [...this.cert];
			return 'loaded';
		},
		writeSchedulerConf: () => {
			if (this.schedConf) return 'unchanged';
			this.schedConf = true;
			return 'written';
		},
		request: (url, o = {}) => {
			const u = new URL(url);
			const path = `${u.pathname}${u.search}`;
			const res = (code: string, location = '', exit = 0) => ({
				code,
				location,
				headers: '',
				exit
			});
			if (this.noAnswer) return res('000', '', 7);
			const tlsOk = (name: string) => !o.verify || this.served.includes(name);
			if (u.hostname === D) {
				if (u.protocol === 'http:') return res('301', `https://${D}${path}`);
				if (!tlsOk(D)) return res('000', '', 60);
				if (this.pendingSeen && this.siteWhilePending !== null) return res(this.siteWhilePending);
				return res(this.loadedOnce && this.siteAfter !== null ? this.siteAfter : '200');
			}
			if (u.hostname === W) {
				if (!this.servedNames().includes(W))
					return u.protocol === 'https:' && o.verify ? res('000', '', 60) : res('403');
				if (u.protocol === 'https:' && !tlsOk(W)) return res('000', '', 60);
				if (this.ruleLive()) return res('301', `https://${D}${path}`);
				return u.protocol === 'http:' ? res('301', `https://${W}${path}`) : res('200');
			}
			return res('000', '', 6);
		},
		fetchFollow: (url) => {
			const u = new URL(url);
			if (u.hostname !== W || !this.ruleLive() || !this.servesChallenge) return null;
			return this.files.get(`${BUILD}${u.pathname}`) ?? null;
		},
		certNames: (n) => (n === D ? [...this.cert] : null),
		certbotPresent: () => this.hasCertbot,
		certbot: (args) => {
			this.certbotCalls.push([...args]);
			if (this.certbotOut !== null) return { ok: false, out: this.certbotOut };
			const names = args.flatMap((a, i) => (args[i - 1] === '-d' ? [a] : []));
			const reach = (n: string) =>
				n === D || (this.dns[W]?.addrs.length ?? 0) > 0
					? n !== W || (this.ruleLive() && this.servesChallenge)
					: false;
			if (!names.every(reach))
				return {
					ok: false,
					out: 'Challenge failed for domain www…: unauthorized, Invalid response'
				};
			this.cert = names;
			return { ok: true, out: 'Successfully received certificate.' };
		},
		certPermissions: () => void this.perms++,
		buildDir: () => BUILD,
		timeLeftMs: () => this.timeLeft,
		inBackground: () => this.background,
		composeManaged: () => this.canRecreate,
		edgeSettingsSource: () => this.source,
		nginxConfig: () => (this.nginxReadable ? this.nginxText() : null),
		// As WWW_DB_PY answers: the list only from a sqlite file it can read.
		siteList: () => ({ db: this.siteDb, ids: this.siteDb === 'sqlite' ? [...this.sites] : [] }),
		addSiteNames: (add, first) => {
			this.added.push([...add]);
			if (this.siteDb !== 'sqlite' || this.sites[0] !== first) return null;
			this.sites.push(...add);
			return { backup: '/data/lib/db.pre-morphit-sites-1.sqlite3' };
		},
		removeRuleCopy: () => {
			this.ruleCopiesRemoved++;
			this.schedConf = false;
			return true;
		},
		lastRefusal: () => this.refusal,
		containerNames: () => ({ edge: 'bunkerweb', scheduler: 'bunkerweb-scheduler' })
	};
}

const notes: string[] = [];
const ctx = {
	info: (m: string) => void notes.push(`info ${m}`),
	warn: (m: string) => void notes.push(`warn ${m}`),
	spinner: () => () => undefined
};

describe('which domains get a www', () => {
	it.each([
		['vigilante.trading', 'www.vigilante.trading'],
		['morphit.io', 'www.morphit.io'],
		['morphitir.com', 'www.morphitir.com'],
		['Vigilante.Trading.', 'www.vigilante.trading'],
		['example.com.mx', 'www.example.com.mx'],
		['example.co.uk', 'www.example.co.uk'],
		['xn--bcher-kva.example', null],
		['xn--bcher-kva.de', 'www.xn--bcher-kva.de']
	])('%s → %s', (d, want) => expect(wwwAliasFor(d)).toBe(want));
	it.each([
		'morphit.timeapp.foundation',
		'trade.example.org',
		'shop.example.com.mx',
		'example.com.foundation',
		'www.example.com',
		'www.co.uk',
		'www.io',
		'203.0.113.10',
		'abc.onion',
		'abc.b32.i2p',
		'node.loki',
		'localhost',
		'morphit',
		'a..b',
		'-a.com',
		'a-.com',
		'https://example.com',
		'example.com/x',
		''
	])('%s → no www', (d) => expect(wwwAliasFor(d)).toBeNull());
});

describe('time for the heal (the run that hosts it has a deadline)', () => {
	it('at most ten minutes per wait, never into the four-minute reserve; none under a minute', () => {
		expect(applyWaitMs(45 * 60_000)).toBe(10 * 60_000);
		expect(applyWaitMs(10 * 60_000)).toBe(6 * 60_000);
		expect(applyWaitMs(5 * 60_000)).toBe(60_000);
		expect(applyWaitMs(5 * 60_000 - 1)).toBeNull();
		expect(applyWaitMs(-5)).toBeNull();
		expect(applyWaitMs(45 * 60_000, 60_000)).toBe(60_000);
	});
});

describe('the settings-file change', () => {
	it('adds www after the domain and the single-quoted rule; nothing else', () => {
		const p = planWwwEnv(OLD_ENV, { domain: D, alias: W });
		const v = envValues(p.text);
		expect(v.get('SERVER_NAME')).toBe(`${D} ${W}`);
		expect(v.get(WWW_REDIRECT_KEY)).toBe(
			`if ($host = ${W}) { return 301 https://${D}$request_uri; }`
		);
		expect(p.text).toContain(`${WWW_REDIRECT_KEY}='if ($host = ${W})`);
		const added = p.text.split('\n').filter((l) => !OLD_ENV.split('\n').includes(l));
		expect(added).toEqual([`SERVER_NAME=${D} ${W}`, `${WWW_REDIRECT_KEY}='${wwwRedirectConf(D)}'`]);
		expect(planWwwEnv(p.text, { domain: D, alias: W }).changes).toEqual([]);
	});
	it('keeps other names an operator added; every SERVER_NAME line (Compose reads the last); export and CRLF kept', () => {
		const t = `export SERVER_NAME=${D} shop.${D}\r\nX=1\r\nSERVER_NAME="${D} shop.${D}"\r\n`;
		const p = planWwwEnv(t, { domain: D, alias: W });
		expect(p.text).toBe(
			`export SERVER_NAME=${D} shop.${D} ${W}\r\nX=1\r\nSERVER_NAME=${D} shop.${D} ${W}\r\n${WWW_REDIRECT_KEY}='${wwwRedirectConf(D)}'\n`
		);
	});
	it('writes ${SERVER_NAME} / $SERVER_NAME out where Compose would expand it, not in single quotes', () => {
		const t = `SERVER_NAME=${D}\nCUSTOM_SSL_CERT=/etc/letsencrypt/live/\${SERVER_NAME}/fullchain.pem\nCUSTOM_SSL_KEY="/etc/letsencrypt/live/$SERVER_NAME/privkey.pem"\nNOTE='$SERVER_NAME stays'\nOTHER=$SERVER_NAMES\n`;
		const v = envValues(planWwwEnv(t, { domain: D, alias: W }).text);
		expect(v.get('CUSTOM_SSL_CERT')).toBe(`/etc/letsencrypt/live/${D}/fullchain.pem`);
		expect(v.get('CUSTOM_SSL_KEY')).toBe(`/etc/letsencrypt/live/${D}/privkey.pem`);
		expect(v.get('NOTE')).toBe('$SERVER_NAME stays');
		expect(v.get('OTHER')).toBe('$SERVER_NAMES');
	});
	it('a double-quoted value running over lines keeps its meaning when ${SERVER_NAME} is written out', () => {
		const t = `SERVER_NAME=${D}\nCUSTOM_SSL_CERT="/etc/letsencrypt/live/\${SERVER_NAME}/fullchain.pem"\nNOTE="a\nb \${SERVER_NAME}"\nX=1\n`;
		const out = planWwwEnv(t, { domain: D, alias: W }).text;
		const v = envValues(out);
		expect(v.get('CUSTOM_SSL_CERT')).toBe(`/etc/letsencrypt/live/${D}/fullchain.pem`);
		expect(v.get('NOTE')).toBe(`a\nb ${D}`);
		expect(v.get('X')).toBe('1');
	});

	it('replaces a rule under Morphit’s key that is not the current one', () => {
		const t = `${OLD_ENV}${WWW_REDIRECT_KEY}=if ( = www.old) { return 301 https://old; }\n`;
		expect(envValues(planWwwEnv(t, { domain: D, alias: W }).text).get(WWW_REDIRECT_KEY)).toBe(
			wwwRedirectConf(D)
		);
	});
	it('no www: the file is left byte for byte', () => {
		expect(planWwwEnv(OLD_ENV, null)).toEqual({ text: OLD_ENV, changes: [] });
	});
	it('the operator’s per-certificate settings are carried into the certbot arguments (certonly rewrites the renewal file)', () => {
		const fixed = conf().replace(
			'key_type = ecdsa\n',
			`key_type = ecdsa
renew_hook = /usr/local/bin/copy-cert --to "mail"
preferred_chain = ISRG Root X1
reuse_key = True
must_staple = True
allow_subset_of_names = False
autorenew = False
pre_hook = docker stop bunkerweb
post_hook = docker start bunkerweb
`
		);
		const a = certbotArgs(D, [D, W], BUILD, fixed);
		const after = (f: string) => a[a.indexOf(f) + 1];
		expect(after('--deploy-hook')).toBe('/usr/local/bin/copy-cert --to "mail"');
		// not checked when read (renewals never check it; `cd x && …` must not stop certbot)
		expect(after('/usr/local/bin/copy-cert --to "mail"')).toBe('--disable-hook-validation');
		expect(after('--preferred-chain')).toBe('ISRG Root X1');
		expect(a).toContain('--reuse-key');
		// Let's Encrypt refuses every must-staple request since 2025
		expect(a).not.toContain('--must-staple');
		expect(a).toContain('--no-autorenew');
		expect(a).not.toContain('--allow-subset-of-names');
		// never the hooks that stop BunkerWeb: the issuance goes through it
		expect(a.join(' ')).not.toMatch(/docker stop|--pre-hook|--post-hook/);
	});

	it('certificate name, webroot, certbot arguments', () => {
		expect(certNameOf(`/etc/letsencrypt/live/${D}/fullchain.pem`)).toBe(D);
		expect(certNameOf('/etc/ssl/site.pem')).toBeNull();
		expect(certNameOf('/etc/letsencrypt/live/${SERVER_NAME}/fullchain.pem')).toBe('${SERVER_NAME}');
		expect(webrootFor(conf(), D, '/x')).toBe(BUILD);
		expect(webrootFor('[renewalparams]\nwebroot_path = /srv/a, /srv/b\n', D, '/x')).toBe('/srv/a');
		expect(webrootFor('', D, '/x')).toBe('/x');
		expect(certbotArgs(D, [D, W], BUILD, conf())).toEqual([
			'certonly',
			'--non-interactive',
			'--cert-name',
			D,
			'--webroot',
			'--webroot-path',
			BUILD,
			'-d',
			D,
			'-d',
			W,
			'--account',
			'0123abcd',
			'--key-type',
			'ecdsa'
		]);
		const staging = certbotArgs(
			D,
			[D],
			BUILD,
			conf('https://acme-staging-v02.api.letsencrypt.org/directory')
		);
		expect(staging.slice(staging.indexOf('--server'), staging.indexOf('--server') + 2)).toEqual([
			'--server',
			'https://acme-staging-v02.api.letsencrypt.org/directory'
		]);
		expect(
			certbotArgs(
				D,
				[D],
				BUILD,
				'[renewalparams]\nkey_type = rsa\nrsa_key_size = 4096\nelliptic_curve = secp384r1\n'
			)
		).toEqual([...certbotArgs(D, [D], BUILD, ''), '--key-type', 'rsa', '--rsa-key-size', '4096']);
	});
});

describe('which DNS servers are asked', () => {
	it('systemd-resolved’s upstream list (not its stub, which also answers from /etc/hosts)', () => {
		expect(
			upstreamResolvers(
				'# This is /run/systemd/resolve/resolv.conf\nnameserver 192.0.2.53\nnameserver 2001:db8::1\nsearch .\n'
			)
		).toEqual(['192.0.2.53', '2001:db8::1']);
		// a scoped link-local server loses its scope in Node: left out
		expect(upstreamResolvers('nameserver fe80::1%2\nnameserver 9.9.9.9\n')).toEqual(['9.9.9.9']);
		expect(upstreamResolvers('nameserver fe80::1%eth0\n')).toBeNull();
		expect(upstreamResolvers('nameserver 127.0.0.53\n')).toBeNull();
		expect(upstreamResolvers(null)).toBeNull();
	});
});

describe('where www points (a real DNS server on 127.0.0.1)', () => {
	let dns: Awaited<ReturnType<typeof startMiniDns>>;
	beforeAll(async () => {
		dns = await startMiniDns({
			'site.test': ['203.0.113.10', '2001:db8::1'],
			'www.site.test': ['203.0.113.10', '2001:db8::1'],
			'v4.test': ['203.0.113.10'],
			'other.test': ['10.0.0.9'],
			'broken.test': 'servfail',
			'quiet.test': 'silent'
		});
	});
	afterAll(async () => dns.close());
	const look = (n: string) => dnsLookup(n, [dns.server], { timeoutMs: 300, tries: 1 });

	it('both address kinds are read; no AAAA record is a sure answer', async () => {
		expect(await look('site.test')).toEqual({ addrs: ['203.0.113.10', '2001:db8::1'], sure: true });
		expect(await look('v4.test')).toEqual({ addrs: ['203.0.113.10'], sure: true });
	});
	it('no such name is a sure "none"; a failing or silent server is not sure', async () => {
		expect(await look('nothing.test')).toEqual({ addrs: [], sure: true });
		expect(await look('broken.test')).toEqual({ addrs: [], sure: false });
		expect(await look('quiet.test')).toEqual({ addrs: [], sure: false });
	});
	it('verdicts', async () => {
		const site = await look('site.test');
		expect(wwwDnsVerdict(site, await look('www.site.test'))).toEqual({ kind: 'here' });
		expect(wwwDnsVerdict(site, await look('v4.test'))).toEqual({ kind: 'here' }); // a subset
		expect(wwwDnsVerdict(site, await look('nothing.test'))).toEqual({ kind: 'none' });
		expect(wwwDnsVerdict(site, await look('other.test'))).toEqual({
			kind: 'elsewhere',
			www: ['10.0.0.9'],
			site: ['203.0.113.10', '2001:db8::1']
		});
		expect(wwwDnsVerdict(site, await look('quiet.test'))).toEqual({ kind: 'unknown' });
		expect(wwwDnsVerdict(await look('broken.test'), site)).toEqual({ kind: 'unknown' });
		expect(wwwDnsVerdict(lk(), lk('1.2.3.4'))).toEqual({ kind: 'unknown' });
		// the site itself has no address here: nothing is concluded about www
		expect(wwwDnsVerdict(lk(), lk())).toEqual({ kind: 'unknown' });
		// a hosts-file answer (this machine's own address) is not public DNS
		expect(wwwDnsVerdict(lk('127.0.1.1'), lk('203.0.113.10'))).toEqual({ kind: 'unknown' });
		expect(wwwDnsVerdict(lk('203.0.113.10'), lk('127.0.0.1', '::1'))).toEqual({ kind: 'unknown' });
		// an IPv6 address written in capitals is the same address
		expect(wwwDnsVerdict(lk('2001:DB8::1'), lk('2001:db8::1'))).toEqual({ kind: 'here' });
		// one www address that is not the site's: elsewhere (Let's Encrypt may ask that one)
		expect(wwwDnsVerdict(lk('203.0.113.10'), lk('203.0.113.10', '2001:db8:9::1')).kind).toBe(
			'elsewhere'
		);
	});
});

describe('the heal on a simulated box', () => {
	const run = async (b: Box) => {
		notes.length = 0;
		return healBunkerWebWww(ctx, b.rt);
	};

	it('vigilante.trading before v1.21.11: www answers, goes to the domain, is on the certificate', async () => {
		const b = new Box();
		expect(b.rt.request(`http://${W}/`).code).toBe('403'); // the reported page
		const r = await run(b);
		expect(r.verified).toBe(true);
		expect(envValues(b.files.get(ENV)!).get('SERVER_NAME')).toBe(`${D} ${W}`);
		expect(b.files.get(`${ENV}.bak-1`)).toBe(OLD_ENV);
		expect(b.rt.request(`http://${W}/a?b=1`)).toMatchObject({
			code: '301',
			location: `https://${D}/a?b=1`
		});
		expect(b.rt.request(`https://${W}/`, { verify: true })).toMatchObject({ code: '301' });
		expect(b.cert).toEqual([D, W]);
		expect(b.certbotCalls).toEqual([certbotArgs(D, [D, W], BUILD, conf())]);
		expect(b.perms).toBe(1);
		expect(b.applies).toEqual([`${W} added|true`, 'the certificate with www loaded|false']);
		expect([...b.files.keys()].some((k) => k.includes('acme-challenge'))).toBe(false); // probe removed
		expect(r.detail).toMatch(/now send every visitor to https:\/\/vigilante\.trading/);
		expect(r.detail).toMatch(/passes a certificate check/);

		// the next upgrade: nothing
		b.applies.length = 0;
		b.writes.length = 0;
		const again = await run(b);
		expect(again).toMatchObject({ routine: true, verified: true });
		expect(b.applies).toEqual([]);
		expect(b.writes).toEqual([]);
		expect(b.certbotCalls).toHaveLength(1);
	});

	it('a subdomain (morphit.timeapp.foundation): no lookup, no change', async () => {
		const b = new Box();
		const t = OLD_ENV.replaceAll(D, 'morphit.timeapp.foundation');
		b.files.set(ENV, t);
		b.live = t;
		const r = await run(b);
		expect(r.routine).toBe(true);
		expect(b.lookups).toEqual([]);
		expect(b.writes).toEqual([]);
		expect(b.applies).toEqual([]);
	});

	it('hidden-only node, no BunkerWeb settings file: nothing at all', async () => {
		const b = new Box();
		b.hidden = true;
		expect((await run(b)).routine).toBe(true);
		const c = new Box();
		c.envPath = null;
		expect((await run(c)).routine).toBe(true);
		const d = new Box();
		d.envPath = null;
		d.envNote = 'WAF: BunkerWeb reads several settings files (a, b)';
		expect(await run(d)).toMatchObject({ verified: true, detail: d.envNote });
		for (const x of [b, c, d]) expect([x.lookups, x.writes, x.applies]).toEqual([[], [], []]);
	});

	it('MULTISITE=yes: named, not changed', async () => {
		const b = new Box();
		b.files.set(ENV, OLD_ENV.replace('MULTISITE=no', 'MULTISITE=yes'));
		const r = await run(b);
		expect(r.detail).toMatch(/several sites here \(MULTISITE=yes\)/);
		expect([b.writes, b.applies, b.lookups]).toEqual([[], [], []]);
	});

	// v1.21.18 audit: MULTISITE was read from bunkerweb.env only, so one set by
	// BunkerWeb's Compose service (`environment:`, which wins) was missed and a
	// multi-site BunkerWeb was changed as a single site.
	it('MULTISITE=yes set by its Compose service (the file says no): named, not changed', async () => {
		const b = new Box();
		b.source = {
			readsFile: true,
			overrides: ['MULTISITE'],
			values: new Map([['MULTISITE', 'yes']])
		};
		const r = await run(b);
		expect(r.detail).toMatch(
			/several sites here \(MULTISITE=yes, set in its Compose service's environment\), so www\.vigilante\.trading was left as it is/
		);
		expect([b.writes, b.applies, b.lookups, b.certbotCalls]).toEqual([[], [], [], []]);
		expect(b.files.get(ENV)).toBe(OLD_ENV);
	});
	it('MULTISITE set by its Compose service with a value Compose does not give: the running edge decides; unknown, nothing changed', async () => {
		const b = new Box();
		b.source = { readsFile: true, overrides: ['MULTISITE'], values: new Map() };
		b.live = OLD_ENV.replace('MULTISITE=no', 'MULTISITE=yes');
		const r = await run(b);
		expect(r.detail).toMatch(/several sites here \(MULTISITE=yes/);
		expect([b.writes, b.applies, b.lookups]).toEqual([[], [], []]);
		const c = new Box();
		c.source = { readsFile: true, overrides: ['MULTISITE'], values: new Map() };
		c.liveUnknown = true;
		const rc = await run(c);
		expect(rc.detail).toMatch(
			/sets MULTISITE itself and its value could not be read, so www\.vigilante\.trading was left as it is/
		);
		expect([c.writes, c.applies, c.lookups]).toEqual([[], [], []]);
	});
	it('MULTISITE=no set by its Compose service: one site, so www is set up as usual', async () => {
		const b = new Box();
		b.files.set(ENV, OLD_ENV.replace('MULTISITE=no', 'MULTISITE=yes'));
		b.source = {
			readsFile: true,
			overrides: ['MULTISITE'],
			values: new Map([['MULTISITE', 'no']])
		};
		const r = await run(b);
		expect(r.detail).not.toMatch(/several sites/);
		expect(b.lookups).toEqual([D, W]);
	});

	it('www has no record: the CNAME to add; a certificate that still names www is issued again without it', async () => {
		const b = new Box();
		b.dns[W] = lk();
		const r = await run(b);
		expect(r.detail).toMatch(
			/has no DNS record.*CNAME record "www" pointing to vigilante\.trading.*sudo morphit-ops upgrade --heals/
		);
		expect([b.writes, b.applies, b.certbotCalls]).toEqual([[], [], []]);

		const c = new Box();
		c.dns[W] = lk();
		c.cert = [D, W];
		const r2 = await run(c);
		expect(c.certbotCalls).toEqual([certbotArgs(D, [D], BUILD, conf())]);
		expect(c.cert).toEqual([D]);
		expect(c.perms).toBe(1);
		expect(c.applies).toEqual(['the certificate without www loaded|false']);
		expect(r2.detail).toMatch(/no longer names www\.vigilante\.trading/);
	});

	it('www points elsewhere: said, nothing changed, a certificate naming it is left (a proxy may pass the check on)', async () => {
		const b = new Box();
		b.dns[W] = lk('198.51.100.7');
		b.cert = [D, W];
		const r = await run(b);
		expect(r.detail).toMatch(/points at 198\.51\.100\.7, not at this server \(203\.0\.113\.10\)/);
		expect([b.writes, b.applies, b.certbotCalls]).toEqual([[], [], []]);
		expect(b.cert).toEqual([D, W]);
	});

	it('DNS could not be asked: nothing changed, said calmly', async () => {
		const b = new Box();
		b.dns[W] = { addrs: [], sure: false };
		b.cert = [D, W];
		const r = await run(b);
		expect(r.detail).toMatch(/could not be looked up just now/);
		expect([b.writes, b.applies, b.certbotCalls]).toEqual([[], [], []]);
	});

	it('Compose refuses the new file: the old one goes back at once, BunkerWeb untouched', async () => {
		const b = new Box();
		b.composeOk = false;
		const r = await run(b);
		expect(r).toMatchObject({ verified: false, strategy: 'restored' });
		expect(b.files.get(ENV)).toBe(OLD_ENV);
		expect([b.applies, b.certbotCalls]).toEqual([[], []]);
	});

	it('BunkerWeb refuses it: the old file goes back and is loaded again; the attempt is kept', async () => {
		const b = new Box();
		b.applyResult = 'refused';
		const r = await run(b);
		expect(r).toMatchObject({ verified: false, strategy: 'restored' });
		expect(b.files.get(ENV)).toBe(OLD_ENV);
		expect(b.files.get(`${ENV}.bak-1.attempted`)).toContain(`SERVER_NAME=${D} ${W}`);
		expect(b.applies).toEqual([`${W} added|true`, 'the previous settings restored|true']);
		expect(b.certbotCalls).toEqual([]);
	});

	it('the site stops answering after the change: undone', async () => {
		const b = new Box();
		b.siteAfter = '000';
		const r = await run(b);
		expect(r.strategy).toBe('restored');
		expect(b.files.get(ENV)).toBe(OLD_ENV);
		expect(notes.join()).toMatch(/answered 000 after the change \(200 before\)/);
	});

	it('BunkerWeb still loading: nothing undone, no second way, no Let’s Encrypt call, said', async () => {
		const b = new Box();
		b.applyResult = 'pending';
		b.siteWhilePending = '000'; // its services coming back up
		const r = await run(b);
		expect(r.detail).toMatch(/could not be checked yet/);
		expect(b.files.get(ENV)).toContain(`SERVER_NAME=${D} ${W}`);
		expect(b.schedConf).toBe(false);
		expect(b.certbotCalls).toEqual([]);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/still loading/);
	});

	it('the env rule is not loaded: written a second way (scheduler config file), then checked', async () => {
		const b = new Box();
		b.nginxReadable = true;
		b.ignoreEnvRule = true;
		const r = await run(b);
		expect(b.schedConf).toBe(true);
		expect(r).toMatchObject({ verified: true, strategy: 'applied-config-file' });
		expect(b.cert).toEqual([D, W]);
	});

	it('the rule never goes live: not claimed, the command given, Let’s Encrypt not asked', async () => {
		const b = new Box();
		b.nginxReadable = true;
		b.ignoreEnvRule = true;
		b.schedConfWorks = false;
		const r = await run(b);
		expect(r.verified).toBe(false);
		// What was answered, what was checked, and the one thing to send — never
		// "run the upgrade again" (it would try the same thing), never the long
		// certbot command while www itself does not work (v1.21.17 review).
		expect(r.detail).toMatch(
			/a test request on this server for www\.vigilante\.trading was answered 301 → https:\/\/www\.vigilante\.trading\/.* instead of being sent on to https:\/\/vigilante\.trading/
		);
		expect(r.detail).toMatch(
			/it needs a look: send the output of, on this server: sudo docker exec bunkerweb nginx -T/
		);
		expect(r.detail).not.toMatch(/upgrade --heals|certbot certonly/);
		expect(r.detail).toMatch(
			/the next upgrade adds it to the certificate by itself once www\.vigilante\.trading works/
		);
		expect(b.certbotCalls).toEqual([]);
	});

	it('the challenge file does not come back through www: Let’s Encrypt is not asked; the exact command is given', async () => {
		const b = new Box();
		b.servesChallenge = false;
		const r = await run(b);
		expect(b.certbotCalls).toEqual([]);
		expect(r.verified).toBe(false);
		expect(r.detail).toContain(`sudo certbot ${certbotArgs(D, [D, W], BUILD, conf()).join(' ')}`);
	});

	it('Let’s Encrypt refuses (rate limit): the certificate is as it was, said why', async () => {
		const b = new Box();
		b.certbotOut = 'Error: too many certificates (5) already issued for this exact set of domains';
		const r = await run(b);
		expect(b.cert).toEqual([D]);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/too many certificates were asked for lately/);
		expect(b.perms).toBe(0);
	});

	it('BunkerWeb keeps the old certificate after the scheduler restart: recreated, then checked', async () => {
		const b = new Box();
		b.stickyCert = 2; // the settings reload and the scheduler restart both keep it
		const r = await run(b);
		expect(b.applies).toEqual([
			`${W} added|true`,
			'the certificate with www loaded|false',
			'the certificate with www loaded|true'
		]);
		expect(r.verified).toBe(true);
	});

	it('a certificate that already names www but is not served: reloaded once; still not → said', async () => {
		const b = new Box();
		b.cert = [D, W];
		b.stickyCert = 5;
		const r = await run(b);
		expect(b.certbotCalls).toEqual([]);
		expect(b.applies.filter((a) => a.startsWith('the certificate reloaded'))).toHaveLength(1);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/did not pass a certificate check/);
	});

	it('no certbot / a certificate not from certbot: said, nothing asked', async () => {
		const b = new Box();
		b.hasCertbot = false;
		expect((await run(b)).detail).toMatch(/certbot is not installed/);
		const c = new Box();
		const t = OLD_ENV.replace(/CUSTOM_SSL_CERT=.*/, 'CUSTOM_SSL_CERT=/etc/ssl/site/fullchain.pem');
		c.files.set(ENV, t);
		c.live = t;
		const r = await run(c);
		expect(r.detail).toMatch(/not one from this server's certbot/);
		expect(c.certbotCalls).toEqual([]);
	});

	it('BunkerWeb cannot be restarted: the change is written, the command given', async () => {
		const b = new Box();
		b.restartable = false;
		const r = await run(b);
		expect(r).toMatchObject({ verified: false, strategy: 'written' });
		expect(r.detail).toMatch(/could not be recreated to load it.*sudo morphit-ops upgrade --heals/);
		expect(b.certbotCalls).toEqual([]);
	});

	it('no copy of the old file could be kept: nothing is written', async () => {
		const b = new Box();
		b.backupOk = false;
		const r = await run(b);
		expect(b.files.get(ENV)).toBe(OLD_ENV);
		expect(r.verified).toBe(false);
		expect(b.applies).toEqual([]);
	});

	it('a change written but never loaded is loaded by the next run (recreate), not by a scheduler restart', async () => {
		const b = new Box();
		b.restartable = false;
		const first = await run(b);
		expect(first.strategy).toBe('written');
		b.restartable = true;
		b.applies.length = 0;
		const second = await run(b);
		expect(b.applies[0]).toBe(`${W} loaded from ${ENV}|true`);
		expect(second.verified).toBe(true);
		expect(b.rt.request(`http://${W}/x`)).toMatchObject({
			code: '301',
			location: `https://${D}/x`
		});
		expect(b.schedConf).toBe(false);
		expect(b.cert).toEqual([D, W]);
	});

	it('BunkerWeb not started by Compose: said once per run, never a restart that loads nothing', async () => {
		const b = new Box();
		b.canRecreate = false;
		const t = planWwwEnv(OLD_ENV, { domain: D, alias: W }).text;
		b.files.set(ENV, t); // the file already has www (a fresh install), the containers do not
		for (let k = 0; k < 3; k++) {
			b.applies.length = 0;
			const r = await run(b);
			expect(r).toMatchObject({ verified: false, strategy: 'not-loaded' });
			expect(r.detail).toMatch(/could not be recreated automatically/);
			expect(b.applies).toEqual([`${W} loaded from ${ENV}|true`]);
			expect(b.schedConf).toBe(false);
			expect(b.certbotCalls).toEqual([]);
		}
	});

	it('recreated, but the running BunkerWeb still lacks www: said, no scheduler-file workaround', async () => {
		const b = new Box();
		b.recreateReadsFile = false;
		const r = await run(b);
		expect(b.schedConf).toBe(false);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(
			/services were recreated, but its containers still run without www\.vigilante\.trading/
		);
		// recreated once (with the change), not again for nothing
		expect(b.applies).toEqual([`${W} added|true`]);
		expect(b.certbotCalls).toEqual([]);
	});

	it('no answer on this machine: nothing restarted, nothing written, not claimed', async () => {
		const b = new Box();
		const t = planWwwEnv(OLD_ENV, { domain: D, alias: W }).text;
		b.files.set(ENV, t);
		b.live = t;
		b.cert = [D, W];
		b.noAnswer = true;
		const r = await run(b);
		expect(b.applies).toEqual([]);
		expect(b.schedConf).toBe(false);
		expect(b.certbotCalls).toEqual([]);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/could not be checked on this server/);
	});

	it('the running settings cannot be read: no recreate on a guess', async () => {
		const b = new Box();
		const t = planWwwEnv(OLD_ENV, { domain: D, alias: W }).text;
		b.files.set(ENV, t);
		b.live = t;
		b.liveUnknown = true;
		b.cert = [D, W];
		b.served = [D, W];
		const r = await run(b);
		expect(r.routine).toBe(true);
		expect(b.applies).toEqual([]);
	});

	it('a certificate that does not name the domain (CUSTOM_SSL_* left on an old domain): said, not touched', async () => {
		const b = new Box();
		b.cert = ['old.example.org'];
		const r = await run(b);
		expect(b.certbotCalls).toEqual([]);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/names old\.example\.org, not vigilante\.trading/);
		expect(b.cert).toEqual(['old.example.org']);
	});

	it('not enough time left: BunkerWeb is not restarted at all; the next upgrade does it', async () => {
		const b = new Box();
		b.timeLeft = 4 * 60_000;
		const r = await run(b);
		expect(b.files.get(ENV)).toBe(OLD_ENV);
		expect(b.applies).toEqual([]);
		expect(r.strategy).toBe('no-time');
		expect(r.detail).toMatch(
			/not enough time to restart BunkerWeb\): the next `sudo morphit-ops upgrade` does it/
		);
	});

	it('late in the background run: settings now, certificate next upgrade', async () => {
		const b = new Box();
		b.timeLeft = 6 * 60_000;
		const r = await run(b);
		expect(envValues(b.files.get(ENV)!).get('SERVER_NAME')).toBe(`${D} ${W}`);
		expect(b.rt.request(`http://${W}/`)).toMatchObject({ code: '301' });
		expect(b.certbotCalls).toEqual([]);
		expect(r.detail).toMatch(/was not added to the certificate in this run/);
	});

	it('the attempted file is kept private (0600)', async () => {
		const b = new Box();
		b.applyResult = 'refused';
		await run(b);
		expect(b.modes[`${ENV}.bak-1.attempted`]).toBe(0o600);
	});

	it('the scheduler config file already there: not written or restarted again', async () => {
		const b = new Box();
		b.nginxReadable = true;
		b.ignoreEnvRule = true;
		b.schedConfWorks = false;
		await run(b);
		b.applies.length = 0;
		const r = await run(b);
		expect(b.applies).toEqual([]);
		expect(r.verified).toBe(false);
	});

	it('a recreate that does not give BunkerWeb www is tried once per file, not every upgrade', async () => {
		const b = new Box();
		b.recreateReadsFile = false;
		const t = planWwwEnv(OLD_ENV, { domain: D, alias: W }).text;
		b.files.set(ENV, t);
		await run(b);
		expect(b.applies).toEqual([`${W} loaded from ${ENV}|true`]);
		for (let k = 0; k < 2; k++) {
			b.applies.length = 0;
			const r = await run(b);
			expect(b.applies).toEqual([]);
			expect(r.detail).toMatch(
				/services were recreated, but its containers still run without www\.vigilante\.trading/
			);
			expect(r.detail).not.toMatch(/upgrade --heals/);
			expect(r.detail).not.toMatch(/next `sudo morphit-ops upgrade`/);
		}
		// a changed file is tried again
		b.files.set(ENV, `${t}# edited\n`);
		b.applies.length = 0;
		await run(b);
		expect(b.applies).toEqual([`${W} loaded from ${ENV}|true`]);
	});

	it('the Compose service sets SERVER_NAME itself (environment:): said, the file is not touched', async () => {
		const b = new Box();
		b.source = { readsFile: true, overrides: ['SERVER_NAME', 'TZ'] };
		const r = await run(b);
		expect(b.files.get(ENV)).toBe(OLD_ENV);
		expect(b.applies).toEqual([]);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/sets SERVER_NAME itself/);
		expect(r.detail).toContain(`${WWW_REDIRECT_KEY}='${wwwRedirectConf(D)}'`);
		const c = new Box();
		c.source = { readsFile: false, overrides: [] };
		expect((await run(c)).detail).toMatch(/does not read \/etc\/bunkerweb\/bunkerweb\.env/);
		expect([c.writes, c.applies]).toEqual([[], []]);
	});

	it('the self-heal child (no background step): nothing restarted, and it says why — no false promise', async () => {
		const b = new Box();
		b.background = false;
		b.timeLeft = 4.5 * 60_000;
		const r = await run(b);
		expect(b.applies).toEqual([]);
		expect(b.files.get(ENV)).toBe(OLD_ENV);
		expect(r.detail).toMatch(
			/background step, which could not be started on this server \(systemd-run\)/
		);
		expect(r.detail).not.toMatch(/next `sudo morphit-ops upgrade`/);
	});

	it('not started by Docker Compose: the messages say to recreate the container, not to run the upgrade again', async () => {
		const b = new Box();
		b.canRecreate = false;
		const r = await run(b);
		expect(r.strategy).toBe('written');
		expect(r.detail).toMatch(
			/recreate the BunkerWeb container with the settings in \/etc\/bunkerweb\/bunkerweb\.env \(it was not started by Docker Compose\)/
		);
		expect(r.detail).not.toMatch(/upgrade --heals/);
	});

	it('the running settings name www but with another rule: recreated (the rule must match too)', async () => {
		const b = new Box();
		const t = planWwwEnv(OLD_ENV, { domain: D, alias: W }).text;
		b.files.set(ENV, t);
		b.live = t.replace(wwwRedirectConf(D), 'if ($host = www.x) { return 301 https://x; }');
		await run(b);
		expect(b.applies[0]).toBe(`${W} loaded from ${ENV}|true`);
	});

	it('removing www from the certificate needs time too, and the domain on it', async () => {
		const b = new Box();
		b.dns[W] = lk();
		b.cert = [D, W];
		b.timeLeft = 6 * 60_000;
		const r = await run(b);
		expect(b.certbotCalls).toEqual([]);
		expect(r.detail).toMatch(/not enough time in this run to issue it again without/);
		const c = new Box();
		c.dns[W] = lk();
		c.cert = ['old.example.org', W];
		await run(c);
		expect(c.certbotCalls).toEqual([]);
	});

	it('a certificate that asked for must-staple: issued without it, and said', async () => {
		const b = new Box();
		b.files.set(
			RENEWAL,
			conf().replace('key_type = ecdsa\n', 'key_type = ecdsa\nmust_staple = True\n')
		);
		const r = await run(b);
		expect(b.certbotCalls[0]).not.toContain('--must-staple');
		expect(r.detail).toMatch(/without OCSP Must-Staple/);
		expect(b.cert).toEqual([D, W]);
	});

	it('a staging certificate is renewed from staging', async () => {
		const b = new Box();
		b.files.set(RENEWAL, conf('https://acme-staging-v02.api.letsencrypt.org/directory'));
		await run(b);
		expect(b.certbotCalls[0]).toContain('https://acme-staging-v02.api.letsencrypt.org/directory');
	});
});

/**
 * morphit.io, v1.21.17: the settings file AND BunkerWeb's containers name
 * www.morphit.io, yet nginx serves `server_name morphit.io;` only and www gets
 * BunkerWeb's 403. BunkerWeb 1.5 (single site) serves the names of its own
 * site list (bw_services), and its scheduler only ever puts the FIRST name of
 * SERVER_NAME there, so recreating it never helps. The old heal judged "BunkerWeb
 * has www" from the container environment, wrote a scheduler config file (a
 * second copy of the rule), and on every later run said the same thing and
 * "run: sudo morphit-ops upgrade --heals", which changed nothing.
 */
describe('www named in the settings but not served (what nginx really runs)', () => {
	const run = async (b: Box) => {
		notes.length = 0;
		return healBunkerWebWww(ctx, b.rt);
	};
	/** morphit.io as it was found: file and containers have www, nginx not. */
	const morphitIo = (): Box => {
		const b = new Box();
		const t = planWwwEnv(OLD_ENV, { domain: D, alias: W }).text;
		b.files.set(ENV, t);
		b.live = t;
		b.bw15 = true;
		b.nginxReadable = true;
		return b;
	};

	it('BunkerWeb 1.5 kept only the domain in its site list: www is added there, served, and then gets its certificate', async () => {
		const b = morphitIo();
		expect(b.rt.request(`http://${W}/x`).code).toBe('403');
		const r = await run(b);
		expect(b.added).toEqual([[W]]);
		// the scheduler restarted (its first start generates the config again); no recreate
		expect(b.applies[0]).toBe(`${W} added to BunkerWeb's site list|false`);
		expect(r.detail).toMatch(
			/BunkerWeb kept only vigilante\.trading as this site's name .*added www\.vigilante\.trading to its site list \(the database as it was is kept in BunkerWeb's scheduler at \/data\/lib\/db\.pre-morphit-sites-1\.sqlite3\)/
		);
		expect(b.rt.request(`http://${W}/a?b=1`)).toMatchObject({
			code: '301',
			location: `https://${D}/a?b=1`
		});
		expect(b.cert).toEqual([D, W]);
		expect(r.verified).toBe(true);
		expect(r.detail).not.toMatch(/upgrade --heals/);
		// and the next run has nothing to do
		const again = await run(b);
		expect(again).toMatchObject({ routine: true, verified: true });
	});

	it('BunkerWeb 1.5 and a file without www: written, recreated, then added to the site list — in one run', async () => {
		const b = new Box();
		b.bw15 = true;
		b.nginxReadable = true;
		const r = await run(b);
		expect(b.applies.slice(0, 2)).toEqual([
			`${W} added|true`,
			`${W} added to BunkerWeb's site list|false`
		]);
		expect(b.rt.request(`http://${W}/x`)).toMatchObject({ code: '301' });
		expect(b.cert).toEqual([D, W]);
		expect(r.verified).toBe(true);
	});

	// v1.21.18 audit, M4: WWW_DB_PY answers {"db":"other","ids":[]} for a
	// database server (the fake answered with the site list), so this branch
	// was never reached: BunkerWeb was recreated (the site down meanwhile) and
	// the run ended with a sentence that blamed nginx, kept in a marker.
	it('another database server: nothing restarted, the cause and the one step in plain words, the same on every run, never "--heals"', async () => {
		const b = morphitIo();
		b.siteDb = 'other';
		for (let k = 0; k < 3; k++) {
			b.applies.length = 0;
			const r = await run(b);
			expect(b.applies).toEqual([]);
			expect(r.verified).toBe(false);
			expect(r.detail).toMatch(
				/BunkerWeb serves only the names in its own site list, and keeps that list in a database server \(its DATABASE_URI is not a sqlite file\), which this upgrade does not edit, so www\.vigilante\.trading was not added and BunkerWeb was not restarted\. To add it: in that database's bw_services table, add a row for www\.vigilante\.trading like the row for vigilante\.trading \(method "scheduler", is_draft 0\), then on this server: sudo docker restart bunkerweb-scheduler/
			);
			expect(r.detail).not.toMatch(/upgrade --heals|certbot certonly|nginx it runs/);
		}
		expect(b.added).toEqual([]);
		expect(b.files.has(`${ENV}.www-recreated`)).toBe(false);
		expect(b.certbotCalls).toEqual([]);
	});
	it('its database file not found: nothing restarted, said so', async () => {
		const b = morphitIo();
		b.siteDb = 'missing';
		const r = await run(b);
		expect(b.applies).toEqual([]);
		expect(r.detail).toMatch(
			/its database file was not found in its scheduler .*so www\.vigilante\.trading was not added and BunkerWeb was not restarted; it needs a look/
		);
	});

	it('an automatic attempt that does not help is made once per settings file; later runs name the cause and change nothing', async () => {
		const b = morphitIo();
		b.sitesIgnored = true;
		const first = await run(b);
		expect(b.applies).toEqual([`${W} added to BunkerWeb's site list|false`]);
		expect(first.detail).toMatch(/nginx it runs still answers only for vigilante\.trading/);
		for (let k = 0; k < 2; k++) {
			b.applies.length = 0;
			const r = await run(b);
			expect(b.applies).toEqual([]);
			expect(r.detail).toMatch(
				/nginx it runs still answers only for vigilante\.trading; it needs a look/
			);
			expect(r.detail).not.toMatch(/upgrade --heals|certbot certonly/);
		}
		expect(b.certbotCalls).toEqual([]);
	});

	it('BunkerWeb refuses the config: its own reason is quoted', async () => {
		const b = morphitIo();
		b.siteDb = 'other';
		b.bw15 = false; // containers lack www: a recreate is the attempt
		b.live = OLD_ENV;
		b.refusal = 'unknown directive "iff" in /etc/nginx/server.conf:9';
		const r = await run(b);
		expect(r.detail).toMatch(
			/refused its new config with www\.vigilante\.trading \("unknown directive "iff" in \/etc\/nginx\/server\.conf:9"\)/
		);
		expect(r.detail).not.toMatch(/upgrade --heals/);
	});

	it('the domain itself does not answer as usual from this server: www is not blamed, nothing changed', async () => {
		const b = new Box();
		const t = planWwwEnv(OLD_ENV, { domain: D, alias: W }).text;
		b.files.set(ENV, t);
		b.live = t;
		b.nginxReadable = true;
		const real = b.rt.request;
		(b.rt as { request: WwwRuntime['request'] }).request = (url, o) =>
			new URL(url).hostname === D || new URL(url).hostname === W
				? { code: '403', location: '', headers: '', exit: 0 }
				: real(url, o);
		const r = await run(b);
		expect(r.detail).toMatch(
			/www\.vigilante\.trading could not be checked from this server: a test request for vigilante\.trading itself, made the same way, was answered 403/
		);
		expect(b.applies).toEqual([]);
		expect(b.schedConf).toBe(false);
		expect(b.certbotCalls).toEqual([]);
	});

	it('nginx cannot be read: no second copy of the rule is written on a guess, and nothing circular is said', async () => {
		const b = morphitIo();
		b.nginxReadable = false;
		for (let k = 0; k < 2; k++) {
			const r = await run(b);
			expect(b.schedConf).toBe(false);
			expect(r.verified).toBe(false);
			expect(r.detail).not.toMatch(/upgrade --heals|certbot certonly/);
		}
	});

	it('the www rule twice (from the settings and from an earlier upgrade’s config file): the file’s copy goes', async () => {
		const b = morphitIo();
		b.bw15 = false;
		b.schedConf = true; // morphit-www-redirect.conf, written by v1.21.11–v1.21.17
		b.cert = [D, W];
		b.served = [D, W];
		const r = await run(b);
		expect(b.ruleCopiesRemoved).toBe(1);
		expect(b.nginxText()).not.toContain('morphit-www-redirect.conf');
		expect(b.nginxText()).toContain('morphit_www_redirect.conf');
		expect(b.rt.request(`http://${W}/q`)).toMatchObject({ code: '301' });
		expect(r.detail).toMatch(/had the www rule twice .*that file's copy was taken out/);
	});

	// v1.21.18 audit, L2: on a slow box BunkerWeb is still loading ('pending')
	// when checked; the copy was written back, so every upgrade repeated the
	// round (a database copy and a moved file each time).
	it('the second copy taken out while BunkerWeb is still loading: it stays out (not written back)', async () => {
		const b = morphitIo();
		b.bw15 = false;
		b.schedConf = true;
		b.cert = [D, W];
		b.served = [D, W];
		b.applyResult = 'pending';
		await run(b);
		expect(b.ruleCopiesRemoved).toBe(1);
		expect(b.schedConf).toBe(false);
		expect(b.applies.filter((a) => /put back/.test(a))).toEqual([]);
	});
	it('the second copy taken out and BunkerWeb refuses the new config: written back', async () => {
		const b = morphitIo();
		b.bw15 = false;
		b.schedConf = true;
		b.cert = [D, W];
		b.served = [D, W];
		b.applyResult = 'refused';
		await run(b);
		expect(b.ruleCopiesRemoved).toBe(1);
		expect(b.schedConf).toBe(true);
	});
});
