/**
 * Installed-box heal: www.<domain> on a BunkerWeb instance (v1.21.11).
 *
 * WHY. BunkerWeb serves only the names in SERVER_NAME, and Morphit wrote only
 * the bare domain there. A visitor typing www.vigilante.trading reached the
 * server (the www record pointed at it) and got BunkerWeb's "403 Forbidden"
 * page: with DISABLE_DEFAULT_SERVER=yes every other name is refused. The
 * Let's Encrypt certificate named the bare domain only, so https://www… could
 * not be secure either.
 *
 * WHAT, when the domain is a site's own domain (vigilante.trading,
 * morphit.io, example.com.mx — never a subdomain such as
 * morphit.timeapp.foundation, see wwwAliasFor) and www.<domain> points at the
 * same addresses as the domain (asked of the DNS servers this machine uses —
 * systemd-resolved's own upstream servers when it runs, so not /etc/hosts):
 *  1. bunkerweb.env: www.<domain> is added to SERVER_NAME after the domain
 *     (BunkerWeb takes the first name for its certificate and settings), and
 *     a server-block rule sends every request for www.<domain>, on http and
 *     https, to https://<domain> with the same path (one 301; it runs in
 *     nginx's rewrite phase, before BunkerWeb's own http→https redirect).
 *     The rule is single-quoted: Docker Compose replaces `$name` in an env
 *     file, and `$host` / `$request_uri` would arrive empty. A CUSTOM_SSL_*
 *     path written with `${SERVER_NAME}` (the manual example) is written out
 *     with the domain, since SERVER_NAME now holds two names.
 *  2. BunkerWeb's own services are recreated by Docker Compose (a plain
 *     restart keeps a container's old environment) and the rule is checked
 *     live: http://www.<domain>/<path> must answer 301 to
 *     https://<domain>/<path>, and the domain itself must answer as before
 *     (else the old file goes back). What BunkerWeb really runs is read from
 *     its edge container's environment: a file that names www while the
 *     containers do not (a fresh install, an earlier run that could not
 *     recreate them) is loaded by recreating them, once per version of the
 *     file. When BunkerWeb's Compose service sets SERVER_NAME itself
 *     (`environment:`) or does not read the file, the file is left alone and
 *     the heal names what to change. Only when the running
 *     BunkerWeb has the rule and still does not redirect is it written a
 *     second way, as a config file in its scheduler (once). No answer at all
 *     on this machine restarts nothing.
 *  3. The certificate: Let's Encrypt is asked, through the same web build its
 *     renewals use, for the same certificate with www.<domain> added (first
 *     proven locally: a file in the build must come back from
 *     http://www.<domain>/.well-known/acme-challenge/… with redirects
 *     followed, as Let's Encrypt will fetch it). Read back from the
 *     certificate, made readable for BunkerWeb, BunkerWeb reloads it, and
 *     https://www.<domain> must pass a certificate check. What the operator
 *     set for the certificate (deploy hook, preferred chain, …) is kept.
 * Every step fits in the run that hosts the heal: one that would not finish
 * before its deadline is left for the next upgrade (BunkerWeb is never left
 * half-way through a recreate).
 * A certificate that names www.<domain> while www no longer points here would
 * fail every renewal (Let's Encrypt checks every name), so it is issued again
 * without it.
 */
import { Resolver } from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { envEntries, envValues } from './bunkerwebPrivacy.ts';
import { renewalParam, webrootMap } from './tlsRenewHeal.ts';

/** The custom nginx conf (in BunkerWeb's server block) that sends www to the domain. */
export const WWW_REDIRECT_KEY = 'CUSTOM_CONF_SERVER_HTTP_morphit_www_redirect';

/** Let's Encrypt's production directory (certbot's default server). */
const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';

/** Second-level labels under which a country domain is registered
 *  (example.com.mx, example.co.uk): those three-label names are a site's own
 *  domain too. */
const SECOND_LEVEL = new Set([
	'ac',
	'co',
	'com',
	'edu',
	'go',
	'gob',
	'gov',
	'int',
	'ltd',
	'mil',
	'ne',
	'net',
	'nom',
	'or',
	'org',
	'plc'
]);

/** Names that are never on public DNS. */
const NOT_PUBLIC = new Set([
	'arpa',
	'example',
	'home',
	'i2p',
	'internal',
	'invalid',
	'lan',
	'local',
	'localhost',
	'loki',
	'onion',
	'test'
]);

/**
 * www.<domain> when `domain` is a site's own (registered) domain: two labels
 * (vigilante.trading, morphit.io), or three with a country's second-level
 * label (example.com.mx, example.co.uk). null for a subdomain
 * (morphit.timeapp.foundation, trade.example.org — a www in front of those is
 * not an address anyone types), an address already starting with www., an IP
 * address, or a name that is not on public DNS. PURE.
 */
