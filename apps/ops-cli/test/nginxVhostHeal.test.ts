/**
 * The bare-metal nginx heal: the pure planner on a vhost as earlier releases
 * shipped it (and on the shipped configs, where it must change nothing), and
 * the heal's decisions against a simulated box (nginx -t, reload, what nginx
 * loaded, what it answers). The same planner run on the previous release's
 * ops/nginx/*.conf and then served by a real nginx 1.24 passes every check of
 * scripts/nginx-served-hardening-smoke.ts (recorded in the fix log).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	dnsPrefetchWithCsp,
	dumpSections,
	healNginxVhosts,
	isMorphitVhost,
	planVhost,
	vhostLoadedOk,
	type VhostRuntime
} from '../src/lib/nginxVhostHeal.ts';
import { MORPHIT_CSP } from '../src/lib/proxyConfigHeal.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const shipped = (f: string): string => readFileSync(join(REPO, 'ops/nginx', f), 'utf8');

const OLD_CSP = MORPHIT_CSP.replace(
	"script-src 'self' 'wasm-unsafe-eval'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
).replace("connect-src 'self'", "connect-src 'self' https://rpc.blurt.one");

/** A vhost as an earlier release shipped it (shape of web.conf + indexer.conf). */
const OLD = `limit_conn_zone $binary_remote_addr zone=web_conn:10m;
server {
    listen 443 ssl;
    http2 on;
    server_name trade.example.org;
    limit_conn web_conn 40;
    add_header X-Frame-Options "DENY" always;
    add_header Content-Security-Policy "${OLD_CSP}" always;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    location = /v1/health {
        add_header Cache-Control "no-store" always;
        proxy_pass http://127.0.0.1:8081;
    }
    location /relay/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header X-Real-IP "";
    }
    location /ipfs/ {
        proxy_pass http://127.0.0.1:8082;
        proxy_set_header Host $host;
    }
}
`;

describe("the bare-metal site's page CSP lets browsers connect to this site only (v1.21.14)", () => {
	const v1_21_13 = (connect: string): string => MORPHIT_CSP.replace("connect-src 'self'", connect);
	const CLEAR = v1_21_13(
		"connect-src 'self' https://rpc.drakernoise.com https://blurtrpc.dagobert.uk https://rpc.blurt.blog https://rpc.beblurt.com https://blurt-rpc.saboin.com"
	);
	const ONION = v1_21_13(
		"connect-src 'self' http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091"
	);
	const site = (a: string, b: string): string => `server {
    listen 443 ssl http2;
    server_name trade.example.org;
    server_tokens off;
    add_header Content-Security-Policy "${a}" always;
}
server {
    listen 127.0.0.1:8090;
    server_name abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion;
    server_tokens off;
    add_header Content-Security-Policy "${b}" always;
}
`;
	it("v1.21.13's node lists, clearnet and .onion, become this release's policy", () => {
		const old = site(CLEAR, ONION);
		expect(vhostLoadedOk(old).why).toContain(
			"a page CSP still lets visitors' browsers connect to Blurt RPC nodes"
		);
		const p = planVhost(old);
		expect(p.text).not.toContain('rpc.drakernoise.com');
		expect(p.text).not.toContain('.onion:8091');
		expect(
			p.text.split(`add_header Content-Security-Policy "${MORPHIT_CSP}" always;`)
		).toHaveLength(3);
		expect(vhostLoadedOk(p.text).ok).toBe(true);
	});
	it("an operator's own connect-src (their indexer subdomain) is kept", () => {
		const own = MORPHIT_CSP.replace(
			"connect-src 'self'",
			"connect-src 'self' https://indexer.trade.example.org"
		);
		const p = planVhost(site(own, own));
		expect(p.text).toContain('https://indexer.trade.example.org');
		expect(vhostLoadedOk(p.text).ok).toBe(true);
	});
});

