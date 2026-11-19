/**
 * The TLS renewal heal against a simulated box that behaves like BunkerWeb
 * 1.5.10 really does (v1.24.6): BunkerWeb answers /.well-known/acme-challenge/
 * itself, from its own folder in its container, for every name, and never
 * passes that path on to the frontend, so a file in the web build is never
 * seen by Let's Encrypt (its letsencrypt plugin's
 * `location ~ ^/.well-known/acme-challenge/ { root /var/tmp/bunkerweb/lets-encrypt; }`).
 * Up to v1.24.4 this double let BunkerWeb pass the path on to the web build,
 * which is how the heal's webroot strategy passed here and failed on every
 * real BunkerWeb box. A web server that does pass the path on (not BunkerWeb)
 * is the `caddy` edge below. certbot's dry run passes only when the renewal
 * settings would really work on this box. The real run (morphit.io, v1.24.4:
 * a test file came back from BunkerWeb's folder for the domain and for www,
 * Let's Encrypt issued, a staging dry run passed) is in the release notes.
 */
import { describe, expect, it } from 'vitest';
import {
	AUTH_HOOK,
	CLEANUP_HOOK,
	EDGE_ACME_DIR,
	ensureAcmeHooks,
	type HookFs
} from '../src/lib/acmeBunkerweb.ts';
import {
	bunkerWebSettings,
	healTlsRenewal,
	ownPauseHooks,
	renewalParam,
	rendersBunkerWeb,
	rendersWebroot,
	setRenewalParams,
	webrootMap,
	webrootSettings,
	type TlsRuntime
} from '../src/lib/tlsRenewHeal.ts';

const BUILD = '/opt/morphit/apps/web/build';
const D = 'trade.example.org';
const CONF = `/etc/letsencrypt/renewal/${D}.conf`;
const STANDALONE = `# renew_before_expiry = 30 days
version = 2.9.0
archive_dir = /etc/letsencrypt/archive/${D}
cert = /etc/letsencrypt/live/${D}/cert.pem

# Options used in the renewal process
[renewalparams]
account = 0123abcd
authenticator = standalone
server = https://acme-v02.api.letsencrypt.org/directory
key_type = ecdsa
`;
/** What the v1.24.4 heal left on morphit.io: standalone, BunkerWeb paused. */
const PAUSED = STANDALONE.replace(
	'key_type = ecdsa\n',
	'key_type = ecdsa\npre_hook = docker stop bunkerweb\npost_hook = docker start bunkerweb\n'
);

