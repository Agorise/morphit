/**
 * The TLS renewal heal against a simulated box: certbot's renewal
 * files, who holds port 80, whether the web build answers the ACME path, and
 * a certbot whose dry run passes only when the renewal settings would really
 * work here (webroot that is served, or hooks that free port 80). The real
 * certbot 2.9.0 + Pebble + nginx run that proved the webroot path end to end
 * is recorded in the fix log; this pins the heal's decisions.
 */
import { describe, expect, it } from 'vitest';
import {
	healTlsRenewal,
	renewalParam,
	rendersWebroot,
	setRenewalParams,
	webrootMap,
	webrootSettings,
	type TlsRuntime
} from '../src/lib/tlsRenewHeal.ts';

const BUILD = '/opt/morphit/apps/web/build';
const CONF = '/etc/letsencrypt/renewal/trade.example.org.conf';
const STANDALONE = `# renew_before_expiry = 30 days
version = 2.9.0
archive_dir = /etc/letsencrypt/archive/trade.example.org
cert = /etc/letsencrypt/live/trade.example.org/cert.pem

# Options used in the renewal process
[renewalparams]
account = 0123abcd
authenticator = standalone
server = https://acme-v02.api.letsencrypt.org/directory
key_type = ecdsa
`;

class Box {
	files = new Map<string, string>([[CONF, STANDALONE]]);
	owner = 'docker-proxy';
	reachable = true;
	/** Does BunkerWeb → frontend serve <build>/.well-known/acme-challenge/? */
	served = true;
	version = 'certbot 2.9.0';
	edge: string | null = 'bunkerweb';
	/** Does stopping the edge really free port 80 (another program may hold it)? */
	hooksWork = true;
	certbotCalls: string[][] = [];
	probesLeft = 0;
	/** Would a renewal with this config work on this box? */
	works(text: string): boolean {
		const auth = renewalParam(text, 'authenticator');
		if (auth === 'webroot')
			return this.served && webrootMap(text).get('trade.example.org') === BUILD;
		if (auth === 'standalone')
			return (
				this.owner === '' ||
				(this.hooksWork && renewalParam(text, 'pre_hook') === `docker stop ${this.edge}`)
			);
		return false;
	}
	readonly rt: TlsRuntime = {
		renewalConfs: () =>
			[...this.files]
				.filter(([p]) => p.startsWith('/etc/letsencrypt/renewal/'))
				.map(([path, text]) => ({ path, text })),
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, t) => (this.files.set(p, t), true),
		removeFile: (p) => void this.files.delete(p),
		port80Owner: () => this.owner,
		certInfo: () => ({ domains: ['trade.example.org'], notAfter: 'Dec 30 12:00:00 2026 GMT' }),
		localGet: (_d, path) => {
			if (!this.served) return '<html>app</html>';
			const f = this.files.get(`${BUILD}${path}`);
			return f ?? null;
		},
		acmeReachable: () => this.reachable,
		certbot: (args) => {
			this.certbotCalls.push([...args]);
			if (args[0] === '--version') return { ok: true, out: this.version };
			if (args[0] === 'reconfigure') {
				const want = webrootSettings(
					this.files.get(CONF)!,
					args[args.indexOf('--webroot-path') + 1]!,
					['trade.example.org']
				);
				if (!this.works(want)) return { ok: false, out: 'Some challenges have failed.' };
				this.files.set(CONF, want); // saved only after the dry run passed
				return { ok: true, out: 'The dry run was successful.' };
			}
			if (args[0] === 'renew') return { ok: this.works(this.files.get(CONF)!), out: '' };
			return { ok: false, out: '' };
		},
		port80Container: () => this.edge
	};
	run() {
		return healTlsRenewal(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ webroot: BUILD, runtime: this.rt }
		);
	}
	leftoverProbes(): string[] {
		return [...this.files.keys()].filter((k) => k.includes('/.well-known/acme-challenge/'));
	}
}

