/**
 * `morphit-ops ssl` (beta5 item G) — SSL/TLS certificate (HTTPS).
 *
 * Before beta5 the only HTTPS guidance lived in OPERATIONS.md §35;
 * there was no menu entry, so operators didn't know it existed. This
 * command surfaces it:
 *
 *   - `ssl` / `ssl status` — READ-ONLY: is there a valid cert for your
 *     domain, when does it expire, and is auto-renewal actually
 *     running? (The renewal timer is "the part most operators get
 *     wrong" — §35.)
 *   - `ssl setup` — GUIDED: checks prerequisites and prints the exact
 *     certbot commands tailored to your domain. It does NOT run certbot
 *     or edit nginx itself — cert issuance mutates your web server and
 *     can't be safely validated from here, so (like `harden`) it hands
 *     you the precise steps to run. Same reason `install-services`
 *     stays a VM-validated checkpoint.
 *
 * Mirrors the established command shape (doctor/harden): read-only by
 * default, advisory, never breaks the box.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SslCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

// ─── PURE helpers (unit-tested) ─────────────────────────────────────

/** Extract the bare hostname from a public-origin URL. Returns null
 *  for anything that isn't a parseable http(s) URL with a host. */
export function domainFromOrigin(origin: string): string | null {
	const trimmed = origin.trim();
	if (trimmed === '') return null;
	try {
		const u = new URL(trimmed);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		return u.hostname === '' ? null : u.hostname;
	} catch {
		return null;
	}
}

/** Parse the `notAfter=...` date from `openssl x509 -enddate -noout`
 *  output (e.g. `notAfter=Jun  3 12:00:00 2026 GMT`). Returns null if
 *  not present/parseable. */
export function parseCertNotAfter(opensslOut: string): Date | null {
	const m = /notAfter=(.+)/.exec(opensslOut);
	if (!m) return null;
	const d = new Date(m[1]!.trim());
	return Number.isNaN(d.getTime()) ? null : d;
}

export type CertVerdictKind = 'none' | 'expired' | 'expiring' | 'valid';

export interface CertVerdict {
	readonly kind: CertVerdictKind;
	readonly daysRemaining: number | null;
	readonly message: string;
}

/** Classify a cert by its expiry. certbot renews within 30 days, so we
 *  treat <30 days as "expiring" (action may be needed if renewal isn't
 *  running). PURE. */
export function certVerdict(notAfter: Date | null, now: Date): CertVerdict {
	if (notAfter === null) {
		return {
			kind: 'none',
			daysRemaining: null,
			message: 'No certificate found for this domain. Run `morphit-ops ssl setup` to get one.'
		};
	}
	const days = Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000);
	if (days < 0) {
		return {
			kind: 'expired',
			daysRemaining: days,
			message: `Certificate EXPIRED ${Math.abs(days)} day(s) ago (on ${notAfter.toUTCString()}). HTTPS is broken until you renew.`
		};
	}
	if (days < 30) {
		return {
			kind: 'expiring',
			daysRemaining: days,
			message: `Certificate expires in ${days} day(s) (on ${notAfter.toUTCString()}). certbot renews within 30 days — confirm auto-renewal is active (below).`
		};
	}
	return {
		kind: 'valid',
		daysRemaining: days,
		message: `Certificate valid — expires in ${days} day(s) (on ${notAfter.toUTCString()}).`
	};
}

export interface CertbotCommands {
	readonly install: string;
	readonly nginxPlugin: string;
	readonly standalone: string;
	readonly verifyRenewal: string;
}

/** Build the exact certbot commands for a domain, matching OPERATIONS
 *  §35. PURE. The `<your-email>` placeholder is intentional — the
 *  operator substitutes their address. */
export function buildCertbotCommands(domain: string): CertbotCommands {
	return {
		install: 'sudo apt update && sudo apt install -y certbot python3-certbot-nginx',
		nginxPlugin: `sudo certbot --nginx -d ${domain} --agree-tos --email <your-email> --no-eff-email`,
		standalone:
			`sudo systemctl stop nginx && ` +
			`sudo certbot certonly --standalone -d ${domain} --agree-tos --email <your-email> --no-eff-email && ` +
			`sudo systemctl start nginx`,
		verifyRenewal: 'systemctl list-timers | grep certbot   # expect: certbot.timer  active'
	};
}

// ─── I/O (best-effort, never throws) ────────────────────────────────

