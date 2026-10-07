/**
 * BunkerWeb settings that send something about a visitor off this box, and
 * the value Morphit gives each one.
 *
 * WHY. BunkerWeb 1.5 ships with several features ON that disclose visitors to
 * third parties (read from the 1.5.10 sources, src/common/core/*):
 *  - BunkerNet (USE_BUNKERNET=yes): every request BunkerWeb blocks is POSTed to
 *    api.bunkerweb.io with the visitor's address, the URL with its query string
 *    and ALL request headers.
 *  - DNSBL (USE_DNSBL=yes): every visitor address is looked up at Spamhaus,
 *    SORBS and blocklist.de.
 *  - blacklist (USE_BLACKLIST=yes): a reverse-DNS query for every visitor
 *    address (whatever BLACKLIST_RDNS holds), Tor exits answered 403 from a
 *    list downloaded from dan.me.uk, and the operator's ASN blocks.
 *  - whitelist (USE_WHITELIST=yes): another reverse-DNS query per visitor.
 *  - greylist: off by default; kept off.
 *  - SEND_ANONYMOUS_REPORT=yes: a daily report about this server to the
 *    BunkerWeb maintainers.
 *  - anti-bot in recaptcha / hcaptcha / turnstile mode makes the visitor's
 *    browser load Google's, hCaptcha's or Cloudflare's script.
 *  - reverse scan (USE_REVERSE_SCAN, off by default; kept off): connects back
 *    to each visitor's own address to probe its ports.
 *  - metrics (USE_METRICS=yes): the last 100 blocked requests, each with the
 *    visitor's address, the full URL (which can name an account) and the user
 *    agent, kept in memory with no time limit and served on BunkerWeb's API.
 * Turning the blacklist off drops what an operator listed in it; its plain
 * addresses and networks keep working from this server's own data (an nginx
 * `deny` conf), its ASN, reverse-DNS, user-agent and URL lists cannot (each
 * needs the plugin, which reverse-resolves every visitor) and are named.
 * Morphit turns all of them off. Four scheduler jobs that no setting gates
 * (GeoIP from db-ip.com, the release check at api.github.com, Pro plugins
 * from assets.bunkerity.com) are taken out by Morphit's job lists instead
 * (lib/bunkerwebJobsHeal.ts), so BunkerWeb contacts no one.
 *
 * WHERE IT IS CHECKED. BunkerWeb does not read its env file directly: the
 * scheduler saves the settings in its database, generates the nginx config and
 * `/etc/nginx/variables.env` from them, pushes both to the edge and reloads it;
 * the edge's Lua code loads its settings from that variables.env at every
 * (re)load. That file inside the edge container is therefore what BunkerWeb
 * really runs with, and the heal reads it there (bunkerwebSettingsProblems).
 *
 * A SETTING SAVED IN BUNKERWEB'S WEB UI. The database row of a setting saved
 * through BunkerWeb's web UI has method "ui", and 1.5.10's
 * Database.save_config only replaces a row whose method is the caller's: the
 * scheduler (method "scheduler") never overwrites it with the env file's
 * value. So a country list saved there survives any edit of the env file.
 * COUNTRY_DB_PY (below; run by the heal inside the scheduler, whose image
 * ships python3 and sqlite3) lists the saved country lists with their method
 * and removes the "ui" ones after a backup, then flags the plugin as changed,
 * which the running scheduler polls (Database.check_changes) to rebuild.
 *
 * Everything here is PURE (COUNTRY_DB_PY is text the heal runs elsewhere).
 */

import { isIP } from 'node:net';

export interface PrivacySetting {
	readonly key: string;
	/** Morphit's value. */
	readonly value: string;
	/** BunkerWeb 1.5.10's default when the key is absent. */
	readonly bunkerwebDefault: string;
	/** What the feature does when it is on (for operator-facing lines). */
	readonly what: string;
}

