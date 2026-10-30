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
	 *  Compose service sets itself (`environment:`, with their values when
	 *  Compose gives them), and whether it reads the file at all; null when
	 *  Compose could not say. */
	edgeSettingsSource(): {
		readonly readsFile: boolean;
		readonly overrides: readonly string[];
		readonly values?: ReadonlyMap<string, string>;
	} | null;
	/** `nginx -T` inside BunkerWeb's edge: the config it really serves (its
	 *  scheduler generates it from BunkerWeb's DATABASE, not from the
	 *  container's environment), or null when it cannot be read. */
	nginxConfig?(): string | null;
	/** BunkerWeb's site list (its database's bw_services, in the order its
	 *  generator reads it, drafts left out): on a single-site BunkerWeb (1.5, 1.6) the
	 *  names nginx serves are exactly these. null when it cannot be read. */
	siteList?(): SiteList | null;
	/** Add `add` to BunkerWeb's (sqlite) site list as the scheduler's own,
	 *  after a copy of the database, only while `first` stays first; the copy's
	 *  path, or null when nothing was changed. */
	addSiteNames?(add: readonly string[], first: string): { readonly backup: string } | null;
	/** Take out Morphit's second copy of the www rule (the scheduler config
	 *  file `morphit-www-redirect`, and BunkerWeb's database row made from it),
	 *  after a copy of the database; true when it is gone. */
	removeRuleCopy?(): boolean;
	/** The scheduler's own reason when the last apply was refused, or null. */
	lastRefusal?(): string | null;
	/** The exact command that recreates BunkerWeb's services, or null. */
	recreateCommand?(): string | null;
	/** BunkerWeb's container names, for the commands in a message. */
	containerNames?(): { readonly edge: string; readonly scheduler: string | null };
}

/** BunkerWeb's site list as its database holds it. */
export interface SiteList {
	/** sqlite (edited here), another database server, or none found. */
	readonly db: 'sqlite' | 'other' | 'missing';
	/** The site names, in the order BunkerWeb's generator reads them. */
	readonly ids: readonly string[];
}

/** Special server blocks BunkerWeb always has; not a site name. */
const NOT_A_SITE = new Set(['_', 'bwapi', 'healthcheck.bunkerweb.io']);

/** The site names nginx serves (`server_name` lines of an `nginx -T` dump,
 *  BunkerWeb's own special blocks left out). PURE. */