async function which(bin: string): Promise<boolean> {
	const { spawnSync } = await import('node:child_process');
	const r = spawnSync('which', [bin], { stdio: 'pipe', timeout: 3000 });
	return r.status === 0;
}

/** Read the installed Let's Encrypt cert's expiry for a domain, via
 *  openssl on the standard live path. null if absent/unreadable. */
async function readInstalledCertNotAfter(domain: string): Promise<Date | null> {
	const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
	if (!existsSync(certPath)) return null;
	const { spawnSync } = await import('node:child_process');
	const r = spawnSync('openssl', ['x509', '-enddate', '-noout', '-in', certPath], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
		timeout: 5000
	});
	if (r.status !== 0 || typeof r.stdout !== 'string') return null;
	return parseCertNotAfter(r.stdout);
}

type TimerState = 'active' | 'inactive' | 'unknown';

/** Is certbot's auto-renewal timer active? Checks both the apt
 *  (certbot.timer) and snap (snap.certbot.renew.timer) unit names. */
async function renewalTimerState(): Promise<TimerState> {
	const { spawnSync } = await import('node:child_process');
	for (const unit of ['certbot.timer', 'snap.certbot.renew.timer']) {
		const r = spawnSync('systemctl', ['is-active', unit], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 3000
		});
		const out = (r.stdout ?? '').trim();
		if (out === 'active') return 'active';
		if (out === 'inactive' || out === 'failed') return 'inactive';
	}
	return 'unknown';
}

/** Read MORPHIT_*_PUBLIC_ORIGIN from morphit.env (+ config.env) by
 *  sourcing it the same faithful way the services do. Mirrors doctor's
 *  env read so the domain matches the real config. */
async function readPublicOrigin(installDir: string): Promise<string> {
	const envPath = join(installDir, 'morphit.env');
	if (!existsSync(envPath)) return '';
	const configEnvPath = join(installDir, 'morphit.config.env');
	const { spawnSync } = await import('node:child_process');
	const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const cfgPart = existsSync(configEnvPath) ? `. ${shq(configEnvPath)}; ` : '';
	const r = spawnSync(
		'bash',
		[
			'-c',
			`set -a; . ${shq(envPath)}; ${cfgPart}set +a; printf '%s' "\${MORPHIT_RELAY_PUBLIC_ORIGIN:-$MORPHIT_INDEXER_PUBLIC_ORIGIN}"`
		],
		{ encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }
	);
	return (r.stdout ?? '').trim();
}

// ─── Command ────────────────────────────────────────────────────────

function color(enabled: boolean) {
	const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
	return {
		green: wrap('32'),
		yellow: wrap('33'),
		red: wrap('31'),
		dim: wrap('2'),
		bold: wrap('1')
	};
}

export async function runSsl(ctx: SslCtx): Promise<number> {
	const c = color(ctx.colorEnabled);
	const json = ctx.flags.json === 'true';
	const installDir = process.cwd();
	const first = ctx.positional[0];
	const mode = first === 'setup' ? 'setup' : 'status';
	// The mode word ('status'/'setup') is optional. The domain is the
	// positional that isn't the mode word: positional[1] when a mode
	// word was given, else positional[0].
	const modeWordPresent = first === 'setup' || first === 'status';
	const explicit = modeWordPresent ? ctx.positional[1] : ctx.positional[0];
	let domain = explicit ?? null;
	if (domain === null) {
		const origin = await readPublicOrigin(installDir);
		domain = origin === '' ? null : domainFromOrigin(origin);
	}

	if (domain === null) {
		const msg =
			'Could not determine your domain. Set MORPHIT_RELAY_PUBLIC_ORIGIN (or ' +
			'MORPHIT_INDEXER_PUBLIC_ORIGIN) in morphit.env, or pass it explicitly: ' +
			'`morphit-ops ssl status yourdomain.com`.';
		if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
		else {
			console.log('');
			console.log(`  ${c.yellow('⚠')} ${msg}`);
			console.log('');
		}
		return 1;
	}

	if (mode === 'setup') return runSetup(c, json, domain);
	return runStatus(c, json, domain);
}