class Box {
	files = new Map<string, string>([[CONF, STANDALONE]]);
	owner = 'docker-proxy';
	reachable = true;
	version = 'certbot 2.9.0';
	/** The container publishing port 80. */
	edge: string | null = 'bunkerweb';
	/** Is it BunkerWeb (false: a web server that passes the path on)? */
	edgeIsBunkerWeb = true;
	/** BunkerWeb's own Let's Encrypt folder (inside its container). */
	edgeFiles = new Map<string, string>();
	/** Does `docker exec` into BunkerWeb work? */
	edgeWritable = true;
	/** Does a web server that is not BunkerWeb pass the path on to the build? */
	buildServed = true;
	/** Does stopping the edge really free port 80 (another program may hold it)? */
	hooksWork = true;
	/** Does Let's Encrypt's check through BunkerWeb's folder pass a renewal? */
	folderRenews = true;
	/** Can the hooks be written? */
	hooksWritable = true;
	hookFiles = new Map<string, string>();
	certbotCalls: string[][] = [];
	localGets: string[] = [];
	get bw(): boolean {
		return this.owner !== '' && this.edge !== null && this.edgeIsBunkerWeb;
	}
	/** Would a renewal with this config work on this box? */
	works(text: string): boolean {
		const auth = renewalParam(text, 'authenticator');
		if (auth === 'manual')
			return (
				this.bw &&
				this.folderRenews &&
				this.edgeWritable &&
				renewalParam(text, 'manual_auth_hook') === AUTH_HOOK &&
				this.hookFiles.has(AUTH_HOOK) &&
				!renewalParam(text, 'pre_hook')
			);
		// BunkerWeb never passes the path on to the build.
		if (auth === 'webroot')
			return !this.bw && this.buildServed && webrootMap(text).get(D) === BUILD;
		if (auth === 'standalone')
			return (
				this.owner === '' ||
				(this.hooksWork && renewalParam(text, 'pre_hook') === `docker stop ${this.edge}`)
			);
		return false;
	}
	hookFs: HookFs = {
		read: (p) => this.hookFiles.get(p) ?? null,
		write: (p, t) => (this.hooksWritable ? (this.hookFiles.set(p, t), true) : false),
		executable: (p) => this.hookFiles.has(p)
	};
	readonly rt: TlsRuntime = {
		renewalConfs: () =>
			[...this.files]
				.filter(([p]) => p.startsWith('/etc/letsencrypt/renewal/'))
				.map(([path, text]) => ({ path, text })),
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, t) => (this.files.set(p, t), true),
		removeFile: (p) => void this.files.delete(p),
		port80Owner: () => this.owner,
		certInfo: () => ({ domains: [D], notAfter: 'Dec 30 12:00:00 2026 GMT' }),
		localGet: (_d, path) => {
			this.localGets.push(path);
			if (this.bw) {
				if (!path.startsWith('/.well-known/acme-challenge/')) return '<html>app</html>';
				const f = this.edgeFiles.get(path.slice('/.well-known/acme-challenge/'.length));
				return f ?? '<!doctype html><html lang="en">BunkerWeb 404</html>';
			}
			if (!this.buildServed) return '<html>app</html>';
			return this.files.get(`${BUILD}${path}`) ?? null;
		},
		acmeReachable: () => this.reachable,
		certbot: (args) => {
			this.certbotCalls.push([...args]);
			if (args[0] === '--version') return { ok: true, out: this.version };
			if (args[0] === 'reconfigure') {
				const want = webrootSettings(
					this.files.get(CONF)!,
					args[args.indexOf('--webroot-path') + 1]!,
					[D]
				);
				if (!this.works(want)) return { ok: false, out: 'Some challenges have failed.' };
				this.files.set(CONF, want); // saved only after the dry run passed
				return { ok: true, out: 'The dry run was successful.' };
			}
			if (args[0] === 'renew') return { ok: this.works(this.files.get(CONF)!), out: '' };
			return { ok: false, out: '' };
		},
		port80Container: () => this.edge,
		isBunkerWeb: (c) => c === this.edge && this.edgeIsBunkerWeb,
		edgeChallenge: (c, t, b) => {
			if (!this.edgeWritable || c !== this.edge || !this.edgeIsBunkerWeb) return false;
			if (b === null) this.edgeFiles.delete(t);
			else this.edgeFiles.set(t, b);
			return true;
		},
		ensureAcmeHooks: () => ensureAcmeHooks(this.hookFs)
	};
	run() {
		return healTlsRenewal(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ webroot: BUILD, runtime: this.rt }
		);
	}
	leftoverProbes(): string[] {
		return [
			...[...this.files.keys()].filter((k) => k.includes('/.well-known/acme-challenge/')),
			...this.edgeFiles.keys()
		];
	}
}

