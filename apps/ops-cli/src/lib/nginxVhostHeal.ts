/**
 * Installed-box heal for a bare-metal nginx serving Morphit (ops/nginx/web.conf,
 * relay.conf or indexer.conf copied into /etc/nginx by hand, as the hardening
 * checklist says). Docker/BunkerWeb boxes are healed by proxyConfigHeal (the
 * frontend container is rebuilt from the release); this one edits the copied
 * vhost files, which no upgrade rewrites.
 *
 * WHAT, in each enabled vhost that proxies to the relay or indexer, only where
 * the setting is missing (an operator's own value is kept):
 *  - `server_tokens off;` — no nginx version and distro in every answer;
 *  - `error_log stderr crit;` and the limit_req / limit_conn log levels at
 *    "info" — at the default level every failed upstream and every
 *    rate-limit rejection was written to /var/log/nginx/error.log with the
 *    visitor's address and the full request line;
 *  - every proxied location clears X-Morphit-Local-Health and
 *    X-I2P-Dest{B64,B32,Hash} from visitors (added where nginx would really
 *    use them: the location's own proxy_set_header list, or the enclosing one
 *    it inherits — adding a first one to a location would drop the inherited
 *    Host / X-Forwarded-For lines);
 *  - a page CSP an earlier release shipped becomes today's; any other whose
 *    script-src is exactly Morphit's earlier one (`'self' 'unsafe-inline'
 *    'unsafe-eval' 'wasm-unsafe-eval'`) loses inline script and eval;
 *  - a location that sets its own add_header lines gets the enclosing
 *    security headers it would otherwise lose (nginx inherits none then);
 *  - the IPFS gateway location asks for 127.0.0.1, not the visitor's Host.
 * Then `nginx -t` (on failure every file is put back byte for byte), a
 * graceful reload, and VERIFY in what nginx really loaded (`nginx -T`, the
 * sections of these files) and in a live answer from each vhost on this box
 * (no version in its Server header). FALLBACK: a reload that did not take →
 * one restart. Error-log lines already written are not touched: the detail
 * says how many name a visitor and the command to clear them on this server.
 */
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { keepOwnerAndMode } from './keepOwner.ts';
import {
	MORPHIT_CSP,
	VISITOR_HEADERS_CLEARED,
	cspScriptSrcStrict,
	frontendHidesInternals,
	isMorphitCsp
} from './proxyConfigHeal.ts';

const HEADER_NAMES: Record<string, string> = {
	'x-morphit-local-health': 'X-Morphit-Local-Health',
	'x-i2p-destb64': 'X-I2P-DestB64',
	'x-i2p-destb32': 'X-I2P-DestB32',
	'x-i2p-desthash': 'X-I2P-DestHash'
};
export const OLD_SCRIPT_SRC = "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'";
const NEW_SCRIPT_SRC = "script-src 'self' 'wasm-unsafe-eval'";

