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
	run() {
		return healNginxVhosts(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
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