async function runStatus(
	c: ReturnType<typeof color>,
	json: boolean,
	domain: string
): Promise<number> {
	const notAfter = await readInstalledCertNotAfter(domain);
	const verdict = certVerdict(notAfter, new Date());
	const timer = await renewalTimerState();

	if (json) {
		console.log(
			JSON.stringify(
				{
					domain,
					cert: verdict.kind,
					days_remaining: verdict.daysRemaining,
					expires: notAfter ? notAfter.toISOString() : null,
					renewal_timer: timer
				},
				null,
				2
			)
		);
		return verdict.kind === 'expired' ? 1 : 0;
	}

	console.log('');
	console.log('━'.repeat(60));
	console.log('  SSL/TLS certificate (HTTPS)');
	console.log('━'.repeat(60));
	console.log('');
	console.log(`  Domain: ${c.bold(domain)}`);
	console.log('');
	const tag =
		verdict.kind === 'valid'
			? c.green('✓')
			: verdict.kind === 'expiring'
				? c.yellow('⚠')
				: c.red('✗');
	console.log(`  ${tag} ${verdict.message}`);
	console.log('');

	if (timer === 'active') {
		console.log(`  ${c.green('✓')} Auto-renewal is active (certbot.timer).`);
	} else if (timer === 'inactive') {
		console.log(`  ${c.yellow('⚠')} Auto-renewal timer is NOT active. Enable it:`);
		console.log('        sudo systemctl enable --now certbot.timer');
	} else {
		console.log(`  ${c.dim('•')} Could not determine the auto-renewal timer state (certbot may not be installed, or this host has no systemd). Verify manually:`);
		console.log('        systemctl list-timers | grep certbot');
	}
	console.log('');
	if (verdict.kind === 'none') {
		console.log(`  Next: ${c.bold('morphit-ops ssl setup')}`);
		console.log('');
	}
	console.log('━'.repeat(60));
	console.log('');
	return verdict.kind === 'expired' ? 1 : 0;
}

async function runSetup(
	c: ReturnType<typeof color>,
	json: boolean,
	domain: string
): Promise<number> {
	const cmds = buildCertbotCommands(domain);
	const hasCertbot = await which('certbot');
	const hasNginx = await which('nginx');

	if (json) {
		console.log(
			JSON.stringify(
				{ domain, certbot_installed: hasCertbot, nginx_installed: hasNginx, commands: cmds },
				null,
				2
			)
		);
		return 0;
	}

	console.log('');
	console.log('━'.repeat(60));
	console.log(`  SSL/TLS setup for ${c.bold(domain)}`);
	console.log('━'.repeat(60));
	console.log('');
	console.log(`  ${c.yellow('Before you start:')}`);
	console.log(`    1. ${domain} must point to THIS server (a DNS A/AAAA record).`);
	console.log('    2. Ports 80 and 443 must be open (UFW + your provider firewall).');
	console.log("    3. Let's Encrypt issues free certs but rate-limits retries —");
	console.log('       get the DNS right before running certbot.');
	console.log('');
	console.log('  This command does NOT run certbot or edit nginx for you —');
	console.log('  cert issuance changes your web server, so you run these steps');
	console.log('  (review the nginx changes certbot makes). Replace <your-email>.');
	console.log('');

	if (hasCertbot) {
		console.log(`  ${c.green('✓')} certbot is installed.`);
	} else {
		console.log(`  ${c.yellow('⚠')} certbot is not installed. Install it:`);
		console.log(`        ${cmds.install}`);
	}
	if (hasNginx) {
		console.log(`  ${c.green('✓')} nginx is installed (use the --nginx plugin — no downtime).`);
	} else {
		console.log(`  ${c.dim('•')} nginx not detected. If you serve directly behind nginx, install it first;`);
		console.log('        if you use Caddy, it manages TLS itself — skip certbot.');
	}
	console.log('');
	console.log(`  ${c.bold('Obtain the certificate')} (nginx plugin, recommended):`);
	console.log(`        ${cmds.nginxPlugin}`);
	console.log('');
	console.log(`  ${c.dim('Or standalone (briefly stops nginx, for non-nginx setups):')}`);
	console.log(`        ${c.dim(cmds.standalone)}`);
	console.log('');
	console.log(`  ${c.bold('Then verify auto-renewal is running')} (the step most people miss):`);
	console.log(`        ${cmds.verifyRenewal}`);
	console.log('        # if absent:  sudo systemctl enable --now certbot.timer');
	console.log('');
	console.log(`  When done, re-run ${c.bold('morphit-ops ssl')} to confirm the cert + timer.`);
	console.log('  Full reference: OPERATIONS.md §35.');
	console.log('');
	console.log('━'.repeat(60));
	console.log('');
	return 0;
}