export function wwwAliasFor(domain: string): string | null {
	const d = domain.trim().toLowerCase().replace(/\.$/, '');
	if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(d)) return null;
	const labels = d.split('.');
	if (labels.some((l) => l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return null;
	const tld = labels[labels.length - 1]!;
	if (!/[a-z]/.test(tld) || NOT_PUBLIC.has(tld)) return null;
	if (labels[0] === 'www') return null;
	const own =
		labels.length === 2 ||
		(labels.length === 3 && tld.length === 2 && SECOND_LEVEL.has(labels[1]!));
	return own ? `www.${d}` : null;
}

/** The nginx rule (server context) that sends www.<domain> to https://<domain>. PURE. */
export function wwwRedirectConf(domain: string): string {
	return `if ($host = www.${domain}) { return 301 https://${domain}$request_uri; }`;
}

/** The env line for the rule: single-quoted, so Compose keeps `$host` and `$request_uri`. PURE. */
export function wwwRedirectLine(domain: string): string {
	return `${WWW_REDIRECT_KEY}='${wwwRedirectConf(domain)}'`;
}

/** Every entry of `key` becomes one `key=val` line; none → appended. PURE. */
function setEntries(text: string, key: string, val: string): string {
	const entries = envEntries(text).filter((e) => e.key === key);
	if (entries.length === 0)
		return `${text.replace(/\n*$/, '')}${text.trim() === '' ? '' : '\n'}${key}=${val}\n`;
	const lines = text.split('\n');
	for (const e of [...entries].reverse()) {
		const cr = /\r$/.test(lines[e.last]!) ? '\r' : '';
		lines.splice(e.first, e.last - e.first + 1, `${e.pre}${key}=${val}${cr}`);
	}
	return lines.join('\n');
}

/** Is the entry's value written in single quotes (Compose leaves it as it is)? */
function singleQuoted(text: string, first: number): boolean {
	const line = text.split('\n')[first] ?? '';
	return /^[^=:]*[=:][ \t]*'/.test(line);
}

/** A `${SERVER_NAME}` / `$SERVER_NAME` Compose would replace with the whole name list. */
const SERVER_NAME_REF = /\$\{SERVER_NAME\}|\$SERVER_NAME(?![A-Za-z0-9_])/g;

/** The names BunkerWeb serves (SERVER_NAME, the last entry, as Compose reads it). PURE. */
export function serverNames(text: string): string[] {
	return (envValues(text).get('SERVER_NAME') ?? '').trim().split(/\s+/).filter(Boolean);
}

/** The Let's Encrypt certificate name a CUSTOM_SSL_CERT path points at, or null. PURE. */
export function certNameOf(certPath: string): string | null {
	return /^\/etc\/letsencrypt\/live\/([^/\s]+)\/fullchain\.pem$/.exec(certPath.trim())?.[1] ?? null;
}

/** The web build a certificate's renewals write their challenge into: its
 *  webroot for `domain`, else its first webroot, else `fallback`. PURE. */
export function webrootFor(renewalConf: string, domain: string, fallback: string): string {
	const mapped = webrootMap(renewalConf).get(domain);
	if (mapped) return mapped;
	const first = (renewalParam(renewalConf, 'webroot_path') ?? '').split(',')[0]!.trim();
	return first !== '' ? first : fallback;
}

/** A [renewalparams] value without the quotes ConfigObj may put round it. */
function param(conf: string, key: string): string | null {
	const v = renewalParam(conf, key);
	return v === null ? null : v.replace(/^(["'])(.*)\1$/, '$2');
}

/**
 * The certbot arguments that issue certificate `name` for `names` again,
 * through `webroot`, from the server and account its renewals use. `certonly`
 * rewrites the renewal file from its own arguments only (certbot's
 * storage.relevant_values), so what the operator set for this certificate is
 * carried over: its deploy hook (run once after this issuance too; not checked
 * when read, as renewals never check it), preferred chain, key reuse,
 * subset-of-names and no-autorenew. Not OCSP must-staple: Let's Encrypt
 * refuses every such request since 2025, so it would fail the issuance. Its
 * pre/post hooks are NOT: the TLS renewal heal may have set them to stop and
 * start BunkerWeb, which would break an issuance through BunkerWeb's own web
 * build (the heal proves that path first). PURE.
 */
export function certbotArgs(
	name: string,
	names: readonly string[],
	webroot: string,
	renewalConf: string
): string[] {
	const args = [
		'certonly',
		'--non-interactive',
		'--cert-name',
		name,
		'--webroot',
		'--webroot-path',
		webroot,
		...names.flatMap((n) => ['-d', n])
	];
	const server = param(renewalConf, 'server');
	if (server && server !== LE_PRODUCTION) args.push('--server', server);
	const account = param(renewalConf, 'account');
	if (account) args.push('--account', account);
	// The key as it is: certbot 1.x refuses a request whose key type differs
	// from the certificate's unless both --key-type and --cert-name are given,
	// and 2.x would otherwise use its own default.
	const keyType = param(renewalConf, 'key_type');
	if (keyType) args.push('--key-type', keyType);
	const curve = param(renewalConf, 'elliptic_curve');
	if (curve && keyType === 'ecdsa') args.push('--elliptic-curve', curve);
	const rsaSize = param(renewalConf, 'rsa_key_size');
	if (rsaSize && keyType !== 'ecdsa') args.push('--rsa-key-size', rsaSize);
	const yes = (k: string) => /^true$/i.test(param(renewalConf, k) ?? '');
	const hook = param(renewalConf, 'renew_hook');
	if (hook) args.push('--deploy-hook', hook, '--disable-hook-validation');
	const chain = param(renewalConf, 'preferred_chain');
	if (chain) args.push('--preferred-chain', chain);
	if (yes('reuse_key')) args.push('--reuse-key');
	if (yes('allow_subset_of_names')) args.push('--allow-subset-of-names');
	if (/^false$/i.test(param(renewalConf, 'autorenew') ?? '')) args.push('--no-autorenew');
	return args;
}

export interface WwwEnvPlan {
	readonly text: string;
	/** One line per change, for the operator. */
	readonly changes: readonly string[];
}

/** A value written back the way Compose reads it: plain when it can be,
 *  else double-quoted with its escapes. PURE. */
function envLiteral(v: string): string {
	if (!/[\n\r\t"'\\]|^\s|\s$| #/.test(v)) return v;
	return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/**
 * The bunkerweb.env text with www added to SERVER_NAME, the redirect rule set
 * and `${SERVER_NAME}` written out in the other values (nothing when `www` is
 * null). PURE.
 */
export function planWwwEnv(
	text: string,
	www: { domain: string; alias: string } | null
): WwwEnvPlan {
	let out = text;
	const changes: string[] = [];

	if (www !== null) {
		const { domain, alias } = www;
		// ${SERVER_NAME} in other values would become "domain www.domain". The
		// entries are read again after each change (a rewrite can join the lines
		// of a value that ran over several).
		for (;;) {
			const e = envEntries(out).find(
				(x) =>
					x.key !== 'SERVER_NAME' &&
					!singleQuoted(out, x.first) &&
					x.value.match(SERVER_NAME_REF) !== null
			);
			if (!e) break;
			out = setEntries(out, e.key, envLiteral(e.value.replace(SERVER_NAME_REF, domain)));
			changes.push(`${e.key} names ${domain} itself (it used \${SERVER_NAME})`);
		}
		const names = serverNames(out);
		if (!names.includes(alias)) {
			out = setEntries(out, 'SERVER_NAME', [...names, alias].join(' '));
			changes.push(`BunkerWeb now answers for ${alias} too`);
		}
		if ((envValues(out).get(WWW_REDIRECT_KEY) ?? '') !== wwwRedirectConf(domain)) {
			out = setEntries(out, WWW_REDIRECT_KEY, `'${wwwRedirectConf(domain)}'`);
			changes.push(`${alias} sends every visitor to https://${domain} (same page)`);
		}
	}
	return { text: out, changes };
}

/** Where www.<domain> points, compared with the domain. */
export type WwwDns =
	| { readonly kind: 'here' }
	| { readonly kind: 'none' }
	| {
			readonly kind: 'elsewhere';
			readonly www: readonly string[];
			readonly site: readonly string[];
	  }
	| { readonly kind: 'unknown' };

/** One name's addresses; `sure` is false when the answer could not be had
 *  (a time-out, a failing DNS server), as opposed to "no such record". */
export interface Lookup {
	readonly addrs: readonly string[];
	readonly sure: boolean;
}

/** 127.0.0.0/8, ::1, ::ffff:127.x — an answer from this machine's own hosts list. */
function loopback(a: string): boolean {
	const x = a.toLowerCase();
	return /^127\./.test(x) || x === '::1' || /^::ffff:127\./.test(x);
}

/** Does www point where the domain does? Every www address must be one of the
 *  domain's (a CNAME to the domain gives the same list). Nothing is concluded
 *  when the domain itself has no public address here, or an answer is only
 *  this machine's own (a hosts-file entry). PURE. */
export function wwwDnsVerdict(site: Lookup, www: Lookup): WwwDns {
	if (!site.sure || !www.sure) return { kind: 'unknown' };
	if (site.addrs.length === 0 || site.addrs.every(loopback)) return { kind: 'unknown' };
	if (www.addrs.length === 0) return { kind: 'none' };
	if (www.addrs.every(loopback)) return { kind: 'unknown' };
	const s = new Set(site.addrs.map((a) => a.toLowerCase()));
	return www.addrs.every((a) => s.has(a.toLowerCase()))
		? { kind: 'here' }
		: { kind: 'elsewhere', www: www.addrs, site: site.addrs };
}

/** Time kept back from a wait for BunkerWeb: its Compose recreate (up to 180 s)
 *  and the checks after it. */
export const APPLY_RESERVE_MS = 4 * 60_000;
/** The certificate step needs certbot's five minutes plus a reload. */
export const CERT_STEP_MIN_MS = 9 * 60_000;

/**
 * How long one wait for BunkerWeb may take when `leftMs` remain before the
 * run's deadline (the background web heal is stopped at its time limit, the
 * self-heal child at its own): at most `maxMs`, and never into the reserve.
 * null when not even a minute would be left — then BunkerWeb is not restarted
 * at all, so it is never stopped half-way through a recreate. PURE.
 */
export function applyWaitMs(leftMs: number, maxMs = 10 * 60_000): number | null {
	const w = Math.min(maxMs, leftMs - APPLY_RESERVE_MS);
	return w >= 60_000 ? w : null;
}

// ─── runtime ────────────────────────────────────────────────────────────

/** The outcome of asking BunkerWeb to take new settings. 'no-time': not
 *  started, the run's deadline is too near. */
export type ApplyResult = 'loaded' | 'refused' | 'pending' | 'not-restarted' | 'no-time';

/** One request's outcome: HTTP status ('000' with no answer), Location, the
 *  headers, and curl's exit status (35/51/58/60: the certificate check failed). */
export interface RequestResult {
	readonly code: string;
	readonly location: string;
	readonly headers: string;
	readonly exit: number;
}

export interface WwwRuntime {
	/** Is this a hidden-only node (no clearnet lookups at all)? */
	hiddenOnly(): boolean;
	/** The settings file BunkerWeb reads, or null (with why) when it cannot be told. */
	envFile(): { path: string | null; note: string | null };
	readFile(path: string): string | null;
	/** Written in place (an existing file keeps its owner and mode); a new file
	 *  gets `mode` (default 0644). */
	writeFile(path: string, text: string, mode?: number): boolean;
	removeFile(path: string): void;
	/** A copy of the file next to it (mode 0600); its path, or null. */
	backup(path: string, text: string): string | null;
	/** Does Docker Compose accept the settings file as it is now? */
	composeAccepts(): boolean;
	lookup(name: string): Promise<Lookup>;
	/** The environment BunkerWeb's running edge container was created with
	 *  (what it really serves), or null when it cannot be read. */
	liveEnv(): ReadonlyMap<string, string> | null;
	/** `recreate`: BunkerWeb's services recreated by Docker Compose, so they read
	 *  the settings file again ('not-restarted' when that cannot be done — a
	 *  plain restart keeps a container's old settings); otherwise its scheduler
	 *  restarted (it reads its config files and the certificate again). Then the
	 *  wait for BunkerWeb's verdict. */
	apply(why: string, recreate: boolean): ApplyResult;
	/** Write the rule as a config file in BunkerWeb's scheduler (the second way). */
	writeSchedulerConf(name: string, conf: string): 'written' | 'unchanged' | 'failed';
	/** One request to this server (127.0.0.1) for `url`, redirects NOT followed;
	 *  `verify`: the certificate is checked. */
	request(url: string, opts?: { verify?: boolean; headers?: boolean }): RequestResult;
	/** Body of `url` asked on 127.0.0.1, redirects followed, certificate not checked. */
	fetchFollow(url: string): string | null;
	/** The names on the live certificate `name`, or null when it cannot be read. */
	certNames(name: string): string[] | null;
	certbotPresent(): boolean;
	certbot(args: readonly string[]): { ok: boolean; out: string };
	/** Make the certificate files readable for BunkerWeb (group 101), as the renewal hook does. */
	certPermissions(): void;
	/** The install's web build (the frontend's webroot). */
	buildDir(): string;
	/** Time left before the run's deadline (ms). */
	timeLeftMs(): number;
	/** Is this the upgrade's background step (false: the self-heal child, whose
	 *  few minutes never fit a recreate)? */
	inBackground(): boolean;
	/** BunkerWeb was started by Docker Compose (so it can be recreated). */
	composeManaged(): boolean;
	/** What, besides the settings file, decides the edge's names: the keys its
	 *  Compose service sets itself (`environment:`), and whether it reads the
	 *  file at all; null when Compose could not say. */
	edgeSettingsSource(): {
		readonly readsFile: boolean;
		readonly overrides: readonly string[];
	} | null;
}

/** Collected while the heal runs. */
interface Run {
	readonly ctx: HealCtx;
	readonly rt: WwwRuntime;
	parts: string[];
	verified: boolean;
	strategy: string;
}

const COMMAND = 'sudo morphit-ops upgrade --heals';
const NEXT = 'the next `sudo morphit-ops upgrade` does it';
/** What to say when there is no time for a step: in the background step the
 *  next upgrade does it; in the self-heal child it never fits. */
function later(rt: WwwRuntime): string {
	return rt.inBackground()
		? NEXT
		: "it needs the upgrade's background step, which could not be started on this server (systemd-run)";
}
/** How the operator makes BunkerWeb read its settings file again. */
function recreateHow(rt: WwwRuntime, envPath: string): string {
	return rt.composeManaged()
		? `on this server run: ${COMMAND}`
		: `recreate the BunkerWeb container with the settings in ${envPath} (it was not started by Docker Compose)`;
}
/** The settings file's path, for a message. */
function envPathOf(rt: WwwRuntime): string {
	return rt.envFile().path ?? "BunkerWeb's settings file";
}
/** sha256 of a settings file's text (the marker of a recreate already tried). */
function textHash(t: string): string {
	return createHash('sha256').update(t).digest('hex');
}

/** Does the running BunkerWeb serve www (in its SERVER_NAME, with the rule)?
 *  null when its settings cannot be read. */
function liveHasWww(rt: WwwRuntime, www: { domain: string; alias: string }): boolean | null {
	const live = rt.liveEnv();
	if (live === null) return null;
	const names = (live.get('SERVER_NAME') ?? '').trim().split(/\s+/);
	return names.includes(www.alias) && live.get(WWW_REDIRECT_KEY) === wwwRedirectConf(www.domain);
}

/** The www heal. `rt` is the box (tests pass a simulated one). */
export async function healBunkerWebWww(ctx: HealCtx, rt: WwwRuntime): Promise<HealResult> {
	if (rt.hiddenOnly())
		return { strategy: 'skipped', verified: true, routine: true, detail: 'www: hidden-only node.' };
	const ef = rt.envFile();
	if (ef.path === null)
		return ef.note !== null
			? { strategy: 'skipped', verified: true, detail: ef.note }
			: { strategy: 'skipped', verified: true, routine: true, detail: 'www: no BunkerWeb here.' };
	const envPath = ef.path;
	const before = rt.readFile(envPath);
	if (before === null)
		return {
			strategy: 'skipped',
			verified: false,
			detail: `www: ${envPath} could not be read, so nothing was changed.`
		};
	const vals = envValues(before);
	const names = serverNames(before);
	const domain = (names[0] ?? '').toLowerCase();
	const run: Run = { ctx, rt, parts: [], verified: true, strategy: 'already' };

	// Which www work applies here.
	let www: { domain: string; alias: string } | null = null;
	let dns: WwwDns | null = null;
	const alias = domain !== '' && !/[{$]/.test(domain) ? wwwAliasFor(domain) : null;
	const multisite = (vals.get('MULTISITE') ?? 'no').trim().toLowerCase() === 'yes';
	if (alias !== null && multisite) {
		run.parts.push(
			`BunkerWeb runs several sites here (MULTISITE=yes), so ${alias} was left as it is; to add it, put it in that site's SERVER_NAME and its certificate`
		);
	} else if (alias !== null) {
		const stop = ctx.spinner(`Looking up where ${alias} points…`);
		try {
			const [s, w] = await Promise.all([rt.lookup(domain), rt.lookup(alias)]);
			dns = wwwDnsVerdict(s, w);
		} finally {
			stop();
		}
		if (dns.kind === 'here') www = { domain, alias };
		else if (dns.kind === 'none')
			run.parts.push(
				`${alias} has no DNS record, so visitors cannot reach it. To use it, add a CNAME record "www" pointing to ${domain} at your DNS provider, then on this server run: ${COMMAND}`
			);
		else if (dns.kind === 'elsewhere')
			run.parts.push(
				`${alias} points at ${dns.www.join(', ')}, not at this server (${dns.site.join(', ')}), so it is not set up here. To use it, point "www" at the same address as ${domain} (a CNAME record "www" → ${domain} does it), then on this server run: ${COMMAND}`
			);
		else
			run.parts.push(
				`where ${alias} points could not be looked up just now, so it was left as it is; the next \`sudo morphit-ops upgrade\` looks again`
			);
	}

	// 1–2. The settings file, then what BunkerWeb really runs. When something
	// else decides the edge's names (its Compose `environment:`, or it does not
	// read this file), the file is not the place: said, nothing changed.
	if (www !== null) {
		const src = rt.edgeSettingsSource();
		const over = src?.overrides.filter((k) => k === 'SERVER_NAME' || k === WWW_REDIRECT_KEY) ?? [];
		if (src !== null && (!src.readsFile || over.length > 0)) {
			run.verified = false;
			run.strategy = 'left-alone';
			run.parts.push(
				!src.readsFile
					? `BunkerWeb's container does not read ${envPath}, so ${alias} was not set up there; add ${alias} to its SERVER_NAME where its settings are`
					: `BunkerWeb's Compose service sets ${over.join(' and ')} itself (its environment: entry wins over ${envPath}), so ${alias} was not set up; add "${alias}" after the domain in that SERVER_NAME and the line ${wwwRedirectLine(domain)} there`
			);
			return finish(run);
		}
	}
	const plan = planWwwEnv(before, www);
	let loaded = true;
	if (plan.changes.length > 0) {
		const res = await applyEnv(run, envPath, before, plan, www);
		if (res === null) return finish(run);
		loaded = res === 'loaded';
	} else if (www !== null && liveHasWww(rt, www) === false) {
		// The file has www (a fresh install's, or an earlier run's) but the
		// running containers were created before it: recreate them — once per
		// file content (a recreate that did not give BunkerWeb www is not tried
		// again until the file changes).
		const marker = `${envPath}.www-recreated`;
		if ((rt.readFile(marker) ?? '').trim() === textHash(before)) {
			run.verified = false;
			run.strategy = 'not-loaded';
			run.parts.push(
				`${envPath} names ${alias}, but BunkerWeb still runs without it after its services were recreated with this file; check what BunkerWeb's containers really read (\`docker inspect\` on its container), then ${recreateHow(rt, envPath)}`
			);
			return finish(run);
		}
		const res = rt.apply(`${www.alias} loaded from ${envPath}`, true);
		loaded = res === 'loaded';
		if (res === 'loaded' || res === 'refused') {
			if (liveHasWww(rt, www) !== true) rt.writeFile(marker, `${textHash(before)}\n`, 0o600);
		}
		if (res === 'not-restarted' || res === 'no-time' || res === 'refused') {
			run.verified = false;
			run.strategy = 'not-loaded';
			run.parts.push(
				res === 'refused'
					? `${envPath} names ${alias}, but BunkerWeb refused those settings when its services were recreated; it runs as before (without www)`
					: res === 'no-time'
						? `${envPath} names ${alias}, but BunkerWeb still runs without it; there was not enough time in this run to recreate its services: ${later(rt)}`
						: `${envPath} names ${alias}, but BunkerWeb still runs without it (a container keeps the settings it was created with) and its services could not be recreated automatically; ${recreateHow(rt, envPath)}`
			);
			return finish(run);
		}
		run.strategy = 'loaded';
	}
	if (www !== null) checkRedirect(run, www, plan.changes.length === 0, loaded);

	// 3. The certificate.
	const certName = certNameOf(
		envValues(rt.readFile(envPath) ?? before).get('CUSTOM_SSL_CERT') ?? ''
	);
	if (www !== null) await certWithWww(run, www, certName, vals);
	// Only with no www record at all: a www that points elsewhere may be a
	// proxy that hands Let's Encrypt's check on to this server.
	else if (alias !== null && dns !== null && dns.kind === 'none')
		await certWithoutWww(run, domain, alias, certName);

	return finish(run);
}

function finish(run: Run): HealResult {
	if (run.parts.length === 0)
		return {
			strategy: run.strategy,
			verified: true,
			routine: true,
			detail: 'www: nothing to change.'
		};
	return {
		strategy: run.strategy,
		verified: run.verified,
		detail: `www: ${run.parts.join('; ')}.`
	};
}

/** Write the new settings, have BunkerWeb load them; put the old file back
 *  when BunkerWeb refuses them or the site itself stops answering as before.
 *  The ApplyResult, or null when the heal stops here. */
async function applyEnv(
	run: Run,
	envPath: string,
	before: string,
	plan: WwwEnvPlan,
	www: { domain: string; alias: string } | null
): Promise<ApplyResult | null> {
	const { rt, ctx } = run;
	const domain = www?.domain ?? (serverNames(before)[0] ?? '').toLowerCase();
	if (applyWaitMs(rt.timeLeftMs()) === null) {
		run.verified = false;
		run.strategy = 'no-time';
		run.parts.push(
			`${plan.changes.join('; ')}: not done in this run (there was not enough time to restart BunkerWeb): ${later(rt)}`
		);
		return null;
	}
	const siteBefore = domain !== '' ? rt.request(`https://${domain}/`).code : '';
	const copy = rt.backup(envPath, before);
	if (copy === null || !rt.writeFile(envPath, plan.text)) {
		run.verified = false;
		run.strategy = 'left-alone';
		run.parts.push(
			`${envPath} could not be written (nothing was changed): ${plan.changes.join('; ')} still to do`
		);
		return null;
	}
	if (!rt.composeAccepts()) {
		rt.writeFile(envPath, before);
		run.verified = false;
		run.strategy = 'restored';
		run.parts.push(
			`Docker Compose did not accept ${envPath} with the change, so the file was put back as it was`
		);
		return null;
	}
	const res = rt.apply(www !== null ? `${www.alias} added` : 'settings written', true);
	if (res === 'not-restarted' || res === 'no-time') {
		// Written but not loaded: the next run sees the file has it and the
		// running containers do not, and recreates them.
		run.verified = false;
		run.strategy = 'written';
		run.parts.push(
			`${plan.changes.join('; ')} — written to ${envPath} (a copy of the old file: ${copy}), but BunkerWeb's services could not be recreated to load it${res === 'no-time' ? ` in the time left (${later(rt)})` : `; ${recreateHow(rt, envPath)}`}`
		);
		return null;
	}
	const siteAfter = domain !== '' ? rt.request(`https://${domain}/`).code : '';
	// Judged only on BunkerWeb's verdict: while it is still loading
	// ('pending') it serves the old settings, and nothing is concluded.
	const broke =
		res === 'refused' ||
		(res === 'loaded' && answers(siteBefore) && !answers(siteAfter) && siteAfter !== siteBefore);
	if (broke) {
		ctx.warn(
			`www: ${res === 'refused' ? 'BunkerWeb refused the new settings' : `${domain} answered ${siteAfter || 'nothing'} after the change (${siteBefore} before)`}; putting the old settings back.`
		);
		rt.writeFile(envPath, before);
		rt.apply('the previous settings restored', true);
		rt.writeFile(`${copy}.attempted`, plan.text, 0o600);
		run.verified = false;
		run.strategy = 'restored';
		run.parts.push(
			`the change was undone (${envPath} is as it was; the attempted version is kept as ${copy}.attempted), nothing else changed`
		);
		return null;
	}
	run.strategy = 'applied';
	if (res === 'pending')
		run.parts.push('BunkerWeb was still loading its new settings when the checks ran');
	return res;
}

/** A status that means the site answered (not refused, not unreachable). */
function answers(code: string): boolean {
	return /^[1-5]\d\d$/.test(code) && code !== '403' && !/^5/.test(code);
}

/** http://www.<domain>/<path> must answer 301 → https://<domain>/<path>. When
 *  BunkerWeb runs with the rule in its settings and still does not, the rule
 *  is written a second way (a scheduler config file). Nothing is restarted on
 *  no answer at all, or when the running BunkerWeb lacks www. */
function checkRedirect(
	run: Run,
	www: { domain: string; alias: string },
	quietWhenOk: boolean,
	loaded: boolean
): void {
	const { rt, ctx } = run;
	const path = `/morphit-www-check/${randomBytes(4).toString('hex')}?a=1`;
	const probe = (): RequestResult => rt.request(`http://${www.alias}${path}`);
	const good = (r: RequestResult): boolean =>
		r.code === '301' && r.location === `https://${www.domain}${path}`;
	const stop = ctx.spinner(`Checking that ${www.alias} sends visitors to ${www.domain}…`);
	let r: RequestResult;
	try {
		r = probe();
	} finally {
		stop();
	}
	if (!good(r) && r.exit !== 0) {
		run.verified = false;
		run.parts.push(
			`${www.alias} could not be checked on this server (BunkerWeb did not answer on this machine: curl ${r.exit}); nothing was restarted`
		);
		return;
	}
	if (!good(r) && !loaded) {
		run.parts.push(
			`BunkerWeb was still loading its new settings, so ${www.alias} could not be checked yet; the next \`sudo morphit-ops upgrade\` checks it`
		);
		return;
	}
	if (!good(r) && liveHasWww(rt, www) === false) {
		run.verified = false;
		run.parts.push(
			`BunkerWeb still runs without ${www.alias} (it answered ${r.code}): its containers were not created with the settings that name it; ${recreateHow(rt, envPathOf(rt))}`
		);
		return;
	}
	if (!good(r)) {
		const w = rt.writeSchedulerConf('morphit-www-redirect', wwwRedirectConf(www.domain));
		if (w === 'written') {
			rt.apply('the www rule written as a config file', false);
			r = probe();
			if (good(r)) run.strategy = 'applied-config-file';
		}
	}
	if (good(r)) {
		if (!quietWhenOk)
			run.parts.push(
				`http://${www.alias} and https://${www.alias} now send every visitor to https://${www.domain} (checked on this server)`
			);
		return;
	}
	run.verified = false;
	run.parts.push(
		`${liveHasWww(rt, www) === true ? `BunkerWeb runs with ${www.alias} in its settings, but a` : 'A'} test request for ${www.alias} was answered ${r.code}${r.location ? ` → ${r.location}` : ''} instead of being sent on to https://${www.domain}; on this server run: ${COMMAND}`
	);
}

/** Is https://<name>/ served with a certificate this machine trusts? */
function tlsState(rt: WwwRuntime, name: string): 'ok' | 'bad-cert' | 'no-answer' {
	const r = rt.request(`https://${name}/`, { verify: true });
	if (r.exit === 0 && /^[1-5]\d\d$/.test(r.code)) return 'ok';
	return [35, 51, 58, 60].includes(r.exit) ? 'bad-cert' : 'no-answer';
}

/** The certificate gets www.<domain> (with every name it already has). */
async function certWithWww(
	run: Run,
	www: { domain: string; alias: string },
	certName: string | null,
	vals: ReadonlyMap<string, string>
): Promise<void> {
	const { rt, ctx } = run;
	if (certName === null) {
		const auto = (vals.get('AUTO_LETS_ENCRYPT') ?? '').trim().toLowerCase() === 'yes';
		if (auto && tlsState(rt, www.alias) === 'ok') return;
		run.parts.push(
			auto
				? `BunkerWeb asks Let's Encrypt for its own certificate here; https://${www.alias} is secure once it has added ${www.alias} to it`
				: `this server's certificate is not one from this server's certbot, so ${www.alias} could not be added to it; add ${www.alias} to it for https://${www.alias} to be secure`
		);
		return;
	}
	const have = rt.certNames(certName);
	if (have === null) {
		run.verified = false;
		run.parts.push(
			`the certificate /etc/letsencrypt/live/${certName}/ could not be read, so ${www.alias} was not added to it`
		);
		return;
	}
	if (!have.includes(www.domain)) {
		run.verified = false;
		run.parts.push(
			`BunkerWeb's certificate (/etc/letsencrypt/live/${certName}/) names ${have.join(', ') || 'nothing'}, not ${www.domain}, so ${www.alias} was not added to it; point CUSTOM_SSL_CERT and CUSTOM_SSL_KEY in BunkerWeb's settings at ${www.domain}'s certificate`
		);
		return;
	}
	if (have.includes(www.alias)) {
		// Already on it: is it what BunkerWeb serves? Reloaded only on a
		// certificate that fails the check, never on no answer.
		let st = tlsState(rt, www.alias);
		if (st === 'bad-cert') {
			if (rt.apply('the certificate reloaded', false) !== 'no-time') st = tlsState(rt, www.alias);
		}
		if (st !== 'ok') {
			run.verified = false;
			run.parts.push(
				st === 'bad-cert'
					? `the certificate names ${www.alias}, but https://${www.alias} did not pass a certificate check on this server; on this server run: ${COMMAND}`
					: `https://${www.alias} could not be checked on this server (no answer)`
			);
		}
		return;
	}
	if (!rt.certbotPresent()) {
		run.verified = false;
		run.parts.push(
			`certbot is not installed here, so ${www.alias} could not be added to the certificate`
		);
		return;
	}
	if (rt.timeLeftMs() < CERT_STEP_MIN_MS) {
		run.verified = false;
		run.parts.push(
			`${www.alias} was not added to the certificate in this run (not enough time for Let's Encrypt and a reload): ${later(rt)}`
		);
		return;
	}

	// Prove Let's Encrypt's path first: www → https://<domain> → the web build.
	const conf = rt.readFile(`/etc/letsencrypt/renewal/${certName}.conf`) ?? '';
	const webroot = webrootFor(conf, www.domain, rt.buildDir());
	const token = `morphit-www-${randomBytes(8).toString('hex')}`;
	const body = randomBytes(16).toString('hex');
	const probe = join(webroot, '.well-known', 'acme-challenge', token);
	let served = false;
	let stop = ctx.spinner(`Checking that Let's Encrypt can check ${www.alias}…`);
	try {
		if (rt.writeFile(probe, body)) {
			served =
				(rt.fetchFollow(`http://${www.alias}/.well-known/acme-challenge/${token}`) ?? '').trim() ===
				body;
			rt.removeFile(probe);
		}
	} finally {
		stop();
	}
	const args = certbotArgs(
		certName,
		[...have.filter((n) => n !== www.alias), www.alias],
		webroot,
		conf
	);
	const manual = `sudo certbot ${args.join(' ')}`;
	if (!served) {
		run.verified = false;
		run.parts.push(
			`a test file in the web build did not come back from http://${www.alias}/.well-known/acme-challenge/, so Let's Encrypt was not asked (it would have failed); https://${www.alias} is not secure yet. When it does, on this server run: ${manual}`
		);
		return;
	}

	stop = ctx.spinner(`Asking Let's Encrypt to add ${www.alias} to the certificate…`);
	let r: { ok: boolean; out: string };
	try {
		r = rt.certbot(args);
	} finally {
		stop();
	}
	const after = rt.certNames(certName) ?? [];
	if (!after.includes(www.alias)) {
		run.verified = false;
		const why = /too many|rate.?limit/i.test(r.out)
			? "Let's Encrypt says too many certificates were asked for lately"
			: /unauthorized|invalid response|connection|timeout|dns/i.test(r.out)
				? "Let's Encrypt could not check the www name from the internet"
				: 'certbot did not succeed';
		run.parts.push(
			`${why}, so the certificate still names ${have.join(', ')} only (nothing else changed; http://${www.alias} still goes to https://${www.domain}). The next \`sudo morphit-ops upgrade\` tries again, or on this server run: ${manual}`
		);
		return;
	}
	rt.certPermissions();
	rt.apply('the certificate with www loaded', false);
	let st = tlsState(rt, www.alias);
	if (st === 'bad-cert') {
		// A second way: recreate BunkerWeb's services (reads every file again).
		rt.apply('the certificate with www loaded', true);
		st = tlsState(rt, www.alias);
	}
	if (/^true$/i.test(param(conf, 'must_staple') ?? ''))
		run.parts.push(
			"the certificate was issued without OCSP Must-Staple, which its settings asked for: Let's Encrypt no longer issues it"
		);
	if (st === 'ok') {
		run.strategy = run.strategy === 'already' ? 'certificate' : run.strategy;
		run.parts.push(
			`Let's Encrypt added ${www.alias} to the certificate, and https://${www.alias} passes a certificate check on this server`
		);
	} else {
		run.verified = false;
		run.parts.push(
			st === 'bad-cert'
				? `Let's Encrypt added ${www.alias} to the certificate, but BunkerWeb was still serving the old one when checked; it loads the new one within a day by itself, or on this server run: ${COMMAND}`
				: `Let's Encrypt added ${www.alias} to the certificate; https://${www.alias} could not be checked on this server (no answer)`
		);
	}
}

/** The certificate names www.<domain> but www has no DNS record any more:
 *  every renewal would fail, so it is issued again without it. */
async function certWithoutWww(
	run: Run,
	domain: string,
	alias: string,
	certName: string | null
): Promise<void> {
	const { rt, ctx } = run;
	if (certName === null) return;
	const have = rt.certNames(certName);
	if (have === null || !have.includes(alias) || !have.includes(domain) || !rt.certbotPresent())
		return;
	const keep = have.filter((n) => n !== alias);
	const conf = rt.readFile(`/etc/letsencrypt/renewal/${certName}.conf`) ?? '';
	const webroot = webrootFor(conf, domain, rt.buildDir());
	const args = certbotArgs(certName, keep, webroot, conf);
	if (rt.timeLeftMs() < CERT_STEP_MIN_MS) {
		run.verified = false;
		run.parts.push(
			`the certificate names ${alias}, which has no DNS record any more, so its next renewal will fail; there was not enough time in this run to issue it again without ${alias}: ${later(rt)}`
		);
		return;
	}
	const stop = ctx.spinner(`Asking Let's Encrypt for the certificate without ${alias}…`);
	try {
		rt.certbot(args);
	} finally {
		stop();
	}
	const after = rt.certNames(certName) ?? have;
	if (!after.includes(alias)) {
		rt.certPermissions();
		rt.apply('the certificate without www loaded', false);
		run.strategy = 'certificate-without-www';
		run.parts.push(
			`the certificate no longer names ${alias} (it has no DNS record any more, and Let's Encrypt checks every name at each renewal)`
		);
	} else {
		run.verified = false;
		run.parts.push(
			`the certificate names ${alias}, which has no DNS record any more, so its next renewal will fail; point "www" back at this server, or on this server run: sudo ${['certbot', ...args].join(' ')}`
		);
	}
}

// ─── the real box ───────────────────────────────────────────────────────

/** The DNS servers systemd-resolved itself asks (its upstream list), when it
 *  runs: asking them directly skips its stub at 127.0.0.53, which also answers
 *  from /etc/hosts. null when there is no such list. */
export function upstreamResolvers(text: string | null): string[] | null {
	if (text === null) return null;
	const out = [...text.matchAll(/^\s*nameserver\s+(\S+)/gm)]
		.map((m) => m[1]!)
		// A scoped link-local server (fe80::1%2) loses its scope in Node.
		.filter((a) => !/^127\./.test(a) && a !== '::1' && !a.includes('%'));
	return out.length > 0 ? out : null;
}

/** DNS answers for `name` (A and AAAA) from `servers`, or the system's
 *  resolvers. */
export async function dnsLookup(
	name: string,
	servers?: readonly string[],
	opts: { readonly timeoutMs?: number; readonly tries?: number } = {}
): Promise<Lookup> {
	const r = new Resolver({ timeout: opts.timeoutMs ?? 4000, tries: opts.tries ?? 2 });
	if (servers) r.setServers([...servers]);
	const one = async (f: (n: string) => Promise<string[]>): Promise<Lookup> => {
		try {
			return { addrs: await f(name), sure: true };
		} catch (e) {
			const code = (e as { code?: string }).code ?? '';
			return { addrs: [], sure: code === 'ENODATA' || code === 'ENOTFOUND' };
		}
	};
	const [a, aaaa] = await Promise.all([one((n) => r.resolve4(n)), one((n) => r.resolve6(n))]);
	return { addrs: [...a.addrs, ...aaaa.addrs], sure: a.sure && aaaa.sure };
}
