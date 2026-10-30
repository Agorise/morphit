/**
 * `morphit-ops ssl` (beta5 item G) — SSL/TLS certificate (HTTPS).
 *
 * Before beta5 the only HTTPS guidance lived in OPERATIONS.md §35;
 * there was no menu entry, so operators didn't know it existed. This
 * command surfaces it:
 *
 *   - `ssl` / `ssl status` — READ-ONLY: is there a valid cert for your
 *     domain, when does it expire, and will it actually renew (the timer
 *     AND the way certbot renews it — "the part most operators get wrong",
 *     §35)? With no valid certificate, the steps to get one follow.
 *   - `ssl setup` — GUIDED: checks prerequisites and prints the exact
 *     certbot commands tailored to your domain and to what holds port 80
 *     here. It does NOT run certbot — cert issuance mutates your web server
 *     and can't be safely validated from here, so (like `harden`) it hands
 *     you the precise steps to run.
 *
 * Review 2026-10-29: it read the domain from the directory it was run in
 * (the installed launcher runs it inside apps/ops-cli, so every guided
 * install got "Could not determine your domain") and only from keys a guided
 * install does not write there; it recommended `certbot --nginx` and
 * `--standalone`, which both fail while BunkerWeb holds port 80; "auto-renewal
 * active" looked only at the timer, not at how certbot renews; and without
 * sudo an unreadable /etc/letsencrypt read as "No certificate found".
 *
 * Mirrors the established command shape (doctor/harden): read-only by
 * default, advisory, never breaks the box.
 */

