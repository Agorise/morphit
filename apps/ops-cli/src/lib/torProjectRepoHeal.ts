/**
 * Installed-box heal (v1.24.8): Tor comes from the Tor Project's own
 * repository, and so do its updates.
 *
 * WHY. Ubuntu ships Tor in its community section and updates it rarely: on
 * 2026-11-20 every server ran Ubuntu's 0.4.9.11 (June 2026) while the Tor
 * Project had published six security releases since (0.4.9.12–0.4.9.17), and
 * the Tor Project's own instructions say not to use Ubuntu's copy. Ubuntu's
 * new Tor versions also arrive as ordinary updates, which the automatic
 * security updates (lib/autoUpdates.ts) do not install; that is how Tor 0.4.8
 * cut morphitlat off on 2026-10-28.
 *
 * What the servers showed (components-check.sh, 2026-11-20): the Tor
 * Project's signing key fetched from its site has the published fingerprint
 * A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89; its Release file for noble is
 * signed by it (Origin TorProject, no Label, Architectures amd64 arm64); its
 * tor package would not ask about /etc/tor/torrc (changed on every server, not
 * changed by the package), restarts Tor itself, and carries the same unit and
 * AppArmor files as Ubuntu's. morphit.io and vigilante reach it directly,
 * morphitlat through Tor, morphitir not at all directly (torproject.org is
 * blocked there) — so the Tor Project's own onion is the second way.
 *
 * WHAT, on a server with Tor installed, MORPHIT_TOR_UPDATES on (the default,
 * /etc/morphit/updates.env), amd64 or arm64:
 *   1. The repository is found: its site directly (not on a zero-clearnet
 *      server), else its onion through this server's Tor. The key is fetched
 *      the same way and must have the published fingerprint; the Release file
 *      for this Ubuntu release must be signed by it and list this
 *      architecture. Nothing is written until all of that holds.
 *   2. A copy of the installed Tor packages is downloaded first (the way back).
 *   3. The key (/usr/share/keyrings/deb.torproject.org-keyring.gpg, where the
 *      Tor Project's keyring package keeps it current), the source
 *      (/etc/apt/sources.list.d/morphit-torproject.sources) and, for the onion,
 *      apt's proxy for that onion only are written; apt reads the repository.
 *   4. Tor is installed from it with the keyring package, the operator's
 *      settings kept (confold); VERIFIED: the installed version is the
 *      repository's, and Tor connects (a hidden Blurt node answers through it).
 *   5. Anything short of that puts it all back: the copied packages are
 *      reinstalled, the source and proxy removed, Tor restarted and checked.
 *   6. On success the automatic updates heal runs again, so the daily updates
 *      take Tor's from the Tor Project from now on.
 * MORPHIT_TOR_UPDATES off: a source Morphit added is removed (Tor stays as
 * installed). Never throws. Runs under the Tor bridges lock.
 */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import {
	UPDATES_ENV,
	parsePolicyReleases,
	parseUpdateSettings,
	torProjectRelease,
	ubuntuBase
} from './autoUpdates.ts';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { runAsync, sleepMs } from './spinRun.ts';
import { releaseTorBridgesLock, takeTorBridgesLock, TOR_BRIDGES_LOCK } from './torBridgesHeal.ts';
import { torSocksFromEnv } from './torOnlyOsHeal.ts';