export const BUNKERWEB_PRIVACY_SETTINGS: readonly PrivacySetting[] = [
	{
		key: 'USE_BUNKERNET',
		value: 'no',
		bunkerwebDefault: 'yes',
		what: 'BunkerNet, which reports each blocked visitor (address, URL, headers) to api.bunkerweb.io'
	},
	{
		key: 'USE_DNSBL',
		value: 'no',
		bunkerwebDefault: 'yes',
		what: 'DNS blocklists, which look up every visitor address at Spamhaus, SORBS and blocklist.de'
	},
	{
		key: 'USE_BLACKLIST',
		value: 'no',
		bunkerwebDefault: 'yes',
		what: 'the blacklist, which reverse-resolves every visitor address and turns away Tor and VPN users'
	},
	{
		key: 'USE_WHITELIST',
		value: 'no',
		bunkerwebDefault: 'yes',
		what: 'the whitelist, which reverse-resolves every visitor address'
	},
	{
		key: 'USE_GREYLIST',
		value: 'no',
		bunkerwebDefault: 'no',
		what: 'the greylist, which reverse-resolves every visitor address'
	},
	{
		key: 'SEND_ANONYMOUS_REPORT',
		value: 'no',
		bunkerwebDefault: 'yes',
		what: "BunkerWeb's daily usage report to its maintainers"
	},
	{
		key: 'USE_METRICS',
		value: 'no',
		bunkerwebDefault: 'yes',
		what: "metrics, which keep the last 100 blocked requests (each one's address, URL and user agent) in memory with no time limit"
	},
	{
		key: 'USE_REVERSE_SCAN',
		value: 'no',
		bunkerwebDefault: 'no',
		what: "reverse scan, which connects back to each visitor's address to probe its ports"
	},
	// v1.21.1 — no Morphit instance turns visitors away by country: people behind
	// national firewalls must be able to reach the instance of their choice. An
	// empty list is BunkerWeb's default and means no country rule at all.
	{
		key: 'BLACKLIST_COUNTRY',
		value: '',
		bunkerwebDefault: '',
		what: 'country blocks, which turn away every visitor from the listed countries (no Morphit instance blocks by country)'
	},
	{
		key: 'WHITELIST_COUNTRY',
		value: '',
		bunkerwebDefault: '',
		what: 'the country allow-list, which turns away every visitor from any other country (no Morphit instance blocks by country)'
	}
];

/** BunkerWeb 1.5.10 defaults for the anti-bot keys the planner reads. */
const ANTIBOT_DEFAULT = 'no';
const ANTIBOT_URI_DEFAULT = '/challenge';
/** Anti-bot modes whose challenge page loads a third party's script. */
const THIRD_PARTY_ANTIBOT = new Set(['recaptcha', 'hcaptcha', 'turnstile']);
/** An anti-bot URI on a live Morphit path hides that path behind the challenge. */
const LIVE_PATH = /^\/(v1|relay|rss|ipfs|ipns|mcp)(\/|$)/;

/** One entry of an env file, as Docker Compose reads it. */
export interface EnvEntry {
	readonly key: string;
	/** The value Compose hands the container. */
	readonly value: string;
	/** First and last line (0-based) of the entry: a quoted value may run on. */
	readonly first: number;
	readonly last: number;
	/** What stands before the key on its line (indent, `export `). */
	readonly pre: string;
}

/** Where `quote` closes in `s` (a `"` escaped by a backslash does not); -1 if not. */
function closingQuote(s: string, quote: string): number {
	for (let i = 0; i < s.length; i++) {
		if (quote === '"' && s[i] === '\\') {
			i++;
			continue;
		}
		if (s[i] === quote) return i;
	}
	return -1;
}

const DOUBLE_ESCAPES: Readonly<Record<string, string>> = {
	n: '\n',
	r: '\r',
	t: '\t',
	'\\': '\\',
	'"': '"'
};

/**
 * The entries of an env file, read the way Docker Compose reads them
 * (compose-go's dotenv parser; every rule below was checked against
 * `docker compose config` v5.5.1): blank and `#` lines skipped; an optional
 * `export ` (any spaces); a key of letters, digits and `_ . - [ ]` (it may
 * start with a digit: `3dshop.example_BLACKLIST_COUNTRY`); `=` or `:`, with
 * spaces or tabs around it; a value in single quotes (literal) or double
 * quotes (`\n \r \t \\ \"` unescaped) that may run over several lines and
 * ignores what follows the closing quote; else the rest of the line, cut at
 * ` #` and with trailing blanks removed. A line Compose would refuse (a space
 * inside the key, a `$` in it) gives no entry. PURE.
 */