/** A vhost that proxies to the relay (:8080) or indexer (:8081). PURE. */
export function isMorphitVhost(text: string): boolean {
	return text
		.split('\n')
		.filter((l) => !/^\s*#/.test(l))
		.some((l) =>
			/proxy_pass\s+http:\/\/(?:127\.0\.0\.1|localhost):808[01]\b|\bmorphit_indexer\b/.test(l)
		);
}

// ─── a positional scanner (enough of nginx's grammar to insert lines) ──────

interface Dir {
	readonly name: string;
	readonly args: readonly string[];
	/** Offset of the directive's first character, and just after its `;`
	 *  (or its `{` for a block). */
	readonly start: number;
	readonly end: number;
}
interface Blk extends Dir {
	/** Offset just after `{`, and of the matching `}`. */
	readonly open: number;
	readonly close: number;
	readonly dirs: readonly Dir[];
	readonly kids: readonly Blk[];
}

function scan(text: string): Blk[] {
	interface Tok {
		v: string;
		at: number;
	}
	const toks: Tok[] = [];
	for (let i = 0; i < text.length; ) {
		const c = text[i]!;
		if (c === '#') while (i < text.length && text[i] !== '\n') i++;
		else if (/\s/.test(c)) i++;
		else if (c === '{' || c === '}' || c === ';') toks.push({ v: c, at: i++ });
		else if (c === '"' || c === "'") {
			let j = i + 1;
			let v = '';
			for (; j < text.length && text[j] !== c; j++) {
				if (text[j] === '\\' && j + 1 < text.length) j++;
				v += text[j];
			}
			toks.push({ v: `\u0000${v}`, at: i });
			i = j + 1;
		} else {
			let j = i;
			while (j < text.length && !/[\s;{}#]/.test(text[j]!)) j++;
			toks.push({ v: text.slice(i, j), at: i });
			i = j;
		}
	}
	let p = 0;
	const body = (): { dirs: Dir[]; kids: Blk[] } => {
		const dirs: Dir[] = [];
		const kids: Blk[] = [];
		while (p < toks.length && toks[p]!.v !== '}') {
			const words: Tok[] = [];
			while (p < toks.length && !['{', '}', ';'].includes(toks[p]!.v)) words.push(toks[p++]!);
			if (p >= toks.length || words.length === 0) {
				if (toks[p]?.v === ';') p++;
				else if (toks[p]?.v === '{') p++;
				else break;
				continue;
			}
			const name = words[0]!.v;
			const args = words.slice(1).map((w) => w.v.replace(/^\u0000/, ''));
			if (toks[p]!.v === ';') {
				dirs.push({ name, args, start: words[0]!.at, end: toks[p]!.at + 1 });
				p++;
			} else if (toks[p]!.v === '{') {
				const open = toks[p]!.at + 1;
				p++;
				const inner = body();
				const close = toks[p]?.v === '}' ? toks[p]!.at : text.length;
				if (toks[p]?.v === '}') p++;
				kids.push({ name, args, start: words[0]!.at, end: open, open, close, ...inner });
			} else break;
		}
		return { dirs, kids };
	};
	const top: Blk[] = [];
	while (p < toks.length) {
		top.push(...body().kids);
		if (toks[p]?.v === '}') p++;
	}
	return top;
}

const has = (b: Blk, name: string): boolean => b.dirs.some((d) => d.name === name);
const servers = (list: readonly Blk[]): Blk[] =>
	list.flatMap((b) => (b.name === 'server' ? [b] : servers(b.kids)));
const indentOf = (text: string, at: number): string => {
	const ls = text.lastIndexOf('\n', at - 1) + 1;
	return /^[ \t]*/.exec(text.slice(ls))![0];
};

/** The vhost text with the missing settings added (see the header). PURE. */
export function planVhost(text: string): { text: string; changes: string[] } {
	const inserts: Array<{ at: number; lines: string[] }> = [];
	const hostFixes: Dir[] = [];
	const changes = new Set<string>();
	const addTo = (b: Blk, lines: string[]): void => {
		if (lines.length > 0)
			inserts.push({ at: b.open, lines: lines.map((l) => `${indentOf(text, b.start)}    ${l}`) });
	};
	for (const s of servers(scan(text))) {
		const top: string[] = [];
		if (!has(s, 'server_tokens')) {
			top.push('server_tokens off;');
			changes.add('no nginx version in answers (server_tokens off)');
		}
		if (!has(s, 'error_log')) {
			top.push('error_log stderr crit;');
			changes.add('no visitor addresses in the error log (critical errors only)');
		}
		const uses = (n: string): boolean => {
			const walk = (b: Blk): boolean => has(b, n) || b.kids.some(walk);
			return walk(s);
		};
		for (const [lim, lvl] of [
			['limit_req', 'limit_req_log_level'],
			['limit_conn', 'limit_conn_log_level']
		] as const)
			if (uses(lim) && !has(s, lvl)) {
				top.push(`${lvl} info;`);
				changes.add('rate-limit rejections no longer logged with the visitor address');
			}
		// Visitor-set internal headers: where nginx takes the location's list from.
		const want = new Map<Blk, Set<string>>();
		const need = (b: Blk, hs: readonly string[]): void => {
			const set = want.get(b) ?? new Set<string>();
			for (const h of hs) set.add(h);
			want.set(b, set);
		};
		const ownSet = (b: Blk): Map<string, string> | null => {
			const d = b.dirs.filter((x) => x.name === 'proxy_set_header');
			return d.length === 0
				? null
				: new Map(d.map((x) => [x.args[0]!.toLowerCase(), x.args[1] ?? '']));
		};
		const walk = (b: Blk, holder: Blk | null, eff: Map<string, string> | null): void => {
			for (const k of b.kids) {
				const own = ownSet(k);
				const h = own ? k : holder;
				const e = own ?? eff;
				if (k.name === 'location' && has(k, 'proxy_pass')) {
					const missing = VISITOR_HEADERS_CLEARED.filter((x) => e?.get(x) !== '');
					if (missing.length > 0) need(h ?? k, missing);
				}
				walk(k, h, e);
			}
		};
		const sOwn = ownSet(s);
		walk(s, sOwn ? s : null, sOwn);
		for (const [b, hs] of want) {
			const lines = [...hs].map((h) => `proxy_set_header ${HEADER_NAMES[h]} "";`);
			if (b === s) top.push(...lines);
			else addTo(b, lines);
			changes.add(
				'visitor-set X-Morphit-Local-Health / X-I2P-Dest* cleared before the relay and indexer'
			);
		}
		// A location with its own add_header lines loses every inherited one
		// (nginx's rule): repeat the enclosing security headers it lacks.
		const SEC =
			/^(strict-transport-security|x-content-type-options|referrer-policy|x-frame-options|content-security-policy|permissions-policy)$/i;
		const addHeaders = (b: Blk): Dir[] => b.dirs.filter((d) => d.name === 'add_header');
		const repeat = (b: Blk, eff: Dir[]): void => {
			for (const k of b.kids) {
				const own = addHeaders(k);
				if (k.name === 'location' && own.length > 0) {
					const ownNames = new Set(own.map((d) => (d.args[0] ?? '').toLowerCase()));
					const missing = eff.filter(
						(d) => SEC.test(d.args[0] ?? '') && !ownNames.has((d.args[0] ?? '').toLowerCase())
					);
					if (missing.length > 0) {
						addTo(
							k,
							missing.map((d) => text.slice(d.start, d.end))
						);
						changes.add('security headers repeated in locations that set their own headers');
					}
				}
				repeat(
					k,
					own.length > 0
						? [
								...own,
								...eff.filter(
									(d) => !own.some((o) => o.args[0]?.toLowerCase() === d.args[0]?.toLowerCase())
								)
							]
						: eff
				);
			}
		};
		repeat(s, addHeaders(s));
		// The IPFS gateway is asked for itself, never for the visitor's Host
		// (a name it would otherwise try to resolve as DNSLink).
		const ipfs = (b: Blk): void => {
			for (const k of b.kids) {
				if (
					k.name === 'location' &&
					k.dirs.some((d) => d.name === 'proxy_pass' && /:8082\b/.test(d.args[0] ?? ''))
				)
					for (const d of k.dirs)
						if (
							d.name === 'proxy_set_header' &&
							d.args[0]?.toLowerCase() === 'host' &&
							d.args[1] === '$host'
						) {
							hostFixes.push(d);
							changes.add("the IPFS gateway is asked for 127.0.0.1, not the visitor's Host");
						}
				ipfs(k);
			}
		};
		ipfs(s);
		addTo(s, top);
	}
	let out = text;
	const edits: Array<{ at: number; del: number; ins: string }> = [
		...inserts.map((i) => ({ at: i.at, del: 0, ins: `\n${i.lines.join('\n')}` })),
		...hostFixes.map((d) => ({
			at: d.start,
			del: d.end - d.start,
			ins: 'proxy_set_header Host 127.0.0.1;'
		}))
	];
	for (const e of edits.sort((a, b) => b.at - a.at))
		out = `${out.slice(0, e.at)}${e.ins}${out.slice(e.at + e.del)}`;
	const lines = out.split('\n');
	let csp = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*#/.test(lines[i]!)) continue;
		// A page CSP an earlier release shipped (clearnet node list): today's.
		const m = /^(\s*add_header\s+Content-Security-Policy\s+")([^"]*)(".*)$/i.exec(lines[i]!);
		if (m && m[2] !== MORPHIT_CSP && isMorphitCsp(m[2]!)) {
			lines[i] = `${m[1]}${MORPHIT_CSP}${m[3]}`;
			csp = true;
		} else if (lines[i]!.includes(OLD_SCRIPT_SRC)) {
			// Any other (an .onion list, an operator's nodes): only the script-src.
			lines[i] = lines[i]!.split(OLD_SCRIPT_SRC).join(NEW_SCRIPT_SRC);
			csp = true;
		}
	}
	if (csp) changes.add('page CSP without inline script or eval');
	// `http2 on;` needs nginx 1.25.1; Ubuntu 24.04 ships 1.24, which refuses
	// the whole config. `listen … ssl http2` works on both.
	if (lines.some((l) => /^\s*http2\s+on\s*;/.test(l))) {
		for (let i = lines.length - 1; i >= 0; i--) {
			if (/^\s*http2\s+on\s*;/.test(lines[i]!)) lines.splice(i, 1);
			else if (/^\s*listen\s[^;#]*\bssl\b[^;#]*;/.test(lines[i]!) && !/\bhttp2\b/.test(lines[i]!))
				lines[i] = lines[i]!.replace(/;/, ' http2;');
		}
		changes.add('HTTP/2 enabled the way nginx 1.24 understands (listen … ssl http2)');
	}
	return { text: lines.join('\n'), changes: [...changes] };
}

/** The sections of an `nginx -T` dump that come from `files`. PURE. */
export function dumpSections(dump: string, files: readonly string[]): string {
	const parts = dump.split(/^# configuration file (.+):$/m);
	let out = '';
	for (let i = 1; i < parts.length; i += 2)
		if (files.includes(parts[i]!.trim())) out += `${parts[i + 1]}\n`;
	return out;
}

/** In loaded config text: every server hides its version, every proxied
 *  location clears the headers, and every page CSP is strict. PURE. */
export function vhostLoadedOk(section: string): { ok: boolean; why: string[] } {
	const h = frontendHidesInternals(section);
	const loose = [...section.matchAll(/add_header\s+Content-Security-Policy\s+"([^"]*)"/gi)]
		.map((m) => m[1]!)
		.filter((v) => !cspScriptSrcStrict(v));
	const why = [
		h.tokensOff ? '' : 'nginx version still shown',
		h.uncleared.length > 0 ? `internal headers passed on at ${h.uncleared.join(', ')}` : '',
		loose.length > 0 ? 'a page CSP still allows inline script or eval' : ''
	].filter(Boolean);
	return { ok: why.length === 0, why };
}

export interface VhostRuntime {
	nginxActive(): boolean;
	/** Enabled vhost files (symlinks resolved), with their text. */
	vhosts(): Array<{ path: string; text: string }>;
	writeFile(path: string, text: string): boolean;
	backup(path: string): string | null;
	restore(backup: string, path: string): boolean;
	test(): { ok: boolean; out: string };
	reload(): boolean;
	restart(): boolean;
	dumpConfig(): string | null;
	/** The Server header of `https://<name>/` (else `http://`) asked on 127.0.0.1; null if no answer. */
	serverHeader(name: string): string | null;
	/** Lines naming a client in the existing /var/log/nginx/error.log* files. */
	oldClientLines(): number;
	sleep(ms: number): Promise<void>;
}

export async function healNginxVhosts(
	ctx: HealCtx,
	opts: { runtime?: VhostRuntime } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	if (!rt.nginxActive())
		return {
			strategy: 'skipped',
			verified: true,
			routine: true,
			detail: 'Bare-metal nginx: not running on this server; nothing to do.'
		};
	const ours = rt.vhosts().filter((v) => isMorphitVhost(v.text));
	if (ours.length === 0)
		return {
			strategy: 'skipped',
			verified: true,
			routine: true,
			detail: 'Bare-metal nginx: no Morphit site in /etc/nginx on this server.'
		};
	const plans = ours
		.map((v) => ({ ...v, plan: planVhost(v.text) }))
		.filter((v) => v.plan.text !== v.text);
	const files = ours.map((v) => v.path);
	let strategy = 'already';
	const notes: string[] = [];
	if (plans.length > 0) {
		const backups: Array<{ path: string; backup: string }> = [];
		const putBack = (): boolean => backups.every((b) => rt.restore(b.backup, b.path));
		for (const p of plans) {
			const b = rt.backup(p.path);
			if (b === null || !rt.writeFile(p.path, p.plan.text)) {
				const back = putBack();
				return {
					strategy: 'left-alone',
					verified: false,
					detail: `Bare-metal nginx: could not update ${p.path}${back ? '' : ' (and could not put every file back)'}; nothing was reloaded. On this server compare it with this release's ops/nginx/*.conf.`
				};
			}
			backups.push({ path: p.path, backup: b });
		}
		const t = rt.test();
		if (!t.ok) {
			const back = putBack();
			const line =
				t.out.split('\n').find((l) => /emerg|error/.test(l)) ??
				t.out.trim().split('\n').pop() ??
				'';
			return {
				strategy: 'left-alone',
				verified: false,
				detail: `Bare-metal nginx: the updated site did not pass nginx -t (${line.trim()}), so ${back ? 'every file was put back as it was' : 'putting the files back FAILED — check ' + backups.map((b) => b.backup).join(', ')}; nothing was reloaded. On this server compare ${files.join(', ')} with this release's ops/nginx/*.conf.`
			};
		}
		const stop = ctx.spinner('Reloading nginx with the updated Morphit site…');
		try {
			rt.reload();
			await rt.sleep(1_500);
		} finally {
			stop();
		}
		strategy = 'reloaded';
		notes.push(...new Set(plans.flatMap((p) => p.plan.changes)));
	}
	const names = [
		...new Set(
			ours.flatMap((v) =>
				[...v.text.matchAll(/^\s*server_name\s+([^;#]+);/gm)].flatMap((m) =>
					m[1]!
						.trim()
						.split(/\s+/)
						.filter((n) => /^[a-z0-9.-]+$/i.test(n) && n !== '_')
				)
			)
		)
	];
	const observe = (): { loaded: ReturnType<typeof vhostLoadedOk> | null; versioned: string[] } => {
		// nginx -T and a request per site name: under the spinner.
		const stop = ctx.spinner('Checking what nginx has loaded and how it answers…');
		try {
			const dump = rt.dumpConfig();
			const loaded = dump === null ? null : vhostLoadedOk(dumpSections(dump, files));
			const versioned = names.filter((n) => /\d/.test(rt.serverHeader(n) ?? ''));
			return { loaded, versioned };
		} finally {
			stop();
		}
	};
	let seen = observe();
	if (strategy === 'reloaded' && seen.versioned.length > 0) {
		const stop = ctx.spinner('nginx still answers with its version; restarting it once…');
		try {
			rt.restart();
			await rt.sleep(2_000);
		} finally {
			stop();
		}
		strategy = 'restarted';
		seen = observe();
	}
	const old = rt.oldClientLines();
	const oldNote =
		old > 0
			? ` ${old} older line(s) in /var/log/nginx/error.log* name a visitor; to clear them, on this server run: sudo sh -c ': > /var/log/nginx/error.log; rm -f /var/log/nginx/error.log.[0-9]*'`
			: '';
	const ok = seen.loaded !== null && seen.loaded.ok && seen.versioned.length === 0;
	const did =
		notes.length > 0 ? `${notes.join('; ')} in ${plans.map((p) => p.path).join(', ')}; ` : '';
	if (ok)
		return {
			strategy,
			verified: true,
			detail: `Bare-metal nginx: ${did}seen in what nginx loaded${names.length > 0 ? ` and in its answers for ${names.join(', ')}` : ''}.${oldNote}`
		};
	const why = [
		...(seen.loaded === null
			? ['its loaded config could not be read (nginx -T)']
			: seen.loaded.why),
		...(seen.versioned.length > 0
			? [`${seen.versioned.join(', ')} still answer with the nginx version`]
			: [])
	];
	return {
		strategy,
		verified: false,
		detail: `Bare-metal nginx: ${did}${why.join('; ')}. On this server compare ${files.join(', ')} with this release's ops/nginx/*.conf, then run: sudo nginx -t && sudo systemctl reload nginx.${oldNote}`
	};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healNginxVhosts(ctx);
}

const sh = (cmd: string, args: string[], timeout = 20_000): { ok: boolean; out: string } => {
	try {
		const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
		return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
	} catch {
		return { ok: false, out: '' };
	}
};

const realRuntime: VhostRuntime = {
	nginxActive: () => sh('systemctl', ['is-active', '--quiet', 'nginx']).ok,
	vhosts: () => {
		const seen = new Set<string>();
		const out: Array<{ path: string; text: string }> = [];
		for (const dir of ['/etc/nginx/sites-enabled', '/etc/nginx/conf.d']) {
			let names: string[] = [];
			try {
				names = readdirSync(dir);
			} catch {
				continue;
			}
			for (const n of names) {
				if (dir.endsWith('conf.d') && !n.endsWith('.conf')) continue;
				try {
					const p = realpathSync(join(dir, n));
					if (seen.has(p)) continue;
					seen.add(p);
					out.push({ path: p, text: readFileSync(p, 'utf8') });
				} catch {
					/* unreadable or dangling: not ours to judge */
				}
			}
		}
		return out;
	},
	writeFile: (p, text) => {
		const tmp = `${p}.morphit-tmp`;
		try {
			writeFileSync(tmp, text, { mode: 0o644 });
			keepOwnerAndMode(p, tmp);
			renameSync(tmp, p);
			return true;
		} catch {
			return false;
		}
	},
	// Kept outside /etc/nginx so nginx never loads a backup as a site.
	backup: (p) => {
		const b = `/var/backups/morphit-nginx-${p.replace(/[^A-Za-z0-9.-]/g, '_')}.${Date.now()}`;
		try {
			copyFileSync(p, b);
			return b;
		} catch {
			return null;
		}
	},
	restore: (b, p) => {
		try {
			copyFileSync(b, p);
			return true;
		} catch {
			return false;
		}
	},
	test: () => sh('nginx', ['-t']),
	reload: () => sh('systemctl', ['reload', 'nginx'], 60_000).ok,
	restart: () => sh('systemctl', ['restart', 'nginx'], 90_000).ok,
	dumpConfig: () => {
		const r = sh('nginx', ['-T']);
		return r.ok ? r.out : null;
	},
	serverHeader: (name) => {
		for (const [scheme, port] of [
			['https', '443'],
			['http', '80']
		] as const) {
			const r = sh('curl', [
				'-skI',
				'-m',
				'6',
				'--noproxy',
				'*',
				'--resolve',
				`${name}:${port}:127.0.0.1`,
				`${scheme}://${name}/`
			]);
			const m = /^server:\s*(.*)$/im.exec(r.out);
			if (m) return m[1]!.trim();
		}
		return null;
	},
	oldClientLines: () => {
		let n = 0;
		try {
			for (const f of readdirSync('/var/log/nginx'))
				if (/^error\.log(\.\d+)?$/.test(f))
					n += readFileSync(join('/var/log/nginx', f), 'utf8')
						.split('\n')
						.filter((l) => /\bclient: /.test(l)).length;
		} catch {
			/* no logs, or unreadable */
		}
		return n;
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