describe('the certificate renews while BunkerWeb holds port 80 (v1.24.6)', () => {
	it('as installed (standalone, BunkerWeb on port 80) a renewal cannot work — the case the heal is for', () => {
		const b = new Box();
		expect(b.works(STANDALONE)).toBe(false);
		// and the web build is no way round it behind BunkerWeb
		expect(b.works(webrootSettings(STANDALONE, BUILD, [D]))).toBe(false);
	});

	it('switches to BunkerWeb’s own Let’s Encrypt folder: nothing paused, a real dry run passed, read back', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(out.strategy).toBe('bunkerweb');
		const conf = b.files.get(CONF)!;
		expect(renewalParam(conf, 'authenticator')).toBe('manual');
		expect(renewalParam(conf, 'manual_auth_hook')).toBe(AUTH_HOOK);
		expect(renewalParam(conf, 'manual_cleanup_hook')).toBe(CLEANUP_HOOK);
		expect(renewalParam(conf, 'pre_hook')).toBeNull();
		expect(renewalParam(conf, 'post_hook')).toBeNull();
		expect(b.works(conf)).toBe(true);
		expect(b.certbotCalls).toContainEqual([
			'renew',
			'--dry-run',
			'--no-random-sleep-on-renew',
			'--cert-name',
			D,
			'--non-interactive'
		]);
		// the path was proven first, through the domain, as Let's Encrypt asks
		expect(
			b.localGets.some((p) => p.startsWith('/.well-known/acme-challenge/morphit-probe-'))
		).toBe(true);
		expect(b.leftoverProbes()).toEqual([]);
		expect(b.hookFiles.has(AUTH_HOOK) && b.hookFiles.has(CLEANUP_HOOK)).toBe(true);
		// the rest of the file is kept
		expect(conf).toContain('account = 0123abcd');
		expect(conf).toContain(`archive_dir = /etc/letsencrypt/archive/${D}`);
		// second run: nothing left to do, nothing asked of certbot
		const calls = b.certbotCalls.length;
		const again = await b.run();
		expect(again.verified).toBe(true);
		expect(again.routine).toBe(true);
		expect(b.certbotCalls.length).toBe(calls);
	});

	it('never pauses BunkerWeb when its folder works (v1.24.4 fell through to the pause every time)', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out.strategy).not.toBe('hooks');
		expect(renewalParam(b.files.get(CONF)!, 'pre_hook')).toBeNull();
	});

	it('the pause the v1.24.4 heal left (morphit.io) is replaced by the folder, with nothing paused', async () => {
		const b = new Box();
		b.files.set(CONF, PAUSED);
		expect(b.works(PAUSED)).toBe(true); // it renews today, with a pause
		const out = await b.run();
		expect(out.strategy).toBe('bunkerweb');
		expect(out.verified).toBe(true);
		const conf = b.files.get(CONF)!;
		expect(renewalParam(conf, 'authenticator')).toBe('manual');
		expect(renewalParam(conf, 'pre_hook')).toBeNull();
		expect(renewalParam(conf, 'post_hook')).toBeNull();
		expect(b.works(conf)).toBe(true);
	});

	it('that pause stays byte for byte when BunkerWeb’s folder does not answer (it still renews)', async () => {
		const b = new Box();
		b.files.set(CONF, PAUSED);
		b.edgeWritable = false;
		const out = await b.run();
		expect(b.files.get(CONF)).toBe(PAUSED);
		expect(out.verified).toBe(true);
		expect(out.detail).toMatch(/still renews by pausing bunkerweb/);
		expect(b.certbotCalls).toEqual([]);
	});

	it('that pause stays byte for byte when the test renewal through the folder fails', async () => {
		const b = new Box();
		b.files.set(CONF, PAUSED);
		b.folderRenews = false;
		const out = await b.run();
		expect(b.files.get(CONF)).toBe(PAUSED);
		expect(out.verified).toBe(true);
		expect(out.detail).toMatch(
			/test renewal with Let's Encrypt through BunkerWeb's own folder did not pass/
		);
	});

	it('a folder whose test renewal fails is taken back byte for byte, then the pause (said why)', async () => {
		const b = new Box();
		b.folderRenews = false;
		const out = await b.run();
		expect(out.strategy).toBe('hooks');
		expect(out.verified).toBe(true);
		const conf = b.files.get(CONF)!;
		expect(renewalParam(conf, 'authenticator')).toBe('standalone');
		expect(renewalParam(conf, 'pre_hook')).toBe('docker stop bunkerweb');
		expect(out.detail).toMatch(/through BunkerWeb's own folder did not pass/);
		expect(b.leftoverProbes()).toEqual([]);
	});

	it('hooks that cannot be written: the folder is not used, the pause is, and the hooks are named', async () => {
		const b = new Box();
		b.hooksWritable = false;
		const out = await b.run();
		expect(out.strategy).toBe('hooks');
		expect(out.detail).toContain(AUTH_HOOK);
		expect(renewalParam(b.files.get(CONF)!, 'authenticator')).toBe('standalone');
	});

	it('a box already on the folder whose hooks went missing gets them written again (no certbot run)', async () => {
		const b = new Box();
		await b.run();
		b.hookFiles.clear();
		const calls = b.certbotCalls.length;
		const out = await b.run();
		expect(out.strategy).toBe('hooks-rewritten');
		expect(out.verified).toBe(true);
		expect(b.hookFiles.has(AUTH_HOOK)).toBe(true);
		expect(b.works(b.files.get(CONF)!)).toBe(true);
		expect(b.certbotCalls.length).toBe(calls);
	});

	it('webroot set by hand behind BunkerWeb (which cannot work) is switched to the folder', async () => {
		const b = new Box();
		const hand = webrootSettings(STANDALONE, BUILD, [D]);
		b.files.set(CONF, hand);
		expect(b.works(hand)).toBe(false);
		const out = await b.run();
		expect(out.strategy).toBe('bunkerweb');
		const conf = b.files.get(CONF)!;
		expect(b.works(conf)).toBe(true);
		expect(webrootMap(conf).size).toBe(0);
		expect(renewalParam(conf, 'webroot_path')).toBeNull();
	});

	it('standalone with hooks of the operator’s own is left alone', async () => {
		const b = new Box();
		const own = STANDALONE.replace(
			'key_type = ecdsa\n',
			'key_type = ecdsa\npre_hook = /root/my-pre.sh\n'
		);
		b.files.set(CONF, own);
		await b.run();
		expect(b.files.get(CONF)).toBe(own);
		expect(b.certbotCalls).toEqual([]);
	});
});

