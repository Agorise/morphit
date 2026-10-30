/**
 * `morphit-ops ssl` (menu: SSL/TLS certificate) on an installed node, review
 * 2026-10-29:
 *  - H2: it looked for the domain in the directory it ran in (the launcher runs
 *    it inside apps/ops-cli) and only under the relay/indexer PUBLIC_ORIGIN
 *    keys, so every guided install got "Could not determine your domain";
 *  - M11: it recommended `certbot --nginx` / `--standalone` (both fail while
 *    BunkerWeb holds port 80) and called renewal "active" from the timer alone;
 *  - L9: with no certificate it showed only the status, not the steps;
 *  - L8: any argument was taken as a domain, and an unreadable
 *    /etc/letsencrypt read as "No certificate found".
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSsl } from '../src/commands/ssl.ts';

let out = '';
let root = '';
let le = '';
beforeEach(() => {
	out = '';
	vi.spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void (out += a.join(' ') + '\n')
	);
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
	root = mkdtempSync(join(tmpdir(), 'morphit-ssl-'));
	writeFileSync(join(root, 'package.json'), '{"name":"x","workspaces":[]}');
	// What a guided install writes: the origin in morphit.config.env only.
	writeFileSync(
		join(root, 'morphit.config.env'),
		'MORPHIT_INSTANCE_ORIGIN=https://trade.alice.net\n'
	);
	writeFileSync(join(root, 'morphit.env'), 'MORPHIT_RELAY_ACCOUNT=alice-relay\n');
	mkdirSync(join(root, 'etc'));
	le = join(root, 'letsencrypt');
	mkdirSync(join(le, 'live'), { recursive: true });
	mkdirSync(join(le, 'renewal'), { recursive: true });
	for (const k of [
		'MORPHIT_INSTANCE_ORIGIN',
		'MORPHIT_RELAY_PUBLIC_ORIGIN',
		'MORPHIT_INDEXER_PUBLIC_ORIGIN'
	])
		vi.stubEnv(k, '');
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const bunker = (presence: string) => async () =>
	({ presence, configDir: true, dockerError: null }) as never;

function ssl(positional: string[], deps: Record<string, unknown> = {}) {
	return runSsl({ flags: {}, positional, colorEnabled: false }, {
		repoRoot: root,
		etcDir: join(root, 'etc'),
		letsencryptDir: le,
		detectBunkerWeb: bunker('running'),
		timerState: async () => 'active',
		which: async () => true,
		readCertNotAfter: async () => null,
		hiddenOnly: () => false,
		...deps
	} as never);
}

function withCert(authenticator: string): void {
	mkdirSync(join(le, 'live', 'trade.alice.net'), { recursive: true });
	writeFileSync(join(le, 'live', 'trade.alice.net', 'fullchain.pem'), 'x');
	writeFileSync(
		join(le, 'renewal', 'trade.alice.net.conf'),
		`version = 2.9.0\n[renewalparams]\nauthenticator = ${authenticator}\naccount = abc\n`
	);
}

describe('ssl on an installed node', () => {
	it("finds the domain in the install's morphit.config.env", async () => {
		await ssl([]);
		expect(out).toMatch(/Domain: trade\.alice\.net/);
		expect(out).not.toMatch(/Could not determine your domain/);
	});

	it('falls back to /etc/morphit/indexer.env', async () => {
		writeFileSync(join(root, 'morphit.config.env'), '');
		writeFileSync(
			join(root, 'etc', 'indexer.env'),
			'MORPHIT_INDEXER_PUBLIC_ORIGIN=https://bob.example.net\n'
		);
		await ssl([]);
		expect(out).toMatch(/Domain: bob\.example\.net/);
	});

	it('no certificate, BunkerWeb running: the steps follow, through BunkerWeb (webroot)', async () => {
		await ssl([]);
		expect(out).toMatch(/No certificate found/);
		expect(out).toContain(
			`sudo certbot certonly --webroot --webroot-path ${root}/apps/web/build --cert-name trade.alice.net -d trade.alice.net`
		);
		expect(out).not.toMatch(/certbot --nginx|--standalone/);
	});

	it('a certificate that renews with standalone while BunkerWeb holds port 80 is flagged, with the fix', async () => {
		withCert('standalone');
		await ssl([], { readCertNotAfter: async () => new Date(Date.now() + 60 * 86_400_000) });
		expect(out).toMatch(/Certificate valid/);
		expect(out).toMatch(/cannot work while BunkerWeb holds port 80/);
		expect(out).toContain(
			`sudo certbot reconfigure --cert-name trade.alice.net --webroot --webroot-path ${root}/apps/web/build`
		);
	});

	it('a webroot renewal is reported as fine', async () => {
		withCert('webroot');
		await ssl([], { readCertNotAfter: async () => new Date(Date.now() + 60 * 86_400_000) });
		expect(out).toMatch(/renews through the web build/);
		expect(out).not.toMatch(/will fail/);
	});

	it('an argument that is not a domain is refused', async () => {
		const code = await ssl(['status', 'https://trade.alice.net/x']);
		expect(code).toBe(1);
		expect(out).toMatch(/is not a domain name/);
		expect(out).not.toMatch(/No certificate found/);
	});

	it('certificates it cannot look at are not "No certificate found"', async () => {
		const blocked = join(root, 'not-a-dir');
		writeFileSync(blocked, '');
		await ssl([], { letsencryptDir: blocked });
		expect(out).toMatch(/can only be read as root.*sudo morphit-ops ssl/);
		expect(out).not.toMatch(/No certificate found/);
	});

	it('a .onion needs no certificate', async () => {
		await ssl(['status', `${'a'.repeat(56)}.onion`]);
		expect(out).toMatch(/needs no HTTPS certificate/);
	});

	describe('renewing a certificate certbot does not know how to renew: never a second "-0001" one', () => {
		/** A real certificate for the domain and www.<domain> in live/. */
		function realCert(): void {
			const dir = join(le, 'live', 'trade.alice.net');
			mkdirSync(dir, { recursive: true });
			const r = spawnSync('openssl', [
				'req',
				'-x509',
				'-newkey',
				'ec',
				'-pkeyopt',
				'ec_paramgen_curve:prime256v1',
				'-nodes',
				'-keyout',
				join(dir, 'privkey.pem'),
				'-out',
				join(dir, 'fullchain.pem'),
				'-days',
				'30',
				'-subj',
				'/CN=trade.alice.net',
				'-addext',
				'subjectAltName=DNS:trade.alice.net,DNS:www.trade.alice.net'
			]);
			expect(r.status).toBe(0);
		}
		const valid = { readCertNotAfter: async () => new Date(Date.now() + 60 * 86_400_000) };

		it('its renewal file has no way to renew: renewed BY NAME, no -d (keeps www)', async () => {
			realCert();
			writeFileSync(
				join(le, 'renewal', 'trade.alice.net.conf'),
				'version = 2.9.0\n[renewalparams]\naccount = abc\n'
			);
			await ssl([], valid);
			expect(out).toMatch(/do not say how to renew it/);
			const fix = /Fix it, on this server:\s+(.*)/.exec(out)?.[1] ?? '';
			expect(fix).toBe(
				`sudo certbot certonly --cert-name trade.alice.net --force-renewal --webroot --webroot-path ${root}/apps/web/build`
			);
			expect(fix).not.toMatch(/ -d /);
		});

		it('certbot does not know it at all: its files are moved aside, certbot issues it under the same name with all its names, and they come back if that fails', async () => {
			realCert();
			mkdirSync(join(le, 'archive', 'trade.alice.net'), { recursive: true });
			writeFileSync(join(le, 'archive', 'trade.alice.net', 'cert1.pem'), 'old');
			await ssl([], valid);
			const fix = /Fix it, on this server:\s+(.*)/.exec(out)?.[1] ?? '';
			expect(fix).toContain(
				'certbot certonly --cert-name trade.alice.net -d trade.alice.net -d www.trade.alice.net --webroot'
			);
			// Run it, on a copy of /etc/letsencrypt, with a certbot that fails, then one that works.
			const bin = mkdtempSync(join(tmpdir(), 'morphit-certbot-'));
			const run = (certbotBody: string) => {
				writeFileSync(join(bin, 'certbot'), `#!/bin/sh\n${certbotBody}\n`);
				chmodSync(join(bin, 'certbot'), 0o755);
				return spawnSync(
					'sh',
					[
						'-c',
						fix
							.replace(/^sudo sh -c /, '')
							.replace(/^'|'$/g, '')
							.replaceAll('/etc/letsencrypt', le)
					],
					{
						env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
						encoding: 'utf8'
					}
				);
			};
			const failed = run('exit 1');
			expect(failed.status).toBe(1);
			expect(readFileSync(join(le, 'live', 'trade.alice.net', 'fullchain.pem'), 'utf8')).toMatch(
				/BEGIN CERTIFICATE/
			);
			expect(readFileSync(join(le, 'archive', 'trade.alice.net', 'cert1.pem'), 'utf8')).toBe('old');
			const worked = run(
				'mkdir -p live/trade.alice.net && echo new > live/trade.alice.net/fullchain.pem'
			);
			expect(worked.status, worked.stderr).toBe(0);
			expect(readFileSync(join(le, 'live', 'trade.alice.net', 'fullchain.pem'), 'utf8')).toBe(
				'new\n'
			);
			expect(
				readFileSync(join(le, 'archive', 'trade.alice.net.unmanaged', 'cert1.pem'), 'utf8')
			).toBe('old');
		});
	});
});
