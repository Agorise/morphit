/**
 * Installed-box heal: the Let's Encrypt certificate renews while BunkerWeb owns
 * port 80.
 *
 * WHY. The tls role issues the certificate with certbot's `standalone`
 * authenticator before BunkerWeb starts, and certbot remembers that for every
 * renewal. From then on BunkerWeb (Docker) holds port 80, so each renewal fails
 * with "Could not bind TCP port 80" and the clearnet site serves an expired
 * certificate after 90 days.
 *
 * HOW IT RENEWS INSTEAD (v1.24.6). Through BunkerWeb's own Let's Encrypt
 * folder: BunkerWeb answers /.well-known/acme-challenge/ itself, from a folder
 * in its container, so certbot's manual authenticator with two small hooks
 * puts Let's Encrypt's file there (lib/acmeBunkerweb.ts). Nothing is stopped.
 * Up to v1.24.4 this heal sent the check to the web build behind BunkerWeb
 * instead; BunkerWeb never passes that path on, so it always fell through to
 * the hooks that pause BunkerWeb (morphit.io, v1.24.4).
 *
 * STEPS, for each renewal config that uses `standalone` while BunkerWeb (or
 * something else) holds port 80, or this heal's own earlier pause-the-edge
 * fallback, or `webroot` behind BunkerWeb:
 *  1. with BunkerWeb holding port 80: the hooks written (and read back), a
 *     test file put into BunkerWeb's folder must come back from
 *     http://<domain>/… asked on 127.0.0.1 (redirects followed), as Let's
 *     Encrypt will see it; then the manual settings are written, a real
 *     `certbot renew --dry-run` against Let's Encrypt's staging server must
 *     pass, and the settings are read back, else the original goes back;
 *  2. otherwise, the web build: a probe file in
 *     <build>/.well-known/acme-challenge must come back the same way; then
 *     `certbot reconfigure --webroot` (certbot ≥ 2.3, a dry run that saves the
 *     settings only when it passes) or, older certbot, the settings written and
 *     `certbot renew --dry-run`, else the original goes back;
 *  3. VERIFY: the renewal config read back says what was set;
 *  4. fallback: pre/post hooks that stop and start the container holding port
 *     80 around the renewal (a short outage every ~60 days), checked by a dry
 *     run too — never for a config that already had them (it stays as it is);
 *  5. otherwise the original config stays and one calm line says when the
 *     certificate expires and what to run on this server.
 * A config already set to the hooks has them written again when one is
 * missing or changed (no certbot is run for that).
 * When Let's Encrypt's staging server cannot be reached, nothing is changed
 * (nothing could be checked) and the next upgrade tries again.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
	AUTH_HOOK,
	CLEANUP_HOOK,
	MANUAL_RENEWAL_PARAMS,
	edgeChallenge,
	edgeServes,
	ensureAcmeHooks,
	isBunkerWebEdge
} from './acmeBunkerweb.ts';
import type { HealCtx, HealResult } from './healTypes.ts';

// ─── renewal config text (certbot's ConfigObj format) ──────────────────

/** A `key = value` of the [renewalparams] section, or null. PURE. */
export function renewalParam(text: string, key: string): string | null {
	let inParams = false;
	for (const line of text.split('\n')) {
		const sec = /^\s*\[\s*([^\][]+)\s*\]\s*$/.exec(line);
		if (sec) {
			inParams = sec[1] === 'renewalparams';
			continue;
		}
		if (/^\s*\[\[/.test(line)) {
			inParams = false;
			continue;
		}
		if (!inParams) continue;
		const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
		if (m) return m[1]!;
	}
	return null;
}

/** The `[[webroot_map]]` entries (domain → directory). PURE. */
export function webrootMap(text: string): Map<string, string> {
	const out = new Map<string, string>();
	let inMap = false;
	for (const line of text.split('\n')) {
		if (/^\s*\[\[\s*webroot_map\s*\]\]\s*$/.test(line)) {
			inMap = true;
			continue;
		}
		if (/^\s*\[/.test(line)) {
			inMap = false;
			continue;
		}
		const m = inMap ? /^\s*([^=\s]+)\s*=\s*(.*?)\s*$/.exec(line) : null;
		if (m) out.set(m[1]!, m[2]!);
	}
	return out;
}

/**
 * Set [renewalparams] keys (null removes one) and, when `webroot` is given,
 * replace [[webroot_map]] with `domains` → that directory. Everything else is
 * kept as written. PURE.
 */
export function setRenewalParams(
	text: string,
	set: Readonly<Record<string, string | null>>,
	webroot?: { readonly dir: string; readonly domains: readonly string[] }
): string {
	const lines = text.replace(/\n+$/, '').split('\n');
	const out: string[] = [];
	let section = '';
	const done = new Set<string>();
	const flushParams = (): void => {
		for (const [k, v] of Object.entries(set))
			if (v !== null && !done.has(k)) out.push(`${k} = ${v}`);
		for (const k of Object.keys(set)) done.add(k);
		if (webroot) {
			out.push('[[webroot_map]]');
			for (const d of webroot.domains) out.push(`${d} = ${webroot.dir}`);
		}
	};
	for (const line of lines) {
		const sec = /^\s*\[\s*([^\][]+)\s*\]\s*$/.exec(line);
		const sub = /^\s*\[\[\s*([^\][]+)\s*\]\]\s*$/.exec(line);
		if (sec || sub) {
			if (section === 'renewalparams' && sec) flushParams();
			section = sec ? sec[1]!.trim() : `${section}/${sub![1]!.trim()}`;
			if (sub && section === 'renewalparams/webroot_map') continue; // rebuilt
			out.push(line);
			continue;
		}
		if (section === 'renewalparams/webroot_map') continue;
		if (section === 'renewalparams') {
			const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
			if (m && m[1]! in set) {
				const v = set[m[1]!];
				if (v !== null && v !== undefined && !done.has(m[1]!)) out.push(`${m[1]} = ${v}`);
				done.add(m[1]!);
				continue;
			}
		}
		out.push(line);
	}
	if (section === 'renewalparams' || section.startsWith('renewalparams/')) flushParams();
	return `${out.join('\n')}\n`;
}

/** The renewal settings for webroot renewal through `dir`. PURE. */
export function webrootSettings(text: string, dir: string, domains: readonly string[]): string {
	return setRenewalParams(
		text,
		{ authenticator: 'webroot', webroot_path: `${dir},`, pre_hook: null, post_hook: null },
		{ dir, domains }
	);
}

/** Is this renewal config set to renew through webroot `dir` for `domain`? PURE. */
export function rendersWebroot(text: string, dir: string, domain: string): boolean {
	return renewalParam(text, 'authenticator') === 'webroot' && webrootMap(text).get(domain) === dir;
}

/** The renewal settings for the check through BunkerWeb's own folder
 *  (lib/acmeBunkerweb.ts): manual, with Morphit's two hooks, nothing paused,
 *  no webroot. PURE. */
export function bunkerWebSettings(text: string): string {
	return setRenewalParams(text, {
		...MANUAL_RENEWAL_PARAMS,
		pre_hook: null,
		post_hook: null,
		webroot_path: null
	});
}

/** Is this renewal config set to renew through BunkerWeb's folder? PURE. */
export function rendersBunkerWeb(text: string): boolean {
	return (
		renewalParam(text, 'authenticator') === 'manual' &&
		renewalParam(text, 'manual_auth_hook') === AUTH_HOOK &&
		renewalParam(text, 'manual_cleanup_hook') === CLEANUP_HOOK &&
		!renewalParam(text, 'pre_hook') &&
		!renewalParam(text, 'post_hook')
	);
}

/** This heal's own fallback: standalone, the container on port 80 paused
 *  around each renewal. The container's name, or null. PURE. */
export function ownPauseHooks(text: string): string | null {
	if (renewalParam(text, 'authenticator') !== 'standalone') return null;
	const pre = /^docker stop (\S+)$/.exec(renewalParam(text, 'pre_hook') ?? '');
	const post = /^docker start (\S+)$/.exec(renewalParam(text, 'post_hook') ?? '');
	return pre && post && pre[1] === post[1] ? pre[1]! : null;
}

/** certbot's version from `certbot --version` ("certbot 2.9.0"); [0,0] if unknown. PURE. */
export function certbotVersion(out: string): [number, number] {
	const m = /certbot\s+(\d+)\.(\d+)/.exec(out);
	return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

// ─── runtime ────────────────────────────────────────────────────────────

export interface TlsRuntime {
	renewalConfs(): Array<{ readonly path: string; readonly text: string }>;
	readFile(path: string): string | null;
	writeFile(path: string, text: string): boolean;
	removeFile(path: string): void;
	/** Who listens on TCP port 80 on this host ('' = nobody), e.g. "docker-proxy". */
	port80Owner(): string;
	/** The domains on the live certificate `name` (subjectAltName), and its end date. */
	certInfo(name: string): { domains: string[]; notAfter: string } | null;
	/** Body of http://<domain><path>, asked on 127.0.0.1:80, redirects followed,
	 *  certificate not checked; null when nothing came back. */
	localGet(domain: string, path: string): string | null;
	/** Can Let's Encrypt's staging server be reached from here? */
	acmeReachable(): boolean;
	certbot(args: readonly string[]): { ok: boolean; out: string };
	/** The running container publishing host port 80, or null. */
	port80Container(): string | null;
	/** Is that container BunkerWeb's edge? */
	isBunkerWeb(container: string): boolean;
	/** Put (body) or remove (null) a file in BunkerWeb's Let's Encrypt folder. */
	edgeChallenge(container: string, token: string, body: string | null): boolean;
	/** Morphit's two certbot hooks on disk (lib/acmeBunkerweb.ts). */
	ensureAcmeHooks(): 'unchanged' | 'written' | 'failed';
}

export interface TlsHealOpts {
	readonly webroot: string;
	readonly runtime?: TlsRuntime;
}

type Kind = 'standalone' | 'paused' | 'webroot' | 'bunkerweb';

function kindOf(text: string): Kind | null {
	const auth = renewalParam(text, 'authenticator');
	if (auth === 'standalone') {
		if (ownPauseHooks(text) !== null) return 'paused';
		// Hooks of the operator's own: left as they are.
		return renewalParam(text, 'pre_hook') || renewalParam(text, 'post_hook') ? null : 'standalone';
	}
	if (auth === 'webroot') return 'webroot';
	if (auth === 'manual' && renewalParam(text, 'manual_auth_hook') === AUTH_HOOK) return 'bunkerweb';
	return null;
}

const DRY_RUN = (name: string): string[] => [
	'renew',
	'--dry-run',
	'--no-random-sleep-on-renew',
	'--cert-name',
	name,
	'--non-interactive'
];

export async function healTlsRenewal(ctx: HealCtx, opts: TlsHealOpts): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime();
	let stop = ctx.spinner('Checking how the TLS certificate renews…');
	let all: Array<{ path: string; text: string; kind: Kind }>;
	let owner = '';
	let edge: string | null = null;
	let bw = false;
	try {
		all = rt
			.renewalConfs()
			.map((c) => ({ ...c, kind: kindOf(c.text) }))
			.filter((c): c is { path: string; text: string; kind: Kind } => c.kind !== null);
		if (all.length > 0) {
			owner = rt.port80Owner();
			edge = owner === '' ? null : rt.port80Container();
			bw = edge !== null && rt.isBunkerWeb(edge);
		}
	} finally {
		stop();
	}
	const parts: string[] = [];
	let allOk = true;
	let strategy = 'already';

	// Already through BunkerWeb's folder: only its two hooks need to be there.
	if (all.some((c) => c.kind === 'bunkerweb')) {
		const h = rt.ensureAcmeHooks();
		if (h === 'written') {
			strategy = 'hooks-rewritten';
			parts.push("Morphit's two certbot hooks were missing or changed and are written again");
		} else if (h === 'failed') {
			allOk = false;
			strategy = 'left-alone';
			parts.push(
				`Morphit's certbot hooks (${AUTH_HOOK}, ${CLEANUP_HOOK}) could not be written, so the next renewal cannot put Let's Encrypt's file into BunkerWeb's folder; the next \`sudo morphit-ops upgrade\` tries again`
			);
		}
	}
	// What is left to switch: standalone (no hooks), this heal's own pause
	// hooks, and webroot — the last two only behind BunkerWeb, where the
	// folder serves without a pause (elsewhere they renew as they are).
	const confs = all.filter(
		(c) => c.kind === 'standalone' || (bw && (c.kind === 'paused' || c.kind === 'webroot'))
	);
	const done = (): HealResult =>
		parts.length === 0
			? {
					strategy: all.length === 0 ? 'skipped' : 'already',
					verified: true,
					routine: true,
					detail:
						all.length === 0
							? 'TLS renewal: no certificate here renews with port 80 of its own.'
							: owner === '' || /certbot/.test(owner)
								? 'TLS renewal: port 80 is free on this server, so the certificate can renew as it was set up.'
								: 'TLS renewal: the certificate renews as it is set up (nothing to change).'
				}
			: { strategy, verified: allOk, detail: `TLS renewal: ${parts.join('; ')}.` };
	if (confs.length === 0 || owner === '' || /certbot/.test(owner)) return done();

	stop = ctx.spinner("Checking that Let's Encrypt's test server can be reached…");
	let reachable: boolean;
	try {
		reachable = rt.acmeReachable();
	} finally {
		stop();
	}
	if (!reachable)
		return {
			strategy: 'deferred',
			verified: false,
			detail:
				"TLS renewal: Let's Encrypt could not be reached from this server just now, so the renewal settings were left as they are (nothing could be checked); the next `sudo morphit-ops upgrade` tries again."
		};

	for (const conf of confs) {
		const name = conf.path.replace(/^.*\//, '').replace(/\.conf$/, '');
		const info = rt.certInfo(name);
		const domains = info && info.domains.length > 0 ? info.domains : [name];
		const domain = domains[0]!;
		let ok = false;
		/** Why BunkerWeb's own folder was not used (null: not tried). */
		let why: string | null = null;

		// 1. BunkerWeb's own Let's Encrypt folder.
		if (bw && edge !== null) {
			stop = ctx.spinner(`Checking that BunkerWeb answers Let's Encrypt's check for ${domain}…`);
			let folderServed = false;
			try {
				if (rt.ensureAcmeHooks() === 'failed')
					why = `Morphit's certbot hooks (${AUTH_HOOK}) could not be written`;
				else {
					folderServed = edgeServes(
						(t, b) => rt.edgeChallenge(edge!, t, b),
						(t) => rt.localGet(domain, `/.well-known/acme-challenge/${t}`)
					);
					if (!folderServed)
						why = "a test file put into BunkerWeb's own Let's Encrypt folder did not come back";
				}
			} finally {
				stop();
			}
			if (folderServed) {
				stop = ctx.spinner(
					`Switching ${domain}'s renewal to BunkerWeb's own Let's Encrypt folder (with a test renewal)…`
				);
				try {
					const want = bunkerWebSettings(conf.text);
					if (rt.writeFile(conf.path, want)) {
						ok = rt.certbot(DRY_RUN(name)).ok && rendersBunkerWeb(rt.readFile(conf.path) ?? '');
						if (!ok) rt.writeFile(conf.path, conf.text);
					}
					if (!ok)
						why = "a test renewal with Let's Encrypt through BunkerWeb's own folder did not pass";
				} finally {
					stop();
				}
			}
			if (ok) {
				strategy = 'bunkerweb';
				parts.push(
					`${domain} now renews through BunkerWeb's own Let's Encrypt folder, with nothing stopped (a test renewal with Let's Encrypt passed; settings read back)`
				);
				continue;
			}
			if (conf.kind === 'paused' || conf.kind === 'webroot') {
				// It stays as it was: a pause still renews; webroot is said.
				if (conf.kind === 'paused') {
					parts.push(
						`${domain} still renews by pausing ${edge} for a few seconds (${why}); the next \`sudo morphit-ops upgrade\` tries again`
					);
				} else {
					allOk = false;
					strategy = 'left-alone';
					parts.push(
						`${domain} renews through the web build, which BunkerWeb does not pass Let's Encrypt's check on to, and it could not be switched to BunkerWeb's own folder (${why}); it expires ${info?.notAfter ?? 'within 90 days of its issue'}, and the next \`sudo morphit-ops upgrade\` tries again`
					);
				}
				continue;
			}
		}

		// 2. the web build (a web server that passes the path on).
		stop = ctx.spinner(
			`Checking that ${domain}'s web build answers Let's Encrypt's challenge path…`
		);
		let served = false;
		try {
			const token = `morphit-probe-${randomBytes(8).toString('hex')}`;
			const dir = join(opts.webroot, '.well-known', 'acme-challenge');
			const probe = join(dir, token);
			const body = randomBytes(16).toString('hex');
			if (rt.writeFile(probe, body)) {
				served =
					(rt.localGet(domain, `/.well-known/acme-challenge/${token}`) ?? '').trim() === body;
				rt.removeFile(probe);
			}
		} finally {
			stop();
		}
		if (served) {
			stop = ctx.spinner(
				`Switching ${domain}'s renewal to go through the web server (with a test renewal)…`
			);
			try {
				const [maj, min] = certbotVersion(rt.certbot(['--version']).out);
				if (maj > 2 || (maj === 2 && min >= 3)) {
					rt.certbot([
						'reconfigure',
						'--cert-name',
						name,
						'--webroot',
						'--webroot-path',
						opts.webroot,
						'--non-interactive'
					]);
				} else {
					const want = webrootSettings(conf.text, opts.webroot, domains);
					if (rt.writeFile(conf.path, want) && !rt.certbot(DRY_RUN(name)).ok)
						rt.writeFile(conf.path, conf.text);
				}
				ok = rendersWebroot(rt.readFile(conf.path) ?? '', opts.webroot, domain);
			} finally {
				stop();
			}
		}
		if (ok) {
			strategy = 'webroot';
			parts.push(
				`${domain} now renews through the web server (a test renewal with Let's Encrypt passed; settings read back)`
			);
			continue;
		}

		// 3. fallback: free port 80 for the renewal only.
		if (edge) {
			stop = ctx.spinner(
				`Setting ${domain}'s renewal to pause ${edge} for a moment (with a test renewal)…`
			);
			try {
				const hooked = setRenewalParams(conf.text, {
					pre_hook: `docker stop ${edge}`,
					post_hook: `docker start ${edge}`
				});
				if (rt.writeFile(conf.path, hooked)) {
					ok = rt.certbot(DRY_RUN(name)).ok;
					const back = rt.readFile(conf.path) ?? '';
					ok = ok && renewalParam(back, 'pre_hook') === `docker stop ${edge}`;
					if (!ok) rt.writeFile(conf.path, conf.text);
				}
			} finally {
				stop();
			}
		}
		if (ok) {
			strategy = 'hooks';
			parts.push(
				`${domain} renews by pausing ${edge} for the few seconds certbot needs port 80 (a test renewal passed)` +
					(why !== null
						? ` (${why}; the next \`sudo morphit-ops upgrade\` tries that again, and renewals then pause nothing)`
						: `; renewals go through the web server instead (no pause) once it answers Let's Encrypt's check, which the next \`sudo morphit-ops upgrade --heals\` checks again`)
			);
			continue;
		}

		// 4. leave it, say so.
		allOk = false;
		strategy = 'left-alone';
		parts.push(
			`${domain} could not be switched to a renewal that works while ${owner} holds port 80, so its settings were left as they were; it expires ${info?.notAfter ?? 'within 90 days of its issue'}. ` +
				(why !== null
					? `Through BunkerWeb's own Let's Encrypt folder: ${why}; the next \`sudo morphit-ops upgrade\` tries again`
					: `On this server run: sudo certbot reconfigure --cert-name ${name} --webroot --webroot-path ${opts.webroot}`)
		);
	}
	return done();
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	const installDir =
		/^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '')?.[1] ??
		((process.env.MORPHIT_INSTALL_DIR ?? '').trim() || '/opt/morphit');
	return healTlsRenewal(ctx, { webroot: join(installDir, 'apps', 'web', 'build') });
}

function sh(cmd: string, args: readonly string[], timeout = 30_000): { ok: boolean; out: string } {
	try {
		const r = spawnSync(cmd, args as string[], {
			encoding: 'utf8',
			timeout,
			maxBuffer: 16 * 1024 * 1024
		});
		return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
	} catch {
		return { ok: false, out: '' };
	}
}

function realRuntime(): TlsRuntime {
	const RENEWAL = '/etc/letsencrypt/renewal';
	return {
		renewalConfs: () => {
			try {
				return readdirSync(RENEWAL)
					.filter((f) => f.endsWith('.conf'))
					.map((f) => ({ path: join(RENEWAL, f), text: readFileSync(join(RENEWAL, f), 'utf8') }));
			} catch {
				return [];
			}
		},
		readFile: (p) => {
			try {
				return readFileSync(p, 'utf8');
			} catch {
				return null;
			}
		},
		writeFile: (p, text) => {
			try {
				mkdirSync(join(p, '..'), { recursive: true });
				const tmp = `${p}.tmp-${process.pid}`;
				writeFileSync(tmp, text, { mode: 0o644 });
				renameSync(tmp, p);
				return true;
			} catch {
				return false;
			}
		},
		removeFile: (p) => {
			try {
				if (existsSync(p)) rmSync(p);
			} catch {
				/* a stray probe file is harmless */
			}
		},
		port80Owner: () => {
			const r = sh('ss', ['-ltnpH', 'sport = :80']);
			if (!r.ok || r.out.trim() === '') return '';
			return /users:\(\("([^"]+)"/.exec(r.out)?.[1] ?? 'another program';
		},
		certInfo: (name) => {
			const pem = `/etc/letsencrypt/live/${name}/cert.pem`;
			const san = sh('openssl', ['x509', '-noout', '-ext', 'subjectAltName', '-in', pem]);
			const end = sh('openssl', ['x509', '-noout', '-enddate', '-in', pem]);
			if (!san.ok && !end.ok) return null;
			return {
				domains: [...san.out.matchAll(/DNS:([^,\s]+)/g)].map((m) => m[1]!),
				notAfter: /notAfter=(.*)/.exec(end.out)?.[1]?.trim() ?? 'soon'
			};
		},
		localGet: (domain, path) => {
			const r = sh('curl', [
				'-skL',
				'--max-time',
				'10',
				// A proxy in the environment would make curl ignore --resolve.
				'--noproxy',
				'*',
				'--resolve',
				`${domain}:80:127.0.0.1`,
				'--resolve',
				`${domain}:443:127.0.0.1`,
				`http://${domain}${path}`
			]);
			return r.ok ? r.out : null;
		},
		acmeReachable: () =>
			sh('curl', [
				'-sS',
				'-o',
				'/dev/null',
				'--max-time',
				'10',
				'https://acme-staging-v02.api.letsencrypt.org/directory'
			]).ok,
		certbot: (args) => sh('certbot', args, 300_000),
		port80Container: () => {
			const r = sh('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
			for (const line of r.ok ? r.out.split('\n') : []) {
				const [n, ports] = line.split('\t');
				if (n && /(?:0\.0\.0\.0|\[::\]):80->/.test(ports ?? '')) return n;
			}
			return null;
		},
		isBunkerWeb: (c) => isBunkerWebEdge(c),
		edgeChallenge: (c, t, b) => edgeChallenge(c, t, b),
		ensureAcmeHooks: () => ensureAcmeHooks()
	};
}