describe('the bare-metal nginx site heals like a fresh copy (planner)', () => {
	it('an earlier vhost: every gap closed, and what nginx would load passes', () => {
		expect(vhostLoadedOk(OLD).ok).toBe(false);
		const p = planVhost(OLD);
		expect(vhostLoadedOk(p.text)).toEqual({ ok: true, why: [] });
		expect(p.text).toContain(`add_header Content-Security-Policy "${MORPHIT_CSP}" always;`);
		expect(p.text).not.toMatch(/^\s*http2 on;/m);
		expect(p.text).toContain('listen 443 ssl http2;');
		expect(p.text).toMatch(
			/server \{\n {4}server_tokens off;\n {4}error_log stderr crit;\n {4}limit_conn_log_level info;/
		);
		expect(planVhost(p.text).text).toBe(p.text); // idempotent
	});

	it("the web vhost's cap of 40 downloads at once (as shipped) becomes 256; an operator's own number is kept", () => {
		const p = planVhost(OLD);
		expect(p.text).toMatch(/^ {4}limit_conn web_conn 256;$/m);
		expect(p.text).not.toMatch(/limit_conn web_conn 40;/);
		expect(p.changes).toContain('a visitor may download 256 files at once (was 40)');
		expect(vhostLoadedOk(OLD).why).toContain('a visitor may still download only 40 files at once');
		const own = OLD.replace('limit_conn web_conn 40;', 'limit_conn web_conn 64;');
		expect(planVhost(own).text).toMatch(/^ {4}limit_conn web_conn 64;$/m);
		// Another zone with 40 (relay.conf's own cap) is not the web vhost's.
		const relay = OLD.replace(/web_conn/g, 'relay_conn');
		expect(planVhost(relay).text).toMatch(/limit_conn relay_conn 40;/);
	});

	it('headers go where nginx takes them from: inherited list stays whole, a location with its own list gets them', () => {
		const p = planVhost(OLD).text;
		// /v1/health has no proxy_set_header of its own: the server-level list
		// (with Host and X-Forwarded-For) must still be the one it uses.
		const health = /location = \/v1\/health \{([\s\S]*?)\n {4}\}/.exec(p)![1]!;
		expect(health).not.toMatch(/proxy_set_header/);
		const server = p.slice(0, p.indexOf('location'));
		for (const h of ['X-Morphit-Local-Health', 'X-I2P-DestB64', 'X-I2P-DestB32', 'X-I2P-DestHash'])
			expect(server).toContain(`proxy_set_header ${h} "";`);
		const relay = /location \/relay\/ \{([\s\S]*?)\n {4}\}/.exec(p)![1]!;
		expect(relay).toContain('proxy_set_header X-I2P-DestB32 "";');
		expect(relay).toContain('proxy_set_header X-Real-IP "";');
	});

	it('a location with its own add_header gets the security headers back; the IPFS gateway is asked for itself', () => {
		const p = planVhost(OLD).text;
		const health = /location = \/v1\/health \{([\s\S]*?)\n {4}\}/.exec(p)![1]!;
		expect(health).toContain('add_header X-Frame-Options "DENY" always;');
		expect(health).toContain(`add_header Content-Security-Policy "${MORPHIT_CSP}" always;`);
		const ipfs = /location \/ipfs\/ \{([\s\S]*?)\n {4}\}/.exec(p)![1]!;
		expect(ipfs).toContain('proxy_set_header Host 127.0.0.1;');
		expect(ipfs).not.toContain('$host');
	});

	it("an operator's own values are kept: their error_log, server_tokens and CSP", () => {
		const own = OLD.replace(
			'    limit_conn web_conn 40;\n',
			'    limit_conn web_conn 40;\n    error_log /var/log/nginx/mine.log warn;\n    server_tokens build;\n'
		).replace(`"${OLD_CSP}"`, `"default-src 'self'; script-src 'self' https://cdn.example.org"`);
		const p = planVhost(own).text;
		expect(p).toContain('error_log /var/log/nginx/mine.log warn;');
		expect(p).toContain('server_tokens build;');
		expect(p).not.toContain('error_log stderr crit;');
		expect(p).toContain(`script-src 'self' https://cdn.example.org"`);
	});

	it('web.conf as v1.21.11 shipped it: an account name ending like a file reaches the API and the app', () => {
		const old = readFileSync(join(import.meta.dirname, 'fixtures', 'web.conf.v1.21.11'), 'utf8');
		expect(vhostLoadedOk(old).why).toContain(
			"an account name ending like a file (such as bob.old) still gets nginx's 404"
		);
		const p = planVhost(old);
		expect(p.changes).toContain(
			"an account name ending like a file (such as bob.old) reaches the indexer and the app, not nginx's 404"
		);
		expect(vhostLoadedOk(p.text).why).not.toContain(
			"an account name ending like a file (such as bob.old) still gets nginx's 404"
		);
		const at = (re: RegExp): number => p.text.search(re);
		const lang = at(/^ {4}location ~\* "\^\/\[a-z\]\{2\}/m);
		const svg = at(/^ {4}location ~\* \^\/\(\?!_app\/\|v1\/\|relay\/\)\.\*\\\.svg\$ \{$/m);
		const left = at(/^ {4}location ~\* \^\/\(\?!v1\/\|relay\/\)\.\*\\\.\(env/m);
		// nginx takes the FIRST regex that matches: the language rule leads.
		expect(lang).toBeGreaterThan(0);
		expect(svg).toBeGreaterThan(lang);
		expect(left).toBeGreaterThan(lang);
		expect(p.text.match(/error_page 418 = @spa;/g)).toHaveLength(1);
		// The same rules as today's shipped file, and nothing more to do.
		for (const line of shipped('web.conf')
			.split('\n')
			.filter((l) => /^\s*location ~\*.*(env\|git|svg\$)/.test(l)))
			expect(p.text).toContain(line);
		expect(planVhost(p.text).text).toBe(p.text);
	});

	it('the old leftover rule in a vhost that serves no app page (indexer.conf shape) is left alone', () => {
		const api = `server {\n    listen 443 ssl;\n    server_tokens off;\n    error_log stderr crit;\n    location ~* \\.(env|git|sql|bak|old|orig|swp|tmp)$ {\n        return 404;\n    }\n    location /v1/ {\n        proxy_pass http://127.0.0.1:8081;\n        proxy_set_header X-Morphit-Local-Health "";\n        proxy_set_header X-I2P-DestB64 "";\n        proxy_set_header X-I2P-DestB32 "";\n        proxy_set_header X-I2P-DestHash "";\n    }\n}\n`;
		expect(planVhost(api).text).toBe(api);
	});

	it('the shipped configs need nothing; they are Morphit sites, an unrelated site is not', () => {
		for (const f of ['web.conf', 'relay.conf', 'indexer.conf']) {
			expect(isMorphitVhost(shipped(f))).toBe(true);
			expect(planVhost(shipped(f)).changes).toEqual([]);
			expect(vhostLoadedOk(shipped(f))).toEqual({ ok: true, why: [] });
		}
		expect(
			isMorphitVhost('server { listen 80; location / { proxy_pass http://127.0.0.1:3000; } }')
		).toBe(false);
		expect(isMorphitVhost('# proxy_pass http://127.0.0.1:8081;\n')).toBe(false);
	});

	it('reads only the Morphit files out of nginx -T', () => {
		const dump = `# configuration file /etc/nginx/nginx.conf:\nhttp { server { listen 80; } }\n# configuration file /etc/nginx/sites-enabled/morphit:\n${planVhost(OLD).text}`;
		expect(vhostLoadedOk(dump).ok).toBe(false); // the default site shows its version
		expect(vhostLoadedOk(dumpSections(dump, ['/etc/nginx/sites-enabled/morphit'])).ok).toBe(true);
	});
});

const SITE = '/etc/nginx/sites-available/morphit';
class Box {
	files = new Map<string, string>([[SITE, OLD]]);
	loaded = OLD;
	active = true;
	testOk = (t: string): boolean => !/^\s*http2 on;/m.test(t);
	reloadTakes = true;
	/** What nginx really loads, when it is not the file the heal edited. */
	loads: ((edited: string) => string) | null = null;
	reloads = 0;
	restarts = 0;
	backups = new Map<string, string>();
	readonly rt: VhostRuntime = {
		nginxActive: () => this.active,
		vhosts: () => [...this.files].map(([path, text]) => ({ path, text })),
		writeFile: (p, t) => (this.files.set(p, t), true),
		backup: (p) => {
			const b = `/var/backups/${this.backups.size}`;
			this.backups.set(b, this.files.get(p)!);
			return b;
		},
		restore: (b, p) => (this.files.set(p, this.backups.get(b)!), true),
		test: () => {
			const ok = [...this.files.values()].every(this.testOk);
			return {
				ok,
				out: ok ? 'syntax is ok' : 'nginx: [emerg] something in /etc/nginx/sites-enabled/morphit:3'
			};
		},
		reload: () => {
			this.reloads++;
			if (this.reloadTakes) this.loaded = (this.loads ?? ((t) => t))(this.files.get(SITE)!);
			return true;
		},
		restart: () => (this.restarts++, (this.loaded = this.files.get(SITE)!), true),
		dumpConfig: () => `# configuration file ${SITE}:\n${this.loaded}`,
		serverHeader: () =>
			/^\s*server_tokens off;/m.test(this.loaded) ? 'nginx' : 'nginx/1.24.0 (Ubuntu)',
		oldClientLines: () => 3,
		sleep: async () => {}
	};
	warned: string[] = [];
	run() {
		return healNginxVhosts(
			{ info: () => {}, warn: (m) => this.warned.push(m), spinner: () => () => {} },
			{ runtime: this.rt }
		);
	}
}

describe('the bare-metal nginx heal on a box', () => {
	it('updates, checks with nginx -t, reloads, and sees it in what nginx loaded and answers', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'reloaded', verified: true });
		expect(b.reloads).toBe(1);
		expect(out.detail).toMatch(
			/seen in what nginx loaded and in its answers for trade\.example\.org/
		);
		expect(out.detail).toContain('3 older line(s)');
		expect(out.detail).toContain('on this server run:');
		expect((await b.run()).strategy).toBe('already');
		expect(b.reloads).toBe(1);
	});

	it('nginx -t refuses the result: every file back byte for byte, nothing reloaded', async () => {
		const b = new Box();
		b.testOk = () => false;
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'left-alone', verified: false });
		expect(b.files.get(SITE)).toBe(OLD);
		expect(b.reloads).toBe(0);
		expect(out.detail).toContain('[emerg]');
	});

	it('a reload that did not take: restarted once, then verified', async () => {
		const b = new Box();
		b.reloadTakes = false;
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'restarted', verified: true });
		expect(b.restarts).toBe(1);
	});

	it('nginx answers without its version but loaded a site that still passes the headers on: not reported as done', async () => {
		const b = new Box();
		b.loads = (t) => t.replace(/\n\s*proxy_set_header X-I2P-DestB32 "";/g, '');
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toMatch(/internal headers passed on/);
		expect(out.detail).toContain('sudo nginx -t && sudo systemctl reload nginx');
	});

	it('no nginx, or no Morphit site in it: nothing touched', async () => {
		const a = new Box();
		a.active = false;
		expect((await a.run()).strategy).toBe('skipped');
		const b = new Box();
		b.files = new Map([
			['/etc/nginx/sites-available/default', 'server { listen 80; root /var/www/html; }']
		]);
		expect((await b.run()).strategy).toBe('skipped');
		expect(b.reloads).toBe(0);
	});
});