export function envEntries(text: string): EnvEntry[] {
	const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
	const out: EnvEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*(?:export\s+)?)([\p{L}\p{N}_.\-[\]]+)[ \t]*[=:](.*)$/u.exec(lines[i]!);
		if (!m) continue;
		const rest = m[3]!.replace(/^[ \t]+/, '');
		const q = rest[0];
		let value: string;
		let last = i;
		if (q === "'" || q === '"') {
			let body = rest.slice(1);
			let acc = '';
			let j = i;
			let at = closingQuote(body, q);
			while (at < 0 && j + 1 < lines.length) {
				acc += `${body}\n`;
				body = lines[++j]!;
				at = closingQuote(body, q);
			}
			if (at < 0) {
				// Unterminated: Compose refuses the whole file. Read the line as it is.
				value = rest.replace(/[ \t]+$/, '');
			} else {
				acc += body.slice(0, at);
				value =
					q === '"' ? acc.replace(/\\(.)/gs, (all, c: string) => DOUBLE_ESCAPES[c] ?? all) : acc;
				last = j;
			}
		} else {
			const c = rest.indexOf(' #');
			value = (c >= 0 ? rest.slice(0, c) : rest).replace(/[ \t]+$/, '');
		}
		out.push({ key: m[2]!, value, first: i, last, pre: m[1]! });
		i = last;
	}
	return out;
}

/** The values of an env file; the last entry of a key wins, as in Compose. PURE. */
export function envValues(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of envEntries(text)) out.set(e.key, e.value);
	return out;
}

/** Every entry of `key` in `text` becomes one `key=val` line (indent and
 *  `export` kept); with none, `key=val` is appended. PURE. */
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

/** The countries in a country-list value ("CN IR" → "CN, IR"). PURE. */
function countriesOf(values: readonly string[]): string {
	return [...new Set(values.flatMap((v) => v.split(/\s+/)).filter(Boolean))].join(', ');
}

/**
 * The operator's line for a country list that no longer applies, naming the
 * countries it unblocks: `how` says what was done to it ("emptied", or that a
 * list saved in BunkerWeb's web UI was removed from its database). PURE.
 */
export function countryChangeLine(key: string, values: readonly string[], how: string): string {
	const list = countriesOf(values);
	const m = /^(?:(.+)_)?(BLACKLIST|WHITELIST)_COUNTRY$/.exec(key);
	const site = m?.[1] ? ` for ${m[1]}` : '';
	return m?.[2] === 'WHITELIST'
		? `BunkerWeb: the country allow-list${site} — off: visitors from every country, not only ${list}, can reach this instance (${key} ${how}; no Morphit instance blocks by country)`
		: `BunkerWeb: country blocks${site} — off: visitors from ${list} are no longer turned away (${key} ${how}; no Morphit instance blocks by country)`;
}

/** What BunkerWeb runs with for `key`: the file's value, else its default. */
export function effectiveSetting(values: ReadonlyMap<string, string>, key: string): string {
	const s = BUNKERWEB_PRIVACY_SETTINGS.find((x) => x.key === key);
	const v = values.get(key);
	if (v !== undefined) return v.trim();
	if (key === 'USE_ANTIBOT') return ANTIBOT_DEFAULT;
	if (key === 'ANTIBOT_URI') return ANTIBOT_URI_DEFAULT;
	return s?.bunkerwebDefault ?? '';
}

export interface PrivacyPlan {
	readonly text: string;
	/** One line per change, for the operator. */
	readonly changes: readonly string[];
	/** What stops applying because of a change, said plainly (no change of its own). */
	readonly notices: readonly string[];
	/** The values the edited file must give BunkerWeb (key → value). */
	readonly want: ReadonlyMap<string, string>;
}

/**
 * Turn every visitor-disclosing BunkerWeb feature off in an env file's text.
 * Every line that sets one of the keys is rewritten (Compose reads the last,
 * BunkerWeb the merged result); a missing key is appended. Anti-bot is turned
 * off when it uses a third-party challenge or sits on a live Morphit path
 * (the old manual example put it on the signup endpoint, which gated the whole
 * site and hid that endpoint); any other anti-bot setting is the operator's.
 */
/** The custom nginx conf (inside BunkerWeb's server block) that refuses the
 *  addresses an operator listed in BLACKLIST_IP — done by nginx itself, with no
 *  reverse-DNS query. */
export const LOCAL_IP_BLOCKS_KEY = 'CUSTOM_CONF_SERVER_HTTP_morphit_ip_blocks';

/** BLACKLIST_IP's entries as nginx `deny` directives on one line; entries that
 *  are not an IP address or CIDR are skipped (and returned). PURE. */