export function nginxServerNames(conf: string): string[] {
	const out: string[] = [];
	for (const m of conf.matchAll(/^\s*server_name\s+([^;]*);/gm)) {
		for (const raw of m[1]!.trim().split(/\s+/)) {
			const n = raw.replace(/^['"]|['"]$/g, '').toLowerCase();
			if (n !== '' && !NOT_A_SITE.has(n) && !out.includes(n)) out.push(n);
		}
	}
	return out;
}

/** The config files (base names, without .conf) of an `nginx -T` dump that
 *  hold the www rule for `domain`. PURE. */
export function nginxRuleFiles(conf: string, domain: string): string[] {
	const rule = wwwRedirectConf(domain);
	const out: string[] = [];
	let file = '';
	for (const line of conf.split('\n')) {
		const h = /^# configuration file (.+):\s*$/.exec(line);
		if (h) {
			file = h[1]!.slice(h[1]!.lastIndexOf('/') + 1).replace(/\.conf$/, '');
			continue;
		}
		if (line.trim() === rule && !out.includes(file)) out.push(file);
	}
	return out;
}

/** The scheduler config file Morphit wrote (the "second way"). */
export const WWW_RULE_FILE = 'morphit-www-redirect';
/** The config BunkerWeb makes from WWW_REDIRECT_KEY ("CREATED BY ENV"). */
const WWW_RULE_FROM_ENV = WWW_REDIRECT_KEY.replace(/^CUSTOM_CONF_SERVER_HTTP_/, '');

/**
 * Run inside BunkerWeb's scheduler (`docker exec -i -e MODE=… <scheduler>
 * python3 -c …`; its image ships python3 and sqlite3). Its database is the one
 * in its DATABASE_URI (BunkerWeb's default sqlite:////var/lib/bunkerweb/db.sqlite3,
 * which /data/lib holds in its container).
 *  - MODE=list: the site list (bw_services, drafts left out), in the order
 *    BunkerWeb's generator reads it (no ORDER BY: the table's own order).
 *  - MODE=add: the names in ADD join the site list as the scheduler's own
 *    (method "scheduler", so its save keeps them while SERVER_NAME names them
 *    and drops them once it does not), after a copy of the database next to
 *    it; only while FIRST is the first site and none of them is there yet, and
 *    undone unless FIRST is still first afterwards. BunkerWeb 1.6's table also
 *    has creation_date / last_update (NOT NULL): filled the way BunkerWeb
 *    writes them (local time), when the table has them. Anything that fails
 *    leaves the database as it was and removes the copy (v1.21.18 audit, M5:
 *    on 1.6 every upgrade left one more copy behind).
 *  - MODE=unrule: Morphit's second copy of the www rule (database rows named
 *    morphit-www-redirect, and its files) goes, after a copy of the database —
 *    made only when there is a row to take out (L2).
 */
export const WWW_DB_PY = String.raw`
import json, os, re, shutil, sqlite3, sys, time
from datetime import datetime
MODE = os.environ.get("MODE", "")
URI = os.environ.get("DATABASE_URI") or "sqlite:////var/lib/bunkerweb/db.sqlite3"
m = re.match(r"^sqlite(?:\+pysqlite)?:///(.+)$", URI)
DB = m.group(1) if m else None
if DB is not None and not os.path.isfile(DB) and os.path.isfile("/data/lib/db.sqlite3"):
    DB = "/data/lib/db.sqlite3"
def backup(s, tag):
    bk = os.path.join(os.path.dirname(DB), "db.pre-morphit-%s-%d.sqlite3" % (tag, int(time.time())))
    d = sqlite3.connect(bk)
    s.backup(d)
    d.close()
    return bk
if DB is None:
    print(json.dumps({"db": "other", "ids": []}))
    sys.exit(0)
if not os.path.isfile(DB):
    print(json.dumps({"db": "missing", "ids": []}))
    sys.exit(0)
if MODE == "list":
    c = sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=30)
    ids = [r[0] for r in c.execute("SELECT id FROM bw_services WHERE is_draft = 0")]
    print(json.dumps({"db": "sqlite", "ids": ids}))
elif MODE == "add":
    add = [n for n in os.environ["ADD"].split(" ") if n]
    first = os.environ["FIRST"]
    s = sqlite3.connect(DB, timeout=30)
    have = [r[0] for r in s.execute("SELECT id FROM bw_services")]
    if not add or have[:1] != [first] or any(n in have for n in add):
        print(json.dumps({"added": 0}))
        sys.exit(0)
    cols = [r[1] for r in s.execute("PRAGMA table_info(bw_services)")]
    dated = "creation_date" in cols and "last_update" in cols
    bk = backup(s, "sites")
    try:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")
        for n in add:
            if dated:
                s.execute("INSERT INTO bw_services (id, method, is_draft, creation_date, last_update) VALUES (?, 'scheduler', 0, ?, ?)", (n, now, now))
            else:
                s.execute("INSERT INTO bw_services (id, method, is_draft) VALUES (?, 'scheduler', 0)", (n,))
        ids = [r[0] for r in s.execute("SELECT id FROM bw_services WHERE is_draft = 0")]
        if ids[:1] != [first] or any(n not in ids for n in add):
            raise ValueError("the domain would not stay first in the site list")
        s.commit()
    except Exception as e:
        s.rollback()
        s.close()
        os.remove(bk)
        print(json.dumps({"added": 0, "error": str(e)[:200]}))
        sys.exit(0)
    s.close()
    print(json.dumps({"added": len(add), "backup": bk}))
elif MODE == "unrule":
    name = os.environ["NAME"]
    s = sqlite3.connect(DB, timeout=30)
    q = "FROM bw_custom_configs WHERE name = ? AND method != 'scheduler'"
    bk = None
    n = 0
    if s.execute("SELECT COUNT(*) " + q, (name,)).fetchone()[0] > 0:
        bk = backup(s, "www-rule")
        n = s.execute("DELETE " + q, (name,)).rowcount
        s.commit()
    s.close()
    moved = 0
    dest = os.path.join(os.path.dirname(DB), "morphit-removed-configs")
    for root in ("/data/configs", "/etc/bunkerweb/configs"):
        p = os.path.join(root, "server-http", name + ".conf")
        if os.path.isfile(p):
            os.makedirs(dest, exist_ok=True)
            shutil.move(p, os.path.join(dest, "%d-%s.conf" % (int(time.time()), name)))
            moved += 1
    print(json.dumps({"rows": n, "moved": moved, "backup": bk}))
`;

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
/** How the operator makes BunkerWeb read its settings file again: the exact
 *  Compose command when there is one (never "run the upgrade again", which
 *  would only try the same thing). */
function recreateHow(rt: WwwRuntime, envPath: string): string {
	if (!rt.composeManaged())
		return `recreate the BunkerWeb container with the settings in ${envPath} (it was not started by Docker Compose)`;
	const cmd = rt.recreateCommand?.() ?? null;
	return `on this server run: ${cmd ?? COMMAND}`;
}
/** The settings file's path, for a message. */
function envPathOf(rt: WwwRuntime): string {
	return rt.envFile().path ?? "BunkerWeb's settings file";
}
/** sha256 of a settings file's text (the marker of a recreate already tried). */
function textHash(t: string): string {
	return createHash('sha256').update(t).digest('hex');
}
/** "it needs a look" with the one thing to send. */
function needsLook(what: string): string {
	return `it needs a look: send the output of, on this server: ${what}`;
}
function names(rt: WwwRuntime): { edge: string; scheduler: string } {
	const n = rt.containerNames?.() ?? null;
	return {
		edge: n?.edge || '<BunkerWeb container>',
		scheduler: n?.scheduler || '<BunkerWeb scheduler container>'
	};
}

/** Does the running BunkerWeb's CONTAINER ENVIRONMENT name www (in its
 *  SERVER_NAME, with the rule)? null when it cannot be read. This is what the
 *  containers were created with — not necessarily what nginx serves. */
function liveHasWww(rt: WwwRuntime, www: { domain: string; alias: string }): boolean | null {
	const live = rt.liveEnv();
	if (live === null) return null;
	const n = (live.get('SERVER_NAME') ?? '').trim().split(/\s+/);
	return n.includes(www.alias) && live.get(WWW_REDIRECT_KEY) === wwwRedirectConf(www.domain);
}

/** What BunkerWeb really serves for www. */
interface Served {
	/** Read from the nginx it runs, or (when that cannot be read) from its
	 *  containers' environment. */
	readonly from: 'nginx' | 'env';
	/** www.<domain> is one of its site names. */
	readonly name: boolean;
	/** The site names it serves. */
	readonly names: readonly string[];
	/** The config files holding the www rule (nginx), or [KEY] (env). */
	readonly ruleFiles: readonly string[];
}

/** What BunkerWeb serves, judged from the RUNNING nginx config (its
 *  scheduler builds that from its database, which can differ from the
 *  container environment — morphit.io, v1.21.17); from the environment only
 *  when nginx cannot be read. null when neither can. */
function servedWww(rt: WwwRuntime, www: { domain: string; alias: string }): Served | null {
	const conf = rt.nginxConfig?.() ?? null;
	if (conf !== null) {
		const n = nginxServerNames(conf);
		return {
			from: 'nginx',
			name: n.includes(www.alias),
			names: n,
			ruleFiles: nginxRuleFiles(conf, www.domain)
		};
	}
	const live = rt.liveEnv();
	if (live === null) return null;
	const n = (live.get('SERVER_NAME') ?? '').trim().split(/\s+/).filter(Boolean);
	return {
		from: 'env',
		name: n.includes(www.alias),
		names: n,
		ruleFiles: live.get(WWW_REDIRECT_KEY) === wwwRedirectConf(www.domain) ? [WWW_RULE_FROM_ENV] : []
	};
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
	const siteNames = serverNames(before);
	const domain = (siteNames[0] ?? '').toLowerCase();
	const run: Run = { ctx, rt, parts: [], verified: true, strategy: 'already' };

	// Which www work applies here.
	let www: { domain: string; alias: string } | null = null;
	let dns: WwwDns | null = null;
	const alias = domain !== '' && !/[{$]/.test(domain) ? wwwAliasFor(domain) : null;
	// What else decides BunkerWeb's settings: asked once, only when there is a www.
	const src = alias !== null ? rt.edgeSettingsSource() : null;
	// MULTISITE where BunkerWeb takes it from: its Compose service's own
	// `environment:` entry wins over the file (v1.21.18 audit: one set there
	// made the heal treat a multi-site BunkerWeb as a single site). A value
	// Compose does not give is read from the running edge; unknown, nothing
	// is changed.
	let multisiteVal: string | null = vals.get('MULTISITE') ?? 'no';
	if (src !== null && src.overrides.includes('MULTISITE')) {
		const v = src.values?.get('MULTISITE');
		multisiteVal = v !== undefined && !/\$/.test(v) ? v : (rt.liveEnv()?.get('MULTISITE') ?? null);
	}
	const multisite = multisiteVal !== null && multisiteVal.trim().toLowerCase() === 'yes';
	if (alias !== null && multisiteVal === null) {
		run.parts.push(
			`BunkerWeb's Compose service sets MULTISITE itself and its value could not be read, so ${alias} was left as it is (whether BunkerWeb runs one site or several decides where www goes)`
		);
	} else if (alias !== null && multisite) {
		run.parts.push(
			`BunkerWeb runs several sites here (MULTISITE=yes${src?.overrides.includes('MULTISITE') ? ", set in its Compose service's environment" : ''}), so ${alias} was left as it is; to add it, put it in that site's SERVER_NAME and its certificate`
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
	let recreated = false;
	if (plan.changes.length > 0) {
		const res = await applyEnv(run, envPath, before, plan, www);
		if (res === null) return finish(run);
		loaded = res === 'loaded';
		recreated = true;
	}
	// The file has www (a fresh install's, an earlier run's, or this run's):
	// is it what BunkerWeb really serves? (Not while it is still loading.)
	if (www !== null && loaded) {
		const served = servedWww(rt, www);
		// Not served — or the rule is not, and the containers were created
		// without it (a recreate gives them the file's).
		if (
			served !== null &&
			(!served.name || (served.ruleFiles.length === 0 && liveHasWww(rt, www) === false))
		) {
			const now = rt.readFile(envPath) ?? plan.text;
			const res = bringWwwLive(run, envPath, now, www, served, recreated);
			if (res === null) return finish(run);
			loaded = res === 'loaded';
		}
	}
	const redirectOk =
		www !== null ? checkRedirect(run, www, plan.changes.length === 0, loaded) : true;

	// 3. The certificate — only once www itself works: Let's Encrypt fetches its
	// check through it, and the next upgrade adds www to the certificate by
	// itself once it does.
	const certName = certNameOf(
		envValues(rt.readFile(envPath) ?? before).get('CUSTOM_SSL_CERT') ?? ''
	);
	if (www !== null && redirectOk) await certWithWww(run, www, certName, vals);
	else if (www !== null && certName !== null && !(rt.certNames(certName) ?? []).includes(www.alias))
		run.parts.push(
			`https://${www.alias} is not secure yet: the next upgrade adds it to the certificate by itself once ${www.alias} works`
		);
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

/** The marker of an automatic attempt already made for one version of the
 *  settings file: "v2 <sha256>" and, on the next line, what was found then
 *  (said again on every later run instead of trying the same thing). */
const MARKER_VERSION = 'v2';

/**
 * The settings file names www, but the nginx BunkerWeb runs does not serve it.
 * One automatic attempt per version of the file:
 *  - its containers were created with www, and BunkerWeb's site list lacks it:
 *    BunkerWeb (1.5 and 1.6, single site) serves exactly the names in its site list
 *    (Database.get_non_default_settings rebuilds SERVER_NAME from bw_services)
 *    and only ever puts the FIRST name of SERVER_NAME there (save_config), so
 *    www is dropped however often it is recreated (morphit.io, v1.21.17). The
 *    missing names join the list as the scheduler's own (sqlite only, after a
 *    copy of the database; the domain stays first), and the scheduler is
 *    restarted so it generates its config again;
 *  - otherwise its services are recreated (they read the file again).
 * Then nginx is read again. When www is still not served, the real cause is
 * named in one sentence with the one manual step that changes something (or
 * what to send for a look), kept in the marker and said again on later runs.
 * The ApplyResult, or null when the heal stops here.
 */
function bringWwwLive(
	run: Run,
	envPath: string,
	before: string,
	www: { domain: string; alias: string },
	served: Served,
	/** This run has just recreated BunkerWeb's services with this file. */
	recreated = false
): ApplyResult | null {
	const { rt } = run;
	const fail = (strategy: string, part: string): null => {
		run.verified = false;
		run.strategy = strategy;
		run.parts.push(part);
		return null;
	};
	const wanted = serverNames(before).map((n) => n.toLowerCase());
	const lookLogs = needsLook(`sudo docker logs --tail 50 ${names(rt).scheduler}`);
	const containersHave = liveHasWww(rt, www) === true;
	const sites = served.from === 'nginx' ? (rt.siteList?.() ?? null) : null;
	// BunkerWeb's containers have www and nginx does not serve it, and its site
	// list is not in a sqlite file this upgrade edits: recreating its services
	// cannot change the list (v1.21.18 audit, M4: they were recreated — the
	// site down meanwhile — and the run ended with a sentence that blamed
	// nginx). Said plainly, with the one step that adds it; nothing restarted.
	if (containersHave && sites !== null && sites.db !== 'sqlite')
		return fail(
			'left-alone',
			sites.db === 'other'
				? `BunkerWeb serves only the names in its own site list, and keeps that list in a database server (its DATABASE_URI is not a sqlite file), which this upgrade does not edit, so ${www.alias} was not added and BunkerWeb was not restarted. To add it: in that database's bw_services table, add a row for ${www.alias} like the row for ${www.domain} (method "scheduler", is_draft 0), then on this server: sudo docker restart ${names(rt).scheduler}`
				: `BunkerWeb serves only the names in its own site list, and its database file was not found in its scheduler (where its DATABASE_URI points), so ${www.alias} was not added and BunkerWeb was not restarted; ${lookLogs}`
		);
	const marker = `${envPath}.www-recreated`;
	const [head = '', ...rest] = (rt.readFile(marker) ?? '').split('\n');
	if (head.trim() === `${MARKER_VERSION} ${textHash(before)}`) {
		const said = rest.join(' ').trim();
		return fail(
			'not-loaded',
			said !== ''
				? said
				: `${envPath} names ${www.alias}, but BunkerWeb still runs without it after its services were recreated with this file; ${needsLook(`sudo docker logs --tail 50 ${names(rt).scheduler}`)}`
		);
	}
	const missing = (l: SiteList | null): string[] =>
		l === null ? [] : wanted.filter((n) => !l.ids.includes(n));
	let fixed: string | null = null;
	let res: ApplyResult;
	if (
		containersHave &&
		sites !== null &&
		sites.ids[0] === www.domain &&
		missing(sites).length > 0
	) {
		const add = missing(sites);
		const kept = `BunkerWeb kept only ${sites.ids.join(' ')} as this site's name (it serves the names in its own site list, and puts only the first name of SERVER_NAME there)`;
		if (rt.addSiteNames === undefined)
			return fail(
				'left-alone',
				`${kept}; ${add.join(' and ')} could not be added there from here; ${lookLogs}`
			);
		if (applyWaitMs(rt.timeLeftMs()) === null)
			return fail(
				'no-time',
				`${kept}; there was not enough time in this run to add ${add.join(' and ')}: ${later(rt)}`
			);
		const done = rt.addSiteNames(add, www.domain);
		if (done === null)
			return fail(
				'left-alone',
				`${kept}; ${add.join(' and ')} could not be added to its site list from here; ${lookLogs}`
			);
		fixed = `${kept}; added ${add.join(' and ')} to its site list (the database as it was is kept in BunkerWeb's scheduler at ${done.backup})`;
		res = rt.apply(`${add.join(' and ')} added to BunkerWeb's site list`, false);
	} else if (recreated) {
		// Just recreated with this file in this run: doing it again changes
		// nothing; what it left is judged below.
		res = 'loaded';
	} else {
		// The containers lack it (or the site list could not be read): recreating
		// BunkerWeb's services makes them read the file again.
		res = rt.apply(`${www.alias} loaded from ${envPath}`, true);
	}
	if (res === 'no-time')
		return fail(
			'not-loaded',
			`${envPath} names ${www.alias}, but BunkerWeb still runs without it; there was not enough time in this run to recreate its services: ${later(rt)}`
		);
	if (res === 'not-restarted')
		return fail(
			'not-loaded',
			fixed !== null
				? `${fixed}, but BunkerWeb's scheduler could not be restarted to use it; on this server run: sudo docker restart ${names(rt).scheduler}`
				: `${envPath} names ${www.alias}, but BunkerWeb still runs without it (a container keeps the settings it was created with) and its services could not be recreated automatically; ${recreateHow(rt, envPath)}`
		);
	if (fixed !== null) run.parts.push(fixed);
	if (res === 'pending') {
		// Still rebuilding: nothing concluded, nothing marked (the next upgrade
		// looks again); the redirect check says it could not be checked yet.
		run.strategy = fixed !== null ? 'site-list' : 'loaded';
		return 'pending';
	}
	const after = servedWww(rt, www);
	if (res === 'loaded' && after !== null && after.name) {
		run.strategy = fixed !== null ? 'site-list' : 'loaded';
		return 'loaded';
	}
	// The automatic options for this version of the file are used up: the cause,
	// in one sentence, with the one step that changes something.
	let cause: string;
	if (res === 'refused')
		cause = `BunkerWeb's scheduler refused its new config with ${www.alias} ("${rt.lastRefusal?.() ?? 'its own config test failed'}"), so it still serves its previous config; correct what that names in ${envPath}, and the next upgrade tries again by itself`;
	else if (liveHasWww(rt, www) === false)
		cause = `BunkerWeb's services were recreated, but its containers still run without ${www.alias} in their settings, so they are not created from ${envPath} as it is now; ${needsLook(`sudo docker inspect ${names(rt).edge} --format '{{json .Config.Env}}'`)}`;
	else
		cause = `BunkerWeb runs with ${www.alias} in its settings${fixed !== null ? ' and in its site list' : ''} and its scheduler reported no error, but the nginx it runs still answers only for ${(after?.names ?? served.names).join(' ') || 'other names'}; ${lookLogs}`;
	rt.writeFile(marker, `${MARKER_VERSION} ${textHash(before)}\n${cause}\n`, 0o600);
	return fail('not-loaded', cause);
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

/** The control request (http://<domain>/<path>, the same way as the www
 *  test) answered as a working site does: sent on to https://<domain>/<path>,
 *  or a page. PURE. */
function controlAnswers(r: RequestResult, domain: string, path: string): boolean {
	if (r.exit !== 0) return false;
	if (/^30[1278]$/.test(r.code)) return r.location.startsWith(`https://${domain}`);
	return /^2\d\d$/.test(r.code) || (r.code === '404' && path !== '');
}

/** http://www.<domain>/<path> must answer 301 → https://<domain>/<path>. A
 *  control request for the domain itself, the same way, tells "www is not
 *  set up" apart from "this server cannot be checked from itself". When nginx
 *  serves www but not the rule, the rule is written a second way (a scheduler
 *  config file), once. When it works and the rule is there twice, Morphit's
 *  second copy is taken out. True when www sends visitors on. */
function checkRedirect(
	run: Run,
	www: { domain: string; alias: string },
	quietWhenOk: boolean,
	loaded: boolean
): boolean {
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
		return false;
	}
	if (!good(r)) {
		const c = rt.request(`http://${www.domain}${path}`);
		if (!controlAnswers(c, www.domain, path)) {
			run.verified = false;
			run.strategy = 'unchecked';
			run.parts.push(
				`${www.alias} could not be checked from this server: a test request for ${www.domain} itself, made the same way, was answered ${c.exit !== 0 ? 'with nothing' : c.code} instead of as usual, so nothing was changed`
			);
			return false;
		}
	}
	if (!good(r) && !loaded) {
		run.verified = false;
		run.parts.push(
			`BunkerWeb was still loading its new settings, so ${www.alias} could not be checked yet; the next \`sudo morphit-ops upgrade\` checks it`
		);
		return false;
	}
	let served = good(r) ? null : servedWww(rt, www);
	if (!good(r) && served !== null && !served.name) {
		// Only when BunkerWeb's settings were not read before this check (they
		// are, whenever they can be): the next upgrade tries to load them.
		run.verified = false;
		run.parts.push(
			`BunkerWeb still runs without ${www.alias} (it answered ${r.code}); ${recreateHow(rt, envPathOf(rt))}`
		);
		return false;
	}
	let wrote: 'written' | 'unchanged' | 'failed' | null = null;
	// The second way only when the nginx BunkerWeb runs is SEEN to serve www
	// without the rule (never on a guess: on morphit.io a guess from the
	// container environment wrote a second copy of a rule that was loaded).
	if (!good(r) && served !== null && served.from === 'nginx' && served.ruleFiles.length === 0) {
		wrote = rt.writeSchedulerConf(WWW_RULE_FILE, wwwRedirectConf(www.domain));
		if (wrote === 'written') {
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
		dedupeRule(run, www, probe, good);
		return true;
	}
	run.verified = false;
	served = servedWww(rt, www);
	const where =
		served?.from === 'nginx' && served.ruleFiles.length > 0
			? 'although the nginx BunkerWeb runs serves that name and has the rule'
			: wrote === 'unchanged' || wrote === 'written'
				? `although the rule is in ${envPathOf(rt)} and in BunkerWeb's config folder`
				: `although the rule is in ${envPathOf(rt)}`;
	run.parts.push(
		`a test request on this server for ${www.alias} was answered ${r.code}${r.location ? ` → ${r.location}` : ''} instead of being sent on to https://${www.domain}, ${where}; ${needsLook(`sudo docker exec ${names(rt).edge} nginx -T | grep -n -e server_name -e '${www.alias}'`)}`
	);
	return false;
}

/** www works and BunkerWeb runs the rule from its settings AND from Morphit's
 *  scheduler config file (the second way of an earlier upgrade): the file's
 *  copy goes, BunkerWeb reloads, and www is checked again; only when BunkerWeb
 *  refused its new config or www then fails is the file written back. Still
 *  loading ('pending', a slow box) is neither: the copy stays out, and the
 *  next upgrade sees what BunkerWeb runs (v1.21.18 audit, L2: writing it back
 *  then repeated the whole round on every upgrade, a database copy and a moved
 *  file each time). Nothing when there is no time for a reload. */
function dedupeRule(
	run: Run,
	www: { domain: string; alias: string },
	probe: () => RequestResult,
	good: (r: RequestResult) => boolean
): void {
	const { rt } = run;
	if (rt.removeRuleCopy === undefined) return;
	const s = servedWww(rt, www);
	if (s?.from !== 'nginx') return;
	if (!s.ruleFiles.includes(WWW_RULE_FROM_ENV) || !s.ruleFiles.includes(WWW_RULE_FILE)) return;
	if (applyWaitMs(rt.timeLeftMs()) === null) return;
	if (!rt.removeRuleCopy()) return;
	const res = rt.apply('the second copy of the www rule taken out', false);
	const works = res === 'loaded' && good(probe());
	if (works) {
		run.strategy = run.strategy === 'already' ? 'deduplicated' : run.strategy;
		run.parts.push(
			`BunkerWeb had the www rule twice (from ${envPathOf(rt)} and from the config file ${WWW_RULE_FILE}.conf an earlier upgrade wrote); that file's copy was taken out`
		);
		return;
	}
	if (res !== 'refused' && res !== 'loaded') return;
	// Put it back as it was: www worked with both.
	if (rt.writeSchedulerConf(WWW_RULE_FILE, wwwRedirectConf(www.domain)) === 'written')
		rt.apply('the config file copy of the www rule put back', false);
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
					? `the certificate names ${www.alias}, but https://${www.alias} did not pass a certificate check on this server after BunkerWeb reloaded it; ${recreateHow(rt, envPathOf(rt))}`
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
				? `Let's Encrypt added ${www.alias} to the certificate, but BunkerWeb was still serving the old one when checked; it loads the new one within a day by itself`
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