/** The Tor Project's signing key, as published (support.torproject.org/apt). */
export const TP_FINGERPRINT = 'A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89';
export const TP_SITE_BASE = 'https://deb.torproject.org/torproject.org';
export const TP_ONION = 'apow7mjfryruh65chtdydfmqfpj5btws7nbocgtaovhvezgccyjazpqd.onion';
export const TP_ONION_BASE = `http://${TP_ONION}/torproject.org`;
export const TP_KEYRING = '/usr/share/keyrings/deb.torproject.org-keyring.gpg';
export const TP_SOURCE = '/etc/apt/sources.list.d/morphit-torproject.sources';
export const TP_ONION_PROXY = '/etc/apt/apt.conf.d/52morphit-torproject-onion';
export const TOR_ROLLBACK_DIR = '/var/lib/morphit/tor-rollback';
export const TP_KEYRING_PACKAGE = 'deb.torproject.org-keyring';
/** After the install restarted Tor: how long it gets to connect. */
export const TOR_REPO_PROOF_MS = 4 * 60_000;
/** The longest this heal can take, from its steps' own limits: the checks
 *  (key and release file, directly 2 × 30 s, through Tor 2 × 120 s), the copy
 *  (5 min), apt reading the repository (5 min), the install (10 min), the
 *  proof, and a way back (dpkg 10 min, Tor's restart 2 min, the proof again). */
export const TOR_REPO_HEAL_MAX_MS =
	5 * 60_000 +
	5 * 60_000 +
	5 * 60_000 +
	10 * 60_000 +
	TOR_REPO_PROOF_MS +
	12 * 60_000 +
	TOR_REPO_PROOF_MS +
	60_000;

export type TorRoute = 'site' | 'onion';

export interface TorRepoRuntime {
	readFile(path: string): string | null;
	/** Atomic, never through a link; true when read back equal. */
	writeFile(path: string, data: string | Buffer, mode: number): boolean;
	removeFile(path: string): boolean;
	/** dpkg's installed version of each package that is installed. */
	installedVersions(pkgs: readonly string[]): Record<string, string>;
	arch(): string;
	osRelease(): string | null;
	hiddenOnly(): boolean;
	/** The bytes at `url`, directly or through this server's Tor; null when
	 *  they did not come. */
	getUrl(url: string, viaTor: boolean): Promise<Buffer | null>;
	/** The fingerprints of every key in an armored key file. */
	fingerprints(armored: Buffer): string[];
	/** The key file in binary form (what apt's Signed-By reads), or null. */
	dearmor(armored: Buffer): Buffer | null;
	/** Is this InRelease signed by a key in this keyring? */
	verifySigned(keyring: Buffer, inRelease: Buffer): boolean;
	/** apt's Tor transport is here (tor+http). */
	hasTorTransport(): boolean;
	/** `apt-get update` of Morphit's Tor Project source only. */
	aptUpdateSource(): Promise<boolean>;
	/** `apt-cache policy` (no arguments). */
	aptPolicy(): string;
	/** `apt-cache policy <pkg>`. */
	pkgPolicy(pkg: string): string;
	/** `apt-get download <pkg>=<version>…` into `dir`; the files, or null. */
	downloadPackages(pkgs: Readonly<Record<string, string>>, dir: string): Promise<string[] | null>;
	/** `apt-get install -y` keeping the operator's config files. */
	install(pkgs: readonly string[]): Promise<boolean>;
	/** `dpkg -i` (downgrades allowed) keeping config files. */
	dpkgInstall(files: readonly string[]): Promise<boolean>;
	restartTor(): Promise<void>;
	/** Does Tor reach the network (a hidden Blurt node answers)? */
	torWorks(withinMs: number): Promise<boolean>;
}

/** PURE. The deb822 source Morphit writes. */
export function tpSourceText(uri: string, codename: string): string {
	return [
		'# Morphit (morphit-ops upgrade, since v1.24.8): Tor from the Tor Project',
		'# (support.torproject.org/apt). Off: MORPHIT_TOR_UPDATES=off in /etc/morphit/updates.env.',
		'Types: deb',
		`URIs: ${uri}`,
		`Suites: ${codename}`,
		'Components: main',
		`Signed-By: ${TP_KEYRING}`,
		''
	].join('\n');
}

/** PURE. apt's proxy for the Tor Project's onion only (a clearnet server). */
export function tpOnionProxyText(socks: string): string {
	return [
		"// Morphit (since v1.24.8): the Tor Project's repository through its onion,",
		"// via this server's Tor (only that address; nothing else goes through Tor).",
		`Acquire::http::Proxy::${TP_ONION} "socks5h://apt-transport-tor@${socks}";`,
		''
	].join('\n');
}