describe('the certificate renews while BunkerWeb holds port 80', () => {
	it('as installed (standalone, port 80 held) a renewal cannot work — the case the heal is for', () => {
		const b = new Box();
		expect(b.works(STANDALONE)).toBe(false);
	});

	it('switches to webroot through the web build with certbot reconfigure (a real dry run), read back', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(out.strategy).toBe('webroot');
		const conf = b.files.get(CONF)!;
		expect(rendersWebroot(conf, BUILD, 'trade.example.org')).toBe(true);
		expect(b.works(conf)).toBe(true);
		expect(b.certbotCalls.some((c) => c[0] === 'reconfigure')).toBe(true);
		expect(b.leftoverProbes()).toEqual([]);
		// the rest of the file is kept
		expect(conf).toContain('account = 0123abcd');
		expect(conf).toContain('archive_dir = /etc/letsencrypt/archive/trade.example.org');
		// second run: nothing left to do
		const again = await b.run();
		expect(again.strategy).toBe('skipped');
	});

	it('certbot older than 2.3 (no reconfigure): the heal writes webroot itself, keeps it only when the dry run passes', async () => {
		const b = new Box();
		b.version = 'certbot 1.21.0';
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.works(b.files.get(CONF)!)).toBe(true);
		expect(b.certbotCalls).toContainEqual([
			'renew',
			'--dry-run',
			'--no-random-sleep-on-renew',
			'--cert-name',
			'trade.example.org',
			'--non-interactive'
		]);
	});

	it('the web build does not answer the challenge path: hooks pause the edge for the renewal, checked by a dry run', async () => {
		const b = new Box();
		b.served = false;
		const out = await b.run();
		expect(out.strategy).toBe('hooks');
		expect(out.verified).toBe(true);
		const conf = b.files.get(CONF)!;
		expect(renewalParam(conf, 'pre_hook')).toBe('docker stop bunkerweb');
		expect(renewalParam(conf, 'post_hook')).toBe('docker start bunkerweb');
		expect(b.works(conf)).toBe(true);
		const before = b.certbotCalls.length;
		expect((await b.run()).strategy).toBe('skipped');
		expect(b.certbotCalls.length).toBe(before);
	});

	it('nothing works: the original settings stay byte for byte, and the expiry date and the command are given', async () => {
		const b = new Box();
		b.served = false;
		b.edge = null;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(b.files.get(CONF)).toBe(STANDALONE);
		expect(out.detail).toContain('Dec 30 12:00:00 2026 GMT');
		expect(out.detail).toContain(
			'sudo certbot reconfigure --cert-name trade.example.org --webroot --webroot-path'
		);
	});

	it('hooks that do not make the dry run pass are taken back, byte for byte', async () => {
		const b = new Box();
		b.served = false;
		b.hooksWork = false;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.strategy).toBe('left-alone');
		expect(b.files.get(CONF)).toBe(STANDALONE);
	});

	it('a served page that is not the probe (the app shell) is not taken as the challenge path', async () => {
		const b = new Box();
		b.served = false;
		b.edge = null;
		await b.run();
		expect(b.certbotCalls.some((c) => c[0] === 'reconfigure')).toBe(false);
	});

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

	it('the settings text keeps everything else and rebuilds the webroot map', () => {
		const once = webrootSettings(STANDALONE, BUILD, ['trade.example.org', 'www.trade.example.org']);
		const twice = webrootSettings(once, BUILD, ['trade.example.org']);
		expect(webrootMap(twice)).toEqual(new Map([['trade.example.org', BUILD]]));
		expect(renewalParam(twice, 'webroot_path')).toBe(`${BUILD},`);
		expect(twice.match(/^authenticator = /gm)!.length).toBe(1);
		expect(
			setRenewalParams(twice, { pre_hook: 'x' })
				.split('\n')
				.filter((l) => l.startsWith('pre_hook')).length
		).toBe(1);
	});
});