import { readFileSync, statSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { loadInstanceEnv } from '../lib/instanceEnv.ts';
import { effectiveEnvValue } from '../lib/instanceOrigin.ts';
import { renewalParam } from '../lib/tlsRenewHeal.ts';
import { isHiddenOnlyNode } from '../lib/hiddenOnly.ts';
import { startDotsSpinner } from '../init/spinner.ts';
import { runAsync } from '../lib/spinRun.ts';
import {
	detectBunkerWeb,
	dockerNotAnsweringText,
	validateServerName,
	type BunkerWebDetection
} from './bunkerweb.ts';

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

/** A .onion / .i2p name: self-authenticating, it needs no certificate. */
export function isHiddenServiceName(domain: string): boolean {
	return /\.(onion|i2p)$/i.test(domain);
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
			message: 'No certificate found for this domain.'
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
			message: `Certificate expires in ${days} day(s) (on ${notAfter.toUTCString()}). certbot renews within 30 days — check its renewal below.`
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
	/** Stops a host nginx for the check (only for a host-nginx setup). */
	readonly standalone: string;
	/** Port 80 free (nothing listens there, e.g. BunkerWeb not started yet). */
	readonly standaloneFree: string;
	/** Through the web build BunkerWeb serves: nothing is stopped. */
	readonly webroot: string;
	readonly verifyRenewal: string;
}

/** Build the exact certbot commands for a domain, matching OPERATIONS
 *  §35. PURE. The `<your-email>` placeholder is intentional — the
 *  operator substitutes their address. `buildDir` is the install's web
 *  build (the webroot BunkerWeb serves) — the same command the upgrade
 *  prints. */
export function buildCertbotCommands(
	domain: string,
	buildDir = '/opt/morphit/apps/web/build'
): CertbotCommands {
	// --cert-name: a certificate certbot already keeps for this domain (an
	// expired one, or one that also names www.<domain>) is the one renewed,
	// never a second "<domain>-0001" beside it that the web server does not
	// read (v1.21.18 review).
	const tail = `--cert-name ${domain} -d ${domain} --agree-tos --email <your-email> --no-eff-email`;
	return {
		install: 'sudo apt update && sudo apt install -y certbot python3-certbot-nginx',
		nginxPlugin: `sudo certbot --nginx ${tail}`,
		standalone:
			`sudo systemctl stop nginx && ` +
			`sudo certbot certonly --standalone ${tail} && ` +
			`sudo systemctl start nginx`,
		standaloneFree: `sudo certbot certonly --standalone ${tail}`,
		webroot: `sudo certbot certonly --webroot --webroot-path ${buildDir} ${tail}`,
		verifyRenewal: 'systemctl list-timers certbot.timer   # expect: certbot.timer, with a next run'
	};
}

/** How certbot renews this certificate, from its renewal settings. */
export type RenewalHow =
	| { readonly kind: 'unreadable' }
	/** confPresent: certbot keeps the certificate (its renewal file is there)
	 *  but the file does not say how to renew it; else certbot does not know
	 *  the certificate at all (copied in by hand). */
	| { readonly kind: 'missing'; readonly confPresent?: boolean }
	| { readonly kind: 'set'; readonly authenticator: string };

/** Whether that way works on this server, in words, and the fix. PURE. */
export function renewalVerdict(
	how: RenewalHow,
	bunkerRunning: boolean,
	certName: string,
	buildDir: string,
	/** The names on the certificate (default: just certName). */
	names: readonly string[] = [certName]
): { readonly tone: 'ok' | 'warn' | 'error' | 'info'; readonly text: string; readonly fix: string | null } {
	const toWebroot = `sudo certbot reconfigure --cert-name ${certName} --webroot --webroot-path ${buildDir}`;
	if (how.kind === 'unreadable')
		return {
			tone: 'info',
			text: 'How certbot renews it could not be read as this user.',
			fix: 'sudo morphit-ops ssl'
		};
	if (how.kind === 'missing' && how.confPresent === true)
		return {
			tone: 'warn',
			text: `Its renewal settings (/etc/letsencrypt/renewal/${certName}.conf) do not say how to renew it, so it will not renew by itself.`,
			// Renewed by its name, with no -d: certbot keeps every name on it
			// (www.<domain> too). `-d <domain>` alone made a second certificate,
			// "<domain>-0001", whenever this one names more than the domain.
			fix: bunkerRunning
				? `sudo certbot certonly --cert-name ${certName} --force-renewal --webroot --webroot-path ${buildDir}`
				: null
		};
	if (how.kind === 'missing') {
		// certbot does not know this certificate, and will not write one under
		// its name while its files are there ("live/archive directory exists",
		// after Let's Encrypt has issued it). Move them aside, have certbot issue
		// it, and put them back if that fails.
		const le = '/etc/letsencrypt';
		const ds = names.map((n) => `-d ${n}`).join(' ');
		return {
			tone: 'warn',
			text: `No renewal settings for it (${le}/renewal/${certName}.conf): certbot does not manage it, so it will not renew by itself.`,
			fix: bunkerRunning
				? `sudo sh -c 'cd ${le} && for d in live archive; do if [ -e $d/${certName} ]; then mv -T $d/${certName} $d/${certName}.unmanaged || exit 1; fi; done; ` +
					`certbot certonly --cert-name ${certName} ${ds} --webroot --webroot-path ${buildDir} && exit 0; ` +
					`for d in live archive; do if [ -e $d/${certName}.unmanaged ] && [ ! -e $d/${certName} ]; then mv -T $d/${certName}.unmanaged $d/${certName}; fi; done; exit 1'`
				: null
		};
	}
	const a = how.authenticator;
	if (bunkerRunning && (a === 'standalone' || a === 'nginx'))
		return {
			tone: 'error',
			text:
				a === 'standalone'
					? "It renews with certbot's standalone mode, which cannot work while BunkerWeb holds port 80: the renewal will fail."
					: "It renews through a host nginx, but BunkerWeb serves this site: the renewal will fail.",
			fix: toWebroot
		};
	if (a === 'webroot')
		return { tone: 'ok', text: 'It renews through the web build (webroot): nothing is stopped.', fix: null };
	return { tone: 'ok', text: `It renews with certbot's ${a} mode.`, fix: null };
}

// ─── I/O (best-effort, never throws) ────────────────────────────────

type TimerState = 'active' | 'inactive' | 'unknown';

/** What runSsl reads from the server; tests replace these. */
export interface SslDeps {
	readonly repoRoot?: string;
	/** /etc/letsencrypt */
	readonly letsencryptDir?: string;
	/** /etc/morphit */
	readonly etcDir?: string;
	readonly detectBunkerWeb?: () => Promise<BunkerWebDetection>;
	readonly timerState?: () => Promise<TimerState>;
	readonly which?: (bin: string) => Promise<boolean>;
	readonly readCertNotAfter?: (certPath: string) => Promise<Date | null>;
	readonly hiddenOnly?: () => boolean;
	readonly now?: Date;
}

async function which(bin: string): Promise<boolean> {
	const r = await runAsync('which', [bin], { timeoutMs: 3000 });
	return r.status === 0;
}

async function opensslNotAfter(certPath: string): Promise<Date | null> {
	const r = await runAsync('openssl', ['x509', '-enddate', '-noout', '-in', certPath], {
		timeoutMs: 5000
	});
	return r.status === 0 ? parseCertNotAfter(r.stdout) : null;
}

/** Is certbot's auto-renewal timer active? Checks both the apt
 *  (certbot.timer) and snap (snap.certbot.renew.timer) unit names. */
async function renewalTimerState(): Promise<TimerState> {
	for (const unit of ['certbot.timer', 'snap.certbot.renew.timer']) {
		const r = await runAsync('systemctl', ['is-active', unit], { timeoutMs: 3000 });
		const out = r.stdout.trim();
		if (out === 'active') return 'active';
		if (out === 'inactive' || out === 'failed') return 'inactive';
	}
	return 'unknown';
}

/** present / absent, or unreadable when this user may not look. */
function pathState(path: string): 'present' | 'absent' | 'unreadable' {
	try {
		statSync(path);
		return 'present';
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
	}
}

/** This instance's public origin, as the services see it: the instance
 *  config (morphit.config.env — what a guided install writes), then the
 *  relay's / indexer's public origin, then /etc/morphit/indexer.env. */
export function readPublicOrigin(repoRoot: string, etcDir: string): string {
	loadInstanceEnv(repoRoot);
	for (const k of ['MORPHIT_INSTANCE_ORIGIN', 'MORPHIT_RELAY_PUBLIC_ORIGIN', 'MORPHIT_INDEXER_PUBLIC_ORIGIN']) {
		const v = (process.env[k] ?? '').trim();
		if (v !== '' && domainFromOrigin(v) !== null) return v;
	}
	for (const k of ['MORPHIT_INSTANCE_ORIGIN', 'MORPHIT_INDEXER_PUBLIC_ORIGIN']) {
		const v = (effectiveEnvValue([join(etcDir, 'indexer.env')], k) ?? '').trim();
		if (v !== '' && domainFromOrigin(v) !== null) return v;
	}
	return '';
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

type Colors = ReturnType<typeof color>;

interface Facts {
	readonly domain: string;
	readonly buildDir: string;
	readonly le: string;
	readonly bunker: BunkerWebDetection;
}

export async function runSsl(ctx: SslCtx, deps: SslDeps = {}): Promise<number> {
	const c = color(ctx.colorEnabled);
	const json = ctx.flags.json === 'true';
	// The install, never the directory this happens to run in (the launcher
	// runs it inside apps/ops-cli).
	const repoRoot = deps.repoRoot ?? defaultRepoRoot();
	const etcDir =
		deps.etcDir ?? process.env.MORPHIT_ETC_DIR ?? `${process.env.MORPHIT_ENV_ROOT ?? ''}/etc/morphit`;
	const first = ctx.positional[0];
	const mode = first === 'setup' ? 'setup' : 'status';
	// The mode word ('status'/'setup') is optional. The domain is the
	// positional that isn't the mode word: positional[1] when a mode
	// word was given, else positional[0].
	const modeWordPresent = first === 'setup' || first === 'status';
	const explicit = modeWordPresent ? ctx.positional[1] : ctx.positional[0];

	const say = (tone: 'warn' | 'error', msg: string): number => {
		if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
		else {
			console.log('');
			console.log(`  ${tone === 'warn' ? c.yellow('⚠') : c.red('✗')} ${msg}`);
			console.log('');
		}
		return 1;
	};

	let domain: string | null = null;
	if (explicit !== undefined) {
		const d = explicit.trim().toLowerCase();
		const v = validateServerName(d);
		if (!isHiddenServiceName(d) && !v.ok)
			return say(
				'error',
				`"${explicit}" is not a domain name this can check (${v.reason ?? 'not a hostname'}). ` +
					'Give just the name, e.g. on this server: sudo morphit-ops ssl status trade.mysite.net'
			);
		domain = d;
	} else {
		const origin = readPublicOrigin(repoRoot, etcDir);
		domain = origin === '' ? null : domainFromOrigin(origin);
	}

	if (domain === null) {
		if ((deps.hiddenOnly ?? isHiddenOnlyNode)())
			return noCertNeeded(c, json, null);
		const root = typeof process.geteuid === 'function' && process.geteuid() === 0;
		return say(
			'warn',
			root
				? 'Could not determine your domain: no MORPHIT_INSTANCE_ORIGIN in ' +
						`${join(repoRoot, 'morphit.config.env')} (nor a public origin in the relay's or indexer's settings). ` +
						'Set it with: sudo morphit-ops edit — or name the domain: sudo morphit-ops ssl status yourdomain.com'
				: 'Could not determine your domain: its settings can only be read as root. Run it with sudo: sudo morphit-ops ssl'
		);
	}
	if (isHiddenServiceName(domain)) return noCertNeeded(c, json, domain);

	// Docker, openssl and systemctl can each take a moment: under the spinner.
	const stop = json ? () => undefined : startDotsSpinner('Checking your HTTPS certificate…');
	let facts: Facts;
	let notAfter: Date | null = null;
	let certState: 'present' | 'absent' | 'unreadable';
	let timer: TimerState = 'unknown';
	let hasCertbot = false;
	let hasNginx = false;
	try {
		const le = deps.letsencryptDir ?? '/etc/letsencrypt';
		const bunker = await (deps.detectBunkerWeb ?? (() => detectBunkerWeb()))();
		facts = { domain, buildDir: join(repoRoot, 'apps', 'web', 'build'), le, bunker };
		const certPath = join(le, 'live', domain, 'fullchain.pem');
		certState = pathState(certPath);
		if (certState === 'present') notAfter = await (deps.readCertNotAfter ?? opensslNotAfter)(certPath);
		if (mode === 'status') timer = await (deps.timerState ?? renewalTimerState)();
		const w = deps.which ?? which;
		[hasCertbot, hasNginx] = await Promise.all([w('certbot'), w('nginx')]);
	} finally {
		stop();
	}

	if (certState === 'unreadable')
		return say(
			'warn',
			`The certificates in ${join(facts.le, 'live')} can only be read as root, so "${domain}" could not be checked. Run it with sudo: sudo morphit-ops ssl`
		);
	if (mode === 'setup') return runSetup(c, json, facts, hasCertbot, hasNginx);
	return runStatus(c, json, facts, notAfter, timer, hasCertbot, hasNginx, deps.now ?? new Date());
}

function noCertNeeded(c: Colors, json: boolean, domain: string | null): number {
	const msg =
		'This node is reached over Tor/I2P: .onion and .i2p addresses are self-authenticating, so it needs no HTTPS certificate.';
	if (json) console.log(JSON.stringify({ domain, cert: 'not-needed', detail: msg }, null, 2));
	else {
		console.log('');
		console.log(`  ${c.green('✓')} ${msg}`);
		console.log('');
	}
	return 0;
}

/** The DNS names on this domain's certificate (its subjectAltName), or just
 *  the domain when it cannot be read. Only plain host names are kept. */
function certNames(le: string, domain: string): string[] {
	try {
		const cert = new X509Certificate(readFileSync(join(le, 'live', domain, 'fullchain.pem')));
		const names = (cert.subjectAltName ?? '')
			.split(',')
			.map((x) => x.trim())
			.filter((x) => x.startsWith('DNS:'))
			.map((x) => x.slice(4).toLowerCase())
			.filter((n) => /^[a-z0-9.-]{1,253}$/.test(n));
		if (names.length > 0) return [domain, ...names.filter((n) => n !== domain)];
	} catch {
		/* not readable as a certificate: the domain alone */
	}
	return [domain];
}

function readRenewal(le: string, domain: string): RenewalHow {
	const p = join(le, 'renewal', `${domain}.conf`);
	const st = pathState(p);
	if (st === 'absent') return { kind: 'missing', confPresent: false };
	try {
		const a = renewalParam(readFileSync(p, 'utf8'), 'authenticator');
		return a === null ? { kind: 'missing', confPresent: true } : { kind: 'set', authenticator: a };
	} catch {
		return { kind: 'unreadable' };
	}
}

async function runStatus(
	c: Colors,
	json: boolean,
	f: Facts,
	notAfter: Date | null,
	timer: TimerState,
	hasCertbot: boolean,
	hasNginx: boolean,
	now: Date
): Promise<number> {
	const verdict = certVerdict(notAfter, now);
	const bunkerRunning = f.bunker.presence === 'running';
	const renewal = notAfter !== null ? readRenewal(f.le, f.domain) : null;
	const rv =
		renewal !== null
			? renewalVerdict(renewal, bunkerRunning, f.domain, f.buildDir, certNames(f.le, f.domain))
			: null;

	if (json) {
		console.log(
			JSON.stringify(
				{
					domain: f.domain,
					cert: verdict.kind,
					days_remaining: verdict.daysRemaining,
					expires: notAfter ? notAfter.toISOString() : null,
					renewal_timer: timer,
					renewal_authenticator: renewal?.kind === 'set' ? renewal.authenticator : null,
					renewal_ok: rv === null ? null : rv.tone === 'ok',
					bunkerweb: f.bunker.presence
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
	console.log(`  Domain: ${c.bold(f.domain)}`);
	console.log('');
	const tag =
		verdict.kind === 'valid'
			? c.green('✓')
			: verdict.kind === 'expiring'
				? c.yellow('⚠')
				: c.red('✗');
	console.log(`  ${tag} ${verdict.message}`);

	if (notAfter !== null) {
		console.log('');
		if (timer === 'active') {
			console.log(`  ${c.green('✓')} The renewal timer runs (certbot.timer).`);
		} else if (timer === 'inactive') {
			console.log(`  ${c.yellow('⚠')} The renewal timer is NOT running. Turn it on, on this server:`);
			console.log('        sudo systemctl enable --now certbot.timer');
		} else {
			console.log(
				`  ${c.dim('•')} Could not tell whether certbot's renewal timer runs (certbot may be from somewhere else, or there is no systemd). Look, on this server:`
			);
			console.log('        systemctl list-timers certbot.timer');
		}
		if (rv !== null) {
			const t =
				rv.tone === 'ok'
					? c.green('✓')
					: rv.tone === 'error'
						? c.red('✗')
						: rv.tone === 'warn'
							? c.yellow('⚠')
							: c.dim('•');
			console.log(`  ${t} ${rv.text}`);
			if (rv.fix !== null) {
				console.log(`        ${rv.tone === 'info' ? 'Run it with sudo' : 'Fix it, on this server'}:  ${rv.fix}`);
			}
		}
	}
	console.log('');
	if (verdict.kind === 'none' || verdict.kind === 'expired') {
		// The steps belong right here (the menu promises them): no second run.
		printSetupSteps(c, f, hasCertbot, hasNginx);
	}
	console.log('━'.repeat(60));
	console.log('');
	return verdict.kind === 'expired' ? 1 : 0;
}

/** Which certbot command fits what holds port 80 here. */
function obtainCommand(
	f: Facts,
	hasNginx: boolean,
	cmds: CertbotCommands
): { readonly how: string; readonly cmd: string; readonly note: string | null } {
	const b = f.bunker.presence;
	if (b === 'running')
		return {
			how: 'through BunkerWeb, which holds port 80 here (nothing is stopped)',
			cmd: cmds.webroot,
			note: null
		};
	if (b === 'stopped' || f.bunker.configDir)
		return {
			how: 'BunkerWeb is set up here but not running, so port 80 is free',
			cmd: cmds.standaloneFree,
			note: 'Then start BunkerWeb, on this server: sudo morphit-ops bunkerweb'
		};
	if (b === 'docker-not-answering')
		return {
			how: 'Docker did not answer, so whether BunkerWeb holds port 80 is not known; if it does, use',
			cmd: cmds.webroot,
			note: `If nothing listens on port 80, this works instead: ${cmds.standaloneFree}`
		};
	if (hasNginx)
		return {
			how: 'with the nginx plugin (this server runs nginx; no downtime)',
			cmd: cmds.nginxPlugin,
			note: null
		};
	return {
		how: 'port 80 must be free (no web server running on it yet)',
		cmd: cmds.standaloneFree,
		note: null
	};
}

function printSetupSteps(c: Colors, f: Facts, hasCertbot: boolean, hasNginx: boolean): void {
	const cmds = buildCertbotCommands(f.domain, f.buildDir);
	const pick = obtainCommand(f, hasNginx, cmds);
	console.log(`  ${c.bold(`Getting a certificate for ${f.domain}`)} — on this server:`);
	console.log('');
	console.log(`  ${c.yellow('Before you start:')}`);
	console.log(`    1. ${f.domain} must point to THIS server (a DNS A/AAAA record).`);
	console.log('    2. Ports 80 and 443 must be open (UFW + your provider firewall).');
	console.log("    3. Let's Encrypt issues free certificates but limits retries —");
	console.log('       get the DNS right before running certbot.');
	console.log('');
	if (f.bunker.presence === 'docker-not-answering') {
		console.log(`  ${c.yellow('⚠')} ${dockerNotAnsweringText(f.bunker.dockerError, false)}`);
	}
	if (hasCertbot) {
		console.log(`  ${c.green('✓')} certbot is installed.`);
	} else {
		console.log(`  ${c.yellow('⚠')} certbot is not installed. Install it:`);
		console.log(
			`        ${pick.cmd === cmds.nginxPlugin ? cmds.install : 'sudo apt update && sudo apt install -y certbot'}`
		);
	}
	console.log('');
	console.log(`  ${c.bold('Get the certificate')} (${pick.how}; replace <your-email>):`);
	console.log(`        ${pick.cmd}`);
	if (pick.note !== null) console.log(`        ${c.dim(pick.note)}`);
	console.log('');
	console.log(`  ${c.bold('Then check that it renews by itself')} (the step most people miss):`);
	console.log(`        ${cmds.verifyRenewal}`);
	console.log('        # if absent:  sudo systemctl enable --now certbot.timer');
	console.log('');
	console.log(`  When done, check it, on this server: ${c.bold('sudo morphit-ops ssl')}`);
	console.log('  Full reference: OPERATIONS.md §35.');
	console.log('');
}

function runSetup(
	c: Colors,
	json: boolean,
	f: Facts,
	hasCertbot: boolean,
	hasNginx: boolean
): number {
	const cmds = buildCertbotCommands(f.domain, f.buildDir);
	if (json) {
		const pick = obtainCommand(f, hasNginx, cmds);
		console.log(
			JSON.stringify(
				{
					domain: f.domain,
					certbot_installed: hasCertbot,
					nginx_installed: hasNginx,
					bunkerweb: f.bunker.presence,
					obtain: pick.cmd,
					commands: cmds
				},
				null,
				2
			)
		);
		return 0;
	}
	console.log('');
	console.log('━'.repeat(60));
	console.log(`  SSL/TLS setup for ${c.bold(f.domain)}`);
	console.log('━'.repeat(60));
	console.log('');
	console.log('  This does NOT run certbot for you — getting a certificate changes how');
	console.log('  your web server answers, so you run these steps.');
	console.log('');
	printSetupSteps(c, f, hasCertbot, hasNginx);
	console.log('━'.repeat(60));
	console.log('');
	return 0;
}