export function localIpBlockConf(list: string): { conf: string | null; skipped: string[] } {
	const ok: string[] = [];
	const skipped: string[] = [];
	for (const e of list.split(/\s+/).filter(Boolean)) {
		const [addr, bits, extra] = e.split('/');
		const fam = isIP(addr ?? '');
		const max = fam === 4 ? 32 : 128;
		const n = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : -1;
		if (fam !== 0 && extra === undefined && n >= 0 && n <= max) ok.push(`deny ${e};`);
		else skipped.push(e);
	}
	return { conf: ok.length > 0 ? ok.join(' ') : null, skipped };
}

export function planBunkerwebPrivacy(text: string): PrivacyPlan {
	let out = text;
	const changes: string[] = [];
	const notices: string[] = [];
	const want = new Map<string, string>();
	// Turning the blacklist off: what an operator put in it stops applying.
	// Plain IP blocks keep working from this server's own data (nginx `deny`);
	// the rest needs the plugin, which reverse-resolves every visitor.
	{
		const vals = envValues(text);
		if (effectiveSetting(vals, 'USE_BLACKLIST') !== 'no') {
			const ips = (vals.get('BLACKLIST_IP') ?? '').trim();
			if (ips !== '' && !vals.has(LOCAL_IP_BLOCKS_KEY)) {
				const b = localIpBlockConf(ips);
				if (b.conf !== null) {
					out = `${out.replace(/\n*$/, '')}${out.trim() === '' ? '' : '\n'}${LOCAL_IP_BLOCKS_KEY}=${b.conf}\n`;
					changes.push(
						`BunkerWeb: the addresses in your BLACKLIST_IP are now refused by nginx itself (${LOCAL_IP_BLOCKS_KEY}), with no reverse-DNS query`
					);
				}
				if (b.skipped.length > 0)
					notices.push(
						`BunkerWeb: these BLACKLIST_IP entries are not addresses or networks and no longer apply: ${b.skipped.join(' ')}`
					);
			}
			for (const [key, what] of [
				['BLACKLIST_ASN', 'network (ASN) blocks'],
				['BLACKLIST_RDNS', 'reverse-DNS name blocks'],
				['BLACKLIST_USER_AGENT', 'user-agent blocks'],
				['BLACKLIST_URI', 'URL blocks']
			] as const) {
				const v = (vals.get(key) ?? '').trim();
				if (v !== '')
					notices.push(
						`BunkerWeb: your ${what} (${key}=${v}) no longer apply. BunkerWeb checks them only in its blacklist plugin, which looks up every visitor's address in reverse DNS`
					);
			}
		}
	}
	const setAll = (key: string, val: string): void => {
		out = setEntries(out, key, val);
	};
	const before = envValues(text);
	const entries = envEntries(text);
	const valuesOf = (key: string): string[] =>
		entries.filter((e) => e.key === key).map((e) => e.value.trim());
	for (const s of BUNKERWEB_PRIVACY_SETTINGS) {
		want.set(s.key, s.value);
		// Every entry that sets it agrees (or none does and the default is right).
		if (effectiveSetting(before, s.key) === s.value && valuesOf(s.key).every((v) => v === s.value))
			continue;
		setAll(s.key, s.value);
		changes.push(
			isCountryListKey(s.key)
				? countryChangeLine(s.key, valuesOf(s.key), 'emptied')
				: `BunkerWeb: ${s.what} — off (${s.key}=${s.value})`
		);
	}
	// Per-site country lists (multisite: `<server name>_BLACKLIST_COUNTRY`).
	for (const e of entries) {
		const key = e.key;
		if (!isCountryListKey(key) || want.has(key) || valuesOf(key).every((v) => v === '')) continue;
		want.set(key, '');
		setAll(key, '');
		changes.push(countryChangeLine(key, valuesOf(key), 'emptied'));
	}
	const antibot = effectiveSetting(before, 'USE_ANTIBOT').toLowerCase();
	const uri = effectiveSetting(before, 'ANTIBOT_URI');
	if (antibot !== 'no' && (THIRD_PARTY_ANTIBOT.has(antibot) || LIVE_PATH.test(uri))) {
		setAll('USE_ANTIBOT', 'no');
		want.set('USE_ANTIBOT', 'no');
		changes.push(
			THIRD_PARTY_ANTIBOT.has(antibot)
				? `BunkerWeb: the ${antibot} anti-bot challenge, which loads a third party's script in every visitor's browser — off (USE_ANTIBOT=no)`
				: `BunkerWeb: the site-wide anti-bot challenge on ${uri}, which gated the whole site and hid that live path — off (USE_ANTIBOT=no)`
		);
	}
	return { text: out, changes, notices, want };
}