/** PURE. A field of a Release file (clearsigned InRelease included). */
export function releaseField(release: string, key: string): string {
	return new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(release)?.[1]?.trim() ?? '';
}

/** PURE. The sites the installed version of a package came from, and the
 *  candidate version with its sites, from `apt-cache policy <pkg>`. */
export function policyVersions(text: string): {
	installed: string | null;
	candidate: string | null;
	sites: Record<string, string[]>;
} {
	const installed = /^\s+Installed: (\S+)/m.exec(text)?.[1] ?? null;
	const candidate = /^\s+Candidate: (\S+)/m.exec(text)?.[1] ?? null;
	const sites: Record<string, string[]> = {};
	let cur: string | null = null;
	for (const l of text.split('\n')) {
		const v = /^ (?:\*\*\*| {3}) (\S+) -?\d+$/.exec(l);
		if (v) {
			cur = v[1]!;
			sites[cur] = [];
			continue;
		}
		const src = /^\s+-?\d+ (?:[a-z+]+:\/\/)([^/\s]+)/.exec(l);
		if (src && cur !== null) sites[cur]!.push(src[1]!);
	}
	return {
		installed: installed === '(none)' ? null : installed,
		candidate: candidate === '(none)' ? null : candidate,
		sites
	};
}

const TP_HOSTS = ['deb.torproject.org', TP_ONION];
const fromTp = (sites: readonly string[] | undefined): boolean =>
	(sites ?? []).some((s) => TP_HOSTS.includes(s));

