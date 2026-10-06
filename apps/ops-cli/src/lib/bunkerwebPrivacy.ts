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
 * Everything here is PURE.
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

/** An env-file value as Compose hands it over (surrounding quotes removed). */
function unquote(raw: string): string {
	const v = raw.trim();
	if (v.length >= 2 && ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"'))))
		return v.slice(1, -1);
	return v;
}

/** `KEY=value` lines of an env file; the last one wins, as in Compose. */
export function envValues(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (m) out.set(m[1]!, unquote(m[2]!));
	}
	return out;
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
		const re = new RegExp(`^(\\s*(?:export\\s+)?)${key}=.*$`, 'gm');
		if (re.test(out)) out = out.replace(re, (_l, pre: string) => `${pre}${key}=${val}`);
		else out = `${out.replace(/\n*$/, '')}${out.trim() === '' ? '' : '\n'}${key}=${val}\n`;
	};
	const before = envValues(text);
	for (const s of BUNKERWEB_PRIVACY_SETTINGS) {
		want.set(s.key, s.value);
		// Every line that sets it agrees (or none does and the default is right).
		const lines = [...text.matchAll(new RegExp(`^\\s*(?:export\\s+)?${s.key}=(.*)$`, 'gm'))];
		if (
			effectiveSetting(before, s.key) === s.value &&
			lines.every((m) => unquote(m[1]!).trim() === s.value)
		)
			continue;
		setAll(s.key, s.value);
		changes.push(`BunkerWeb: ${s.what} — off (${s.key}=${s.value})`);
	}
	// Per-site country lists (multisite: `<server name>_BLACKLIST_COUNTRY`).
	for (const m of [
		...text.matchAll(/^\s*(?:export\s+)?([A-Za-z0-9.-]+_(?:BLACKLIST|WHITELIST)_COUNTRY)=(.*)$/gm)
	]) {
		const key = m[1]!;
		if (unquote(m[2]!).trim() === '' || want.has(key)) continue;
		want.set(key, '');
		const re = new RegExp(
			`^(\\s*(?:export\\s+)?)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`,
			'gm'
		);
		out = out.replace(re, (_l, pre: string) => `${pre}${key}=`);
		changes.push(
			`BunkerWeb: the country list ${key} — emptied (no Morphit instance blocks by country)`
		);
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
		const m = /^((?:[A-Za-z0-9.-]+_)?(?:BLACKLIST|WHITELIST)_COUNTRY)=(.*)$/.exec(
			line.replace(/\r$/, '')
		);
		if (m && m[2]!.trim() !== '') out.push(`${m[1]}=${m[2]!.trim()}`);
	}
	return out;
}

/** True for a BunkerWeb country-list key, global or per site. PURE. */
export function isCountryListKey(k: string): boolean {
	return /^(?:[A-Za-z0-9.-]+_)?(?:BLACKLIST|WHITELIST)_COUNTRY$/.test(k);
}

/** The keys this module manages (the heal's verification needs them). */
export const BUNKERWEB_PRIVACY_KEYS: readonly string[] = [
	...BUNKERWEB_PRIVACY_SETTINGS.map((s) => s.key),
	'USE_ANTIBOT'
];