describe('a web server that is not BunkerWeb holds port 80', () => {
	const caddy = (): Box => {
		const b = new Box();
		b.edge = 'caddy';
		b.edgeIsBunkerWeb = false;
		return b;
	};

	it('it passes the path on to the web build: webroot with certbot reconfigure (a real dry run), read back', async () => {
		const b = caddy();
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(out.strategy).toBe('webroot');
		const conf = b.files.get(CONF)!;
		expect(rendersWebroot(conf, BUILD, D)).toBe(true);
		expect(b.works(conf)).toBe(true);
		expect(b.certbotCalls.some((c) => c[0] === 'reconfigure')).toBe(true);
		expect(b.leftoverProbes()).toEqual([]);
		expect(b.hookFiles.size).toBe(0);
	});

	it('certbot older than 2.3 (no reconfigure): the heal writes webroot itself, keeps it only when the dry run passes', async () => {
		const b = caddy();
		b.version = 'certbot 1.21.0';
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.works(b.files.get(CONF)!)).toBe(true);
		expect(b.certbotCalls).toContainEqual([
			'renew',
			'--dry-run',
			'--no-random-sleep-on-renew',
			'--cert-name',
			D,
			'--non-interactive'
		]);
	});

	it('the web build does not answer the challenge path: hooks pause the edge for the renewal, checked by a dry run', async () => {
		const b = caddy();
		b.buildServed = false;
		const out = await b.run();
		expect(out.strategy).toBe('hooks');
		expect(out.verified).toBe(true);
		const conf = b.files.get(CONF)!;
		expect(renewalParam(conf, 'pre_hook')).toBe('docker stop caddy');
		expect(renewalParam(conf, 'post_hook')).toBe('docker start caddy');
		expect(b.works(conf)).toBe(true);
		const before = b.certbotCalls.length;
		const again = await b.run();
		expect(again.routine).toBe(true);
		expect(b.certbotCalls.length).toBe(before);
	});

	it('nothing works: the original settings stay byte for byte, and the expiry date and the command are given', async () => {
		const b = caddy();
		b.buildServed = false;
		b.edge = null;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(b.files.get(CONF)).toBe(STANDALONE);
		expect(out.detail).toContain('Dec 30 12:00:00 2026 GMT');
		expect(out.detail).toContain(
			`sudo certbot reconfigure --cert-name ${D} --webroot --webroot-path`
		);
	});

	it('hooks that do not make the dry run pass are taken back, byte for byte', async () => {
		const b = caddy();
		b.buildServed = false;
		b.hooksWork = false;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.strategy).toBe('left-alone');
		expect(b.files.get(CONF)).toBe(STANDALONE);
	});

	it('a served page that is not the probe (the app shell) is not taken as the challenge path', async () => {
		const b = caddy();
		b.buildServed = false;
		b.edge = null;
		await b.run();
		expect(b.certbotCalls.some((c) => c[0] === 'reconfigure')).toBe(false);
	});
});