export async function healTorProjectRepo(
	ctx: HealCtx,
	rt: TorRepoRuntime,
	deps: {
		/** The automatic updates heal, run again after a switch. */
		readonly refreshAutoUpdates?: () => Promise<HealResult>;
		readonly socks?: string;
	} = {}
): Promise<HealResult> {
	const { settings } = parseUpdateSettings(rt.readFile(UPDATES_ENV));
	const ours = [TP_SOURCE, TP_ONION_PROXY].filter((p) => rt.readFile(p) !== null);
	if (!settings.securityUpdates || !settings.torUpdates) {
		if (ours.length === 0) return { strategy: 'off', verified: true, routine: true, detail: '' };
		const gone = ours.every((p) => rt.removeFile(p));
		return {
			strategy: 'off',
			verified: gone,
			detail: gone
				? `Tor from the Tor Project is off in ${UPDATES_ENV}: the repository Morphit had added was removed; Tor stays as installed.`
				: `Tor from the Tor Project is off in ${UPDATES_ENV}, but ${ours.join(' and ')} could not be removed. On this server: sudo rm ${ours.join(' ')}`
		};
	}
	const tor = rt.installedVersions(['tor', 'tor-geoipdb']);
	if (!tor['tor']) return { strategy: 'no-tor', verified: true, routine: true, detail: '' };
	const arch = rt.arch();
	if (arch !== 'amd64' && arch !== 'arm64')
		return {
			strategy: 'unsupported-arch',
			verified: true,
			routine: true,
			detail: ''
		};
	const base = ubuntuBase(rt.osRelease());
	if (base === null) return { strategy: 'not-ubuntu', verified: true, routine: true, detail: '' };

	// Already switched: Tor installed from the Tor Project, its source here.
	const before = policyVersions(rt.pkgPolicy('tor'));
	if (
		ours.includes(TP_SOURCE) &&
		before.installed !== null &&
		fromTp(before.sites[before.installed]) &&
		torProjectRelease(parsePolicyReleases(rt.aptPolicy())) !== null
	)
		return {
			strategy: 'already',
			verified: true,
			routine: true,
			detail: `Tor ${before.installed} comes from the Tor Project's own repository.`
		};

	// The Tor Project's repository set up by someone else (the admin's own
	// source): left as it is. A second source for the same repository with
	// another key file makes apt refuse every update ("Conflicting values set
	// for option Signed-By"), so Morphit never adds one beside it.
	if (!ours.includes(TP_SOURCE) && torProjectRelease(parsePolicyReleases(rt.aptPolicy())) !== null)
		return { strategy: 'own-source', verified: true, routine: true, detail: '' };

	// 1. Find the repository and prove it.
	const hidden = rt.hiddenOnly();
	const tryRoutes: TorRoute[] = hidden ? ['onion'] : ['site', 'onion'];
	let found: { route: TorRoute; keyring: Buffer } | null = null;
	const tried: string[] = [];
	for (const route of tryRoutes) {
		const baseUrl = route === 'site' ? TP_SITE_BASE : TP_ONION_BASE;
		const viaTor = route === 'onion';
		const stop = ctx.spinner(
			`Checking the Tor Project's repository${viaTor ? ' through Tor (its .onion)' : ''}…`
		);
		let armored: Buffer | null = null;
		let inRelease: Buffer | null = null;
		try {
			armored = await rt.getUrl(`${baseUrl}/${TP_FINGERPRINT}.asc`, viaTor);
			if (armored !== null)
				inRelease = await rt.getUrl(`${baseUrl}/dists/${base.codename}/InRelease`, viaTor);
		} finally {
			stop();
		}
		const where = viaTor ? 'its .onion through Tor' : 'its site';
		if (armored === null || inRelease === null) {
			tried.push(`${where} did not answer`);
			continue;
		}
		if (!rt.fingerprints(armored).includes(TP_FINGERPRINT)) {
			tried.push(`the key from ${where} is not the published one`);
			continue;
		}
		const keyring = rt.dearmor(armored);
		if (keyring === null || !rt.verifySigned(keyring, inRelease)) {
			tried.push(`the release file from ${where} is not signed by the Tor Project's key`);
			continue;
		}
		const rel = inRelease.toString('utf8');
		if (
			releaseField(rel, 'Codename') !== base.codename ||
			!releaseField(rel, 'Architectures').split(/\s+/).includes(arch)
		) {
			tried.push(`it has no Tor for Ubuntu ${base.codename} on ${arch}`);
			continue;
		}
		found = { route, keyring };
		break;
	}
	const keep = `Tor stays on ${tor['tor']} from Ubuntu for now`;
	if (found === null)
		return {
			strategy: 'unreachable',
			verified: true,
			detail: `Tor: the Tor Project's repository could not be used (${tried.join('; ')}), so ${keep}; the next upgrade tries again.`
		};

	// 2. The way back: the installed packages, downloaded first.
	try {
		rmSync(TOR_ROLLBACK_DIR, { recursive: true, force: true });
		mkdirSync(TOR_ROLLBACK_DIR, { recursive: true, mode: 0o700 });
	} catch {
		/* the download below fails and says so */
	}
	let stop = ctx.spinner(`Keeping a copy of Tor ${tor['tor']} (the way back)…`);
	let rollback: string[] | null;
	try {
		rollback = await rt.downloadPackages(tor, TOR_ROLLBACK_DIR);
	} finally {
		stop();
	}
	if (rollback === null || rollback.length !== Object.keys(tor).length)
		return {
			strategy: 'no-way-back',
			verified: true,
			detail: `Tor: the Tor Project's repository checks out, but a copy of the installed Tor ${tor['tor']} could not be downloaded first, so nothing was changed and ${keep}; the next upgrade tries again.`
		};

	// 3. Key, source, (onion) proxy; apt reads the repository.
	const socks = deps.socks ?? '127.0.0.1:9050';
	const uri =
		found.route === 'site'
			? TP_SITE_BASE
			: hidden && rt.hasTorTransport()
				? `tor+${TP_ONION_BASE}`
				: TP_ONION_BASE;
	const written: string[] = [];
	const installedFromTp = (): boolean => {
		const p = policyVersions(rt.pkgPolicy('tor'));
		return p.installed !== null && p.installed !== tor['tor'];
	};
	const putBack = async (why: string): Promise<HealResult> => {
		const s = ctx.spinner('Putting Tor back as it was…');
		let restored = true;
		try {
			for (const p of written) if (!rt.removeFile(p)) restored = false;
			if (installedFromTp()) restored = (await rt.dpkgInstall(rollback!)) && restored;
			await rt.restartTor();
		} finally {
			s();
		}
		const now = rt.installedVersions(['tor'])['tor'] ?? null;
		const works = await rt.torWorks(TOR_REPO_PROOF_MS);
		return {
			strategy: 'put-back',
			verified: false,
			detail:
				`Tor: moving Tor to the Tor Project's repository did not work (${why}), so it was put back: Tor ${now ?? 'is not installed'}` +
				(works ? ', and it connects' : ', but it does not connect yet') +
				(restored
					? ''
					: `; some files could not be put back (the copy is in ${TOR_ROLLBACK_DIR})`) +
				'. The next upgrade tries again. To look at it, on this server: sudo morphit-ops health'
		};
	};
	const keyringOwned = rt.installedVersions([TP_KEYRING_PACKAGE])[TP_KEYRING_PACKAGE] !== undefined;
	if (!keyringOwned) {
		const have = rt.readFile(TP_KEYRING);
		if (have === null || have !== found.keyring.toString('latin1')) {
			if (!rt.writeFile(TP_KEYRING, found.keyring, 0o644))
				return putBack(`${TP_KEYRING} could not be written`);
			written.push(TP_KEYRING);
		}
	}
	if (found.route === 'onion' && !uri.startsWith('tor+')) {
		if (!rt.writeFile(TP_ONION_PROXY, tpOnionProxyText(socks), 0o644))
			return putBack(`${TP_ONION_PROXY} could not be written`);
		written.push(TP_ONION_PROXY);
	}
	if (!rt.writeFile(TP_SOURCE, tpSourceText(uri, base.codename), 0o644))
		return putBack(`${TP_SOURCE} could not be written`);
	written.push(TP_SOURCE);
	stop = ctx.spinner("Reading the Tor Project's repository…");
	let read: boolean;
	try {
		read = await rt.aptUpdateSource();
	} finally {
		stop();
	}
	const offered = policyVersions(rt.pkgPolicy('tor'));
	if (
		!read ||
		offered.candidate === null ||
		!fromTp(offered.sites[offered.candidate]) ||
		torProjectRelease(parsePolicyReleases(rt.aptPolicy())) === null
	)
		return putBack("apt did not take Tor from the Tor Project's repository after reading it");

	// 4. Install, keeping the settings; read back; Tor must connect.
	stop = ctx.spinner(
		`Installing Tor ${offered.candidate} from the Tor Project (your Tor settings are kept)…`
	);
	let installed: boolean;
	try {
		installed = await rt.install([...Object.keys(tor), TP_KEYRING_PACKAGE]);
	} finally {
		stop();
	}
	const after = policyVersions(rt.pkgPolicy('tor'));
	if (!installed || after.installed !== offered.candidate || !fromTp(after.sites[after.installed]))
		return putBack(`the install did not finish (Tor is ${after.installed ?? 'not installed'})`);
	stop = ctx.spinner(`Tor ${after.installed} installed; waiting for it to connect…`);
	let works: boolean;
	try {
		works = await rt.torWorks(TOR_REPO_PROOF_MS);
	} finally {
		stop();
	}
	if (!works) return putBack(`Tor ${after.installed} did not connect`);

	// 6. The daily updates take Tor's from now on.
	const auto = deps.refreshAutoUpdates ? await deps.refreshAutoUpdates() : null;
	return {
		strategy: 'switched',
		verified: auto === null || auto.verified,
		detail:
			`Tor now comes from the Tor Project's own repository${found.route === 'onion' ? ' (through its .onion)' : ''}: ${tor['tor']} → ${after.installed}, your Tor settings kept, and it connects (a hidden Blurt node answered through it). Its updates install by themselves from now on.` +
			(auto !== null && !auto.verified ? ` ${auto.detail}` : '')
	};
}