/**
 * Do these settings — BunkerWeb's generated `variables.env` (`KEY=value`
 * lines, unquoted) — carry every wanted value? One problem per key that does
 * not. A key missing from the file is a problem: BunkerWeb writes every
 * setting there, so a missing one means this is not its generated file.
 */
export function bunkerwebSettingsProblems(
	variablesEnv: string,
	want: ReadonlyMap<string, string>
): string[] {
	const have = new Map<string, string>();
	for (const line of variablesEnv.split('\n')) {
		const m = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(line.replace(/\r$/, ''));
		if (m) have.set(m[1]!, m[2]!);
	}
	const problems: string[] = [];
	for (const [k, v] of want) {
		const got = have.get(k);
		// A per-site country list (`<server name>_…_COUNTRY`) wanted empty may
		// simply be absent (BunkerWeb writes per-site keys only in multisite).
		if (
			got === undefined &&
			v === '' &&
			isCountryListKey(k) &&
			!/^(?:BLACKLIST|WHITELIST)_COUNTRY$/.test(k)
		)
			continue;
		if (got === undefined) problems.push(`BunkerWeb's running settings do not show ${k} yet`);
		else if (got.trim() !== v) problems.push(`BunkerWeb still runs with ${k}=${got.trim()}`);
	}
	// (A country list that reaches BunkerWeb another way — a compose
	// `environment:` entry this heal does not edit — is named separately by the
	// heal, never a reason to put this heal's own changes back.)
	return problems;
}

/** The non-empty country lists (`[<server name>_](BLACKLIST|WHITELIST)_COUNTRY`)
 *  in BunkerWeb's generated settings, as `KEY=value`. PURE. */
export function countryListsInSettings(variablesEnv: string): string[] {
	const out: string[] = [];
	for (const line of variablesEnv.split('\n')) {
		const m = /^([^=\s]+)=(.*)$/.exec(line.replace(/\r$/, ''));
		if (m && isCountryListKey(m[1]!) && m[2]!.trim() !== '') out.push(`${m[1]}=${m[2]!.trim()}`);
	}
	return out;
}

/** True for a BunkerWeb country-list key, global or per site (any server
 *  name: it may start with a digit or hold a `-`). PURE. */
export function isCountryListKey(k: string): boolean {
	return /^(?:[\p{L}\p{N}_.\-[\]]+_)?(?:BLACKLIST|WHITELIST)_COUNTRY$/u.test(k);
}

// ─── country lists saved in BunkerWeb's database ─────────────────────────

/** One saved country list (a row of bw_global_values / bw_services_settings). */
export interface CountryRow {
	/** The site of a per-site list; null for the global one. */
	readonly service: string | null;
	readonly key: 'BLACKLIST_COUNTRY' | 'WHITELIST_COUNTRY' | string;
	readonly suffix: number | null;
	readonly value: string;
	/** Who saved it: "ui" (the web UI), "scheduler" (the scheduler's
	 *  environment), "autoconf" (Autoconf labels) or "manual". */
	readonly method: string;
}

export interface CountryDb {
	/** BunkerWeb's sqlite database; or another database server (MariaDB,
	 *  PostgreSQL) this script does not edit; or none at that path. */
	readonly db: 'sqlite' | 'other' | 'missing';
	readonly rows: readonly CountryRow[];
}

/** The key a row shows as in variables.env (`<site>_KEY` for a per-site one). PURE. */
export function countryKeyOf(r: Pick<CountryRow, 'service' | 'key'>): string {
	return r.service ? `${r.service}_${r.key}` : r.key;
}

/** The script's `MODE=list` answer; null when it is not one. PURE. */
export function parseCountryDb(out: string): CountryDb | null {
	try {
		const j = JSON.parse(out) as { db?: unknown; rows?: unknown };
		if (j.db !== 'sqlite' && j.db !== 'other' && j.db !== 'missing') return null;
		const rows = Array.isArray(j.rows) ? (j.rows as CountryRow[]) : [];
		if (
			!rows.every(
				(r) =>
					typeof r.key === 'string' && typeof r.value === 'string' && typeof r.method === 'string'
			)
		)
			return null;
		return { db: j.db, rows };
	} catch {
		return null;
	}
}