/** A page-serving vhost (web.conf's shape): the CSP at server level and in a
 *  location that sets its own headers, before X-DNS-Prefetch-Control. */
const PAGES = `server {
    listen 443 ssl http2;
    server_name trade.example.org;
    server_tokens off;
    error_log stderr crit;
    root /var/www/morphit-frontend;
    add_header X-Frame-Options "DENY" always;
    add_header Content-Security-Policy "${MORPHIT_CSP}" always;
    location /_app/immutable/ {
        add_header Cache-Control "public, immutable, max-age=31536000" always;
        add_header X-Frame-Options "DENY" always;
        add_header Content-Security-Policy "${MORPHIT_CSP}" always;
    }
    location /fonts/ {
        add_header Cache-Control "public, max-age=2592000" always;
    }
    location / {
        try_files $uri @spa;
    }
}
`;

describe('pages send X-DNS-Prefetch-Control: off wherever they send the CSP (bare metal)', () => {
	/** The body of the block that starts with `head` (up to its closing brace). */
	const block = (t: string, head: string): string => {
		const at = t.indexOf(`${head} {`);
		return t.slice(at, t.indexOf('\n    }', at));
	};
	it('added at server level and in every location that sets its own headers; checked in what nginx loads', () => {
		expect(dnsPrefetchWithCsp(PAGES)).toBe(false);
		expect(vhostLoadedOk(PAGES).ok).toBe(false);
		const p = planVhost(PAGES);
		const server = p.text.slice(0, p.text.indexOf('location'));
		expect(server).toContain('add_header X-DNS-Prefetch-Control "off" always;');
		expect(block(p.text, 'location /_app/immutable/')).toContain(
			'add_header X-DNS-Prefetch-Control "off" always;'
		);
		// a location that sets its own headers also gets the CSP back, and the header with it
		expect(block(p.text, 'location /fonts/')).toContain(
			'add_header X-DNS-Prefetch-Control "off" always;'
		);
		expect(block(p.text, 'location /fonts/')).toContain('add_header Content-Security-Policy');
		expect(dnsPrefetchWithCsp(p.text)).toBe(true);
		expect(vhostLoadedOk(p.text)).toEqual({ ok: true, why: [] });
		expect(planVhost(p.text).text).toBe(p.text); // idempotent
	});
	it("an operator's own value is kept (and repeated where nginx would drop it), never replaced", () => {
		const own = PAGES.replace(
			'    add_header X-Frame-Options "DENY" always;\n    add_header Content-Security-Policy',
			'    add_header X-Frame-Options "DENY" always;\n    add_header X-DNS-Prefetch-Control "on" always;\n    add_header Content-Security-Policy'
		);
		expect(own).not.toBe(PAGES);
		const p = planVhost(own).text;
		expect(p).not.toContain('X-DNS-Prefetch-Control "off"');
		expect(block(p, 'location /_app/immutable/')).toContain(
			'add_header X-DNS-Prefetch-Control "on" always;'
		);
		expect(dnsPrefetchWithCsp(p)).toBe(true);
	});
	it('a CSP set only in a location (none at server level): that location gets it', () => {
		const loc = PAGES.replace(
			`    add_header Content-Security-Policy "${MORPHIT_CSP}" always;\n    location /_app`,
			'    location /_app'
		);
		expect(loc).not.toBe(PAGES);
		const p = planVhost(loc).text;
		expect(p.slice(0, p.indexOf('location'))).not.toContain('X-DNS-Prefetch-Control');
		expect(block(p, 'location /_app/immutable/')).toContain(
			'add_header X-DNS-Prefetch-Control "off" always;'
		);
		expect(dnsPrefetchWithCsp(loc)).toBe(false);
		expect(dnsPrefetchWithCsp(p)).toBe(true);
	});
	it('a vhost that serves no page (the API: indexer.conf, relay.conf) is not given it', () => {
		const api = PAGES.replace('    root /var/www/morphit-frontend;\n', '').replace(
			'        try_files $uri @spa;',
			'        proxy_pass http://127.0.0.1:8081;'
		);
		expect(dnsPrefetchWithCsp(api)).toBe(true);
		expect(planVhost(api).text).not.toContain('X-DNS-Prefetch-Control');
	});
});

describe("an operator's own page CSP that lets browsers connect elsewhere (bare metal)", () => {
	const own = MORPHIT_CSP.replace(
		"connect-src 'self'",
		"connect-src 'self' https://indexer.trade.example.org"
	);
	it('is kept, and the heal warns naming the source and the file, on every run', async () => {
		const b = new Box();
		b.files.set(SITE, OLD.replace(`"${OLD_CSP}"`, `"${own}"`));
		await b.run();
		expect(b.files.get(SITE)).toContain(own);
		expect(b.warned).toHaveLength(1);
		expect(b.warned[0]).toContain('https://indexer.trade.example.org');
		expect(b.warned[0]).toContain(SITE);
		await b.run();
		expect(b.warned).toHaveLength(2);
	});
	it("Morphit's policy, of this or an earlier release: no such warning", async () => {
		const b = new Box();
		await b.run();
		expect(b.warned).toEqual([]);
	});
});