// ── the real server ───────────────────────────────────────────────────────

function run(cmd: string, args: readonly string[], input?: Buffer): { ok: boolean; out: Buffer } {
	try {
		const r = spawnSync(cmd, [...args], {
			timeout: 60_000,
			maxBuffer: 32 * 1024 * 1024,
			...(input !== undefined ? { input } : {}),
			stdio: ['pipe', 'pipe', 'ignore'],
			env: { ...process.env, LC_ALL: 'C' }
		});
		return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0) };
	} catch {
		return { ok: false, out: Buffer.alloc(0) };
	}
}

export function realTorRepoRuntime(socks: string): TorRepoRuntime {
	const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' };
	const keepConf = [
		'-o',
		'DPkg::Lock::Timeout=300',
		'-o',
		'Dpkg::Options::=--force-confdef',
		'-o',
		'Dpkg::Options::=--force-confold'
	];
	const regular = (p: string): string | null => {
		try {
			return lstatSync(p).isFile() ? readFileSync(p, 'latin1') : null;
		} catch {
			return null;
		}
	};
	return {
		readFile: regular,
		writeFile: (path, data, mode) => {
			const tmp = `${path}.morphit-new`;
			try {
				try {
					if (!lstatSync(path).isFile()) return false;
				} catch {
					/* new */
				}
				rmSync(tmp, { force: true });
				writeFileSync(tmp, data, { mode, flag: 'wx' });
				renameSync(tmp, path);
				const want = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
				return regular(path) === want.toString('latin1');
			} catch {
				rmSync(tmp, { force: true });
				return false;
			}
		},
		removeFile: (p) => {
			try {
				if (!lstatSync(p).isFile()) return false;
				rmSync(p);
				return true;
			} catch {
				return !existsSync(p);
			}
		},
		installedVersions: (pkgs) => {
			const out: Record<string, string> = {};
			for (const p of pkgs) {
				const r = run('dpkg-query', ['-W', '-f=${Status}\t${Version}', p]);
				const [status, version] = r.out.toString('utf8').split('\t');
				if (status === 'install ok installed' && version) out[p] = version.trim();
			}
			return out;
		},
		arch: () => run('dpkg', ['--print-architecture']).out.toString('utf8').trim(),
		osRelease: () => regular('/etc/os-release') ?? regular('/usr/lib/os-release'),
		hiddenOnly: () => isHiddenOnlyNode(),
		getUrl: async (url, viaTor) => {
			const d = mkdtempSync(join(tmpdir(), 'morphit-tp-'));
			try {
				const f = join(d, 'body');
				const r = await runAsync(
					'curl',
					[
						'-fsSL',
						'--max-time',
						viaTor ? '120' : '30',
						...(viaTor ? ['--noproxy', '', '--socks5-hostname', socks] : []),
						'-o',
						f,
						url
					],
					{ timeoutMs: 150_000 }
				);
				return r.status === 0 && existsSync(f) ? readFileSync(f) : null;
			} finally {
				rmSync(d, { recursive: true, force: true });
			}
		},
		fingerprints: (armored) =>
			run('gpg', ['--batch', '--show-keys', '--with-colons'], armored)
				.out.toString('utf8')
				.split('\n')
				.filter((l) => l.startsWith('fpr:'))
				.map((l) => l.split(':')[9] ?? ''),
		dearmor: (armored) => {
			const r = run('gpg', ['--batch', '--dearmor'], armored);
			return r.ok && r.out.length > 0 ? r.out : null;
		},
		verifySigned: (keyring, inRelease) => {
			const d = mkdtempSync(join(tmpdir(), 'morphit-tpv-'));
			try {
				writeFileSync(join(d, 'k.gpg'), keyring);
				writeFileSync(join(d, 'InRelease'), inRelease);
				return run('gpgv', ['--keyring', join(d, 'k.gpg'), join(d, 'InRelease')]).ok;
			} finally {
				rmSync(d, { recursive: true, force: true });
			}
		},
		hasTorTransport: () => existsSync('/usr/lib/apt/methods/tor+http'),
		aptUpdateSource: async () => {
			const d = mkdtempSync(join(tmpdir(), 'morphit-tps-'));
			try {
				writeFileSync(join(d, 'morphit-torproject.sources'), readFileSync(TP_SOURCE));
				return (
					(
						await runAsync(
							'apt-get',
							[
								'-o',
								'Dir::Etc::SourceList=/dev/null',
								'-o',
								`Dir::Etc::SourceParts=${d}`,
								'-o',
								'APT::Get::List-Cleanup=0',
								'-o',
								'DPkg::Lock::Timeout=300',
								'update',
								'-q'
							],
							{ timeoutMs: 5 * 60_000, env }
						)
					).status === 0
				);
			} catch {
				return false;
			} finally {
				rmSync(d, { recursive: true, force: true });
			}
		},
		aptPolicy: () => run('apt-cache', ['policy']).out.toString('utf8'),
		pkgPolicy: (pkg) => run('apt-cache', ['policy', pkg]).out.toString('utf8'),
		downloadPackages: async (pkgs, dir) => {
			const r = await runAsync(
				'apt-get',
				['download', ...Object.entries(pkgs).map(([p, v]) => `${p}=${v}`)],
				{ cwd: dir, timeoutMs: 5 * 60_000, env }
			);
			if (r.status !== 0) return null;
			const files = readdirSync(dir)
				.filter((f) => f.endsWith('.deb'))
				.map((f) => join(dir, f));
			return files.length > 0 ? files : null;
		},
		install: async (pkgs) =>
			(
				await runAsync('apt-get', [...keepConf, 'install', '-y', '-q', ...pkgs], {
					timeoutMs: 10 * 60_000,
					env
				})
			).status === 0,
		dpkgInstall: async (files) =>
			(
				await runAsync('dpkg', ['--force-confdef', '--force-confold', '-i', ...files], {
					timeoutMs: 10 * 60_000,
					env
				})
			).status === 0,
		restartTor: async () => {
			await runAsync('systemctl', ['restart', 'tor'], { timeoutMs: 120_000 });
		},
		torWorks: async (withinMs) => {
			const until = Date.now() + withinMs;
			const onions = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter((u) => /\.onion:/.test(u)).slice(
				0,
				3
			);
			do {
				for (const u of onions) {
					const r = await runAsync(
						'curl',
						[
							'-s',
							'-o',
							'/dev/null',
							'-m',
							'40',
							'-w',
							'%{http_code}',
							'--noproxy',
							'',
							'--socks5-hostname',
							socks,
							`${u}/`
						],
						{ timeoutMs: 50_000 }
					);
					if (/^[1-5]\d\d$/.test(r.stdout.trim())) return true;
					if (Date.now() >= until) return false;
				}
				if (Date.now() + 20_000 < until) await sleepMs(20_000);
			} while (Date.now() < until);
			return false;
		}
	};
}

/** The heal as `morphit-ops upgrade` runs it: under the Tor bridges lock, so
 *  it never installs Tor while the bridges check restarts it. */
export async function healTorProjectRepoLocked(
	ctx: HealCtx,
	deps: {
		readonly runtime?: TorRepoRuntime;
		readonly lockPath?: string;
		readonly refreshAutoUpdates?: () => Promise<HealResult>;
	} = {}
): Promise<HealResult> {
	const lock = deps.lockPath ?? TOR_BRIDGES_LOCK;
	if (!takeTorBridgesLock(lock))
		return {
			strategy: 'busy',
			verified: true,
			routine: true,
			detail:
				"Tor's repository: a Tor check is running on this server now; it is checked again next time."
		};
	try {
		const socks = torSocksFromEnv();
		return await healTorProjectRepo(ctx, deps.runtime ?? realTorRepoRuntime(socks), {
			socks,
			...(deps.refreshAutoUpdates ? { refreshAutoUpdates: deps.refreshAutoUpdates } : {})
		});
	} finally {
		releaseTorBridgesLock(lock);
	}
}