/** The script's `MODE=remove` answer; null when nothing was removed (all or nothing). PURE. */
export function parseCountryRemoval(out: string): { backup: string; removed: number } | null {
	try {
		const j = JSON.parse(out) as { backup?: unknown; removed?: unknown };
		return typeof j.backup === 'string' && typeof j.removed === 'number' && j.removed > 0
			? { backup: j.backup, removed: j.removed }
			: null;
	} catch {
		return null;
	}
}

/**
 * Run inside BunkerWeb's scheduler (`docker exec -i -e MODE=… <scheduler>
 * python3 -c …`): its database is the one in its DATABASE_URI, BunkerWeb's
 * default being sqlite:////var/lib/bunkerweb/db.sqlite3.
 *  - MODE=list: every saved country list, with its method, as JSON.
 *  - MODE=remove: the rows on stdin (JSON), each removed only while it is
 *    still a web-UI row — all of them or none — after a backup of the
 *    database next to it; then the plugin that owns the setting is flagged
 *    changed (bw_plugins.config_changed, as BunkerWeb's own save does), which
 *    the running scheduler polls and answers with a rebuild.
 *  - MODE=where: the database path it would use.
 */
export const COUNTRY_DB_PY = String.raw`
import datetime, json, os, re, sqlite3, sys
KEYS = ("BLACKLIST_COUNTRY", "WHITELIST_COUNTRY")
MODE = os.environ.get("MODE", "")
URI = os.environ.get("DATABASE_URI") or "sqlite:////var/lib/bunkerweb/db.sqlite3"
m = re.match(r"^sqlite(?:\+pysqlite)?:///(.+)$", URI)
DB = m.group(1) if m else None
if MODE == "where":
    print(DB or "")
    sys.exit(0)
if DB is None:
    print(json.dumps({"db": "other", "rows": []}))
    sys.exit(0)
if not os.path.isfile(DB):
    print(json.dumps({"db": "missing", "rows": []}))
    sys.exit(0)
if MODE == "list":
    c = sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=30)
    rows = []
    for r in c.execute("SELECT setting_id, suffix, value, method FROM bw_global_values WHERE setting_id IN (?, ?)", KEYS):
        rows.append({"service": None, "key": r[0], "suffix": r[1], "value": r[2], "method": r[3]})
    for r in c.execute("SELECT service_id, setting_id, suffix, value, method FROM bw_services_settings WHERE setting_id IN (?, ?)", KEYS):
        rows.append({"service": r[0], "key": r[1], "suffix": r[2], "value": r[3], "method": r[4]})
    print(json.dumps({"db": "sqlite", "rows": rows}))
elif MODE == "remove":
    want = [r for r in json.load(sys.stdin) if r.get("key") in KEYS]
    s = sqlite3.connect(DB, timeout=30)
    bk = os.path.join(os.path.dirname(DB), "db.pre-morphit-country.sqlite3")
    d = sqlite3.connect(bk)
    s.backup(d)
    d.close()
    n = 0
    for r in want:
        if r.get("service") is None:
            n += s.execute("DELETE FROM bw_global_values WHERE setting_id = ? AND suffix IS ? AND method = 'ui'", (r["key"], r.get("suffix"))).rowcount
        else:
            n += s.execute("DELETE FROM bw_services_settings WHERE service_id = ? AND setting_id = ? AND suffix IS ? AND method = 'ui'", (r["service"], r["key"], r.get("suffix"))).rowcount
    if n != len(want) or n == 0:
        s.rollback()
        print(json.dumps({"error": "not every row is a web-UI row any more", "removed": 0}))
        sys.exit(0)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")
    s.execute("UPDATE bw_plugins SET config_changed = 1, last_config_change = ? WHERE id IN (SELECT plugin_id FROM bw_settings WHERE id IN (?, ?))", (now,) + KEYS)
    s.commit()
    s.close()
    print(json.dumps({"backup": bk, "removed": n}))
`;

/** The keys this module manages (the heal's verification needs them). */
export const BUNKERWEB_PRIVACY_KEYS: readonly string[] = [
	...BUNKERWEB_PRIVACY_SETTINGS.map((s) => s.key),
	'USE_ANTIBOT'
];
