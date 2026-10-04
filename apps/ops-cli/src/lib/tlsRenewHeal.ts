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
 * HOW IT RENEWS INSTEAD. Through BunkerWeb itself: Let's Encrypt asks
 * http://<domain>/.well-known/acme-challenge/<token>; BunkerWeb proxies the
 * request (after its http→https redirect, which Let's Encrypt follows) to the
 * frontend, which serves /.well-known/ from the web build it mounts. So the
 * `webroot` authenticator with that build directory works with nothing stopped.
 *
 * STEPS, for each renewal config that uses `standalone` while something else
 * holds port 80:
 *  1. prove the path locally: a probe file in <build>/.well-known/acme-challenge
 *     must come back from http://<domain>/… asked on 127.0.0.1 (redirects
 *     followed) — i.e. BunkerWeb → frontend → that directory, as Let's Encrypt
 *     will see it;
 *  2. primary: `certbot reconfigure --webroot` (certbot ≥ 2.3), which performs a
 *     real dry-run renewal against Let's Encrypt's staging server and saves the
 *     new settings only if it passes; older certbot: the settings are written
 *     (original kept) and `certbot renew --dry-run` must pass, else the original
 *     goes back;
 *  3. VERIFY: the renewal config read back says webroot for this directory;
 *  4. fallback when the path does not serve the probe or the dry run fails:
 *     pre/post hooks that stop and start the container holding port 80 around
 *     the renewal (a short outage every ~60 days), checked by a dry run too;
 *  5. otherwise the original config stays and one calm line says when the
 *     certificate expires and what to run on this server.
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
}

export interface TlsHealOpts {
	readonly webroot: string;
	readonly runtime?: TlsRuntime;
}

export async function healTlsRenewal(ctx: HealCtx, opts: TlsHealOpts): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime();
	let stop = ctx.spinner('Checking how the TLS certificate renews…');
	let confs: Array<{ path: string; text: string }>;
	let owner: string;
	try {
		// standalone, unless hooks already free port 80 for it (an earlier run's fallback)
		confs = rt
			.renewalConfs()
			.filter(
				(c) =>
					renewalParam(c.text, 'authenticator') === 'standalone' &&
					!(renewalParam(c.text, 'pre_hook') && renewalParam(c.text, 'post_hook'))
			);
		owner = confs.length > 0 ? rt.port80Owner() : '';
	} finally {
		stop();
	}
	if (confs.length === 0)
		return {
			strategy: 'skipped',
			verified: true,
			detail: 'TLS renewal: no certificate here renews with port 80 of its own.'
		};
	if (owner === '' || /certbot/.test(owner))
		return {
			strategy: 'already',
			verified: true,
			detail:
				'TLS renewal: port 80 is free on this server, so the certificate can renew as it was set up.'
		};
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

	const parts: string[] = [];
	let allOk = true;
	let strategy = 'webroot';
	for (const conf of confs) {
		const name = conf.path.replace(/^.*\//, '').replace(/\.conf$/, '');
		const info = rt.certInfo(name);
		const domains = info && info.domains.length > 0 ? info.domains : [name];
		const domain = domains[0]!;

		// 1. does http://<domain>/.well-known/acme-challenge/… reach the build?
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

		// 2–3. webroot, checked by a real dry run, then read back.
		let ok = false;
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
					if (
						rt.writeFile(conf.path, want) &&
						!rt.certbot([
							'renew',
							'--dry-run',
							'--no-random-sleep-on-renew',
							'--cert-name',
							name,
							'--non-interactive'
						]).ok
					)
						rt.writeFile(conf.path, conf.text);
				}
				ok = rendersWebroot(rt.readFile(conf.path) ?? '', opts.webroot, domain);
			} finally {
				stop();
			}
		}
		if (ok) {
			parts.push(
				`${domain} now renews through the web server (a test renewal with Let's Encrypt passed; settings read back)`
			);
			continue;
		}

		// 4. fallback: free port 80 for the renewal only.
		const edge = rt.port80Container();
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
					ok = rt.certbot([
						'renew',
						'--dry-run',
						'--no-random-sleep-on-renew',
						'--cert-name',
						name,
						'--non-interactive'
					]).ok;
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
				`${domain} renews by pausing ${edge} for the few seconds certbot needs port 80 (a test renewal passed); the web build did not answer the challenge path${served ? '' : ' (the frontend may predate this release)'}`
			);
			continue;
		}

		// 5. leave it, say so.
		allOk = false;
		strategy = 'left-alone';
		parts.push(
			`${domain} could not be switched to a renewal that works while ${owner} holds port 80, so its settings were left as they were; it expires ${info?.notAfter ?? 'within 90 days of its issue'}. On this server run: sudo certbot reconfigure --cert-name ${name} --webroot --webroot-path ${opts.webroot}`
		);
	}
	return { strategy, verified: allOk, detail: `TLS renewal: ${parts.join('; ')}.` };
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
		}
	};
}