describe('either way', () => {
	it("Let's Encrypt unreachable: nothing changed, said calmly", async () => {
		const b = new Box();
		b.reachable = false;
		const out = await b.run();
		expect(out.strategy).toBe('deferred');
		expect(b.files.get(CONF)).toBe(STANDALONE);
		expect(b.certbotCalls).toEqual([]);
	});

	it('port 80 free (no BunkerWeb): standalone works, left as it is', async () => {
		const b = new Box();
		b.owner = '';
		const out = await b.run();
		expect(out.strategy).toBe('already');
		expect(b.files.get(CONF)).toBe(STANDALONE);
	});

	it('no certificate that needs it: skipped', async () => {
		const b = new Box();
		b.files.clear();
		expect((await b.run()).strategy).toBe('skipped');
	});
});

describe('the settings text', () => {
	it('webroot: keeps everything else and rebuilds the webroot map', () => {
		const once = webrootSettings(STANDALONE, BUILD, [D, `www.${D}`]);
		const twice = webrootSettings(once, BUILD, [D]);
		expect(webrootMap(twice)).toEqual(new Map([[D, BUILD]]));
		expect(renewalParam(twice, 'webroot_path')).toBe(`${BUILD},`);
		expect(twice.match(/^authenticator = /gm)!.length).toBe(1);
		expect(
			setRenewalParams(twice, { pre_hook: 'x' })
				.split('\n')
				.filter((l) => l.startsWith('pre_hook')).length
		).toBe(1);
	});

	it('BunkerWeb’s folder: certbot’s own keys, the pause and any webroot gone, the rest kept', () => {
		const from = webrootSettings(PAUSED, BUILD, [D]);
		const s = bunkerWebSettings(from);
		expect(renewalParam(s, 'authenticator')).toBe('manual');
		expect(renewalParam(s, 'manual_auth_hook')).toBe(AUTH_HOOK);
		expect(renewalParam(s, 'manual_cleanup_hook')).toBe(CLEANUP_HOOK);
		expect(renewalParam(s, 'pref_challs')).toBe('http-01,');
		expect(renewalParam(s, 'pre_hook')).toBeNull();
		expect(renewalParam(s, 'webroot_path')).toBeNull();
		expect(webrootMap(s).size).toBe(0);
		expect(s).toContain('account = 0123abcd');
		expect(rendersBunkerWeb(s)).toBe(true);
		expect(rendersBunkerWeb(setRenewalParams(s, { pre_hook: 'docker stop bunkerweb' }))).toBe(
			false
		);
		expect(bunkerWebSettings(s)).toBe(s);
	});

	it('the heal’s own pause is told from an operator’s hooks', () => {
		expect(ownPauseHooks(PAUSED)).toBe('bunkerweb');
		expect(ownPauseHooks(STANDALONE)).toBeNull();
		expect(
			ownPauseHooks(PAUSED.replace('docker start bunkerweb', 'docker start other'))
		).toBeNull();
		expect(ownPauseHooks(PAUSED.replace('docker stop bunkerweb', '/root/x.sh'))).toBeNull();
	});

	it('the hooks put the file where BunkerWeb serves it from', () => {
		expect(EDGE_ACME_DIR).toBe('/var/tmp/bunkerweb/lets-encrypt/.well-known/acme-challenge');
	});
});
