/**
 * Installed-box heal: this server's Tor is new enough for today's Tor network.
 *
 * WHY (morphitlat, 2026-10-29 → 2026-11-01). Since 28 October 2026 the Tor
 * consensus requires the Desc=2-3 / Microdesc=2-3 subprotocols, which Tor 0.4.8
 * (end of life 1 June 2026) does not have: a 0.4.8 Tor stalls at "Bootstrapped
 * 30%" and loads nothing — no .onion, no hidden Blurt node, no npm package
 * through Tor. Ubuntu 24.04 shipped 0.4.8.10 and backported 0.4.9.11 to
 * noble-UPDATES on 13 August 2026 (LP #2163259); the daily automatic updates
 * install -security only, so a server nobody ran `apt upgrade` on kept 0.4.8.
 * morphitlat (zero-clearnet: apt only over Tor) could then fetch nothing at all.
 * morphit.io, morphitir and vigilante had 0.4.9.11 from their own updates.
 *
 * WHAT, on this server, only when `tor --version` is older than 0.4.9:
 *   1. apt refreshes and upgrades `tor` (and `tor-geoipdb` when installed) to
 *      the newest it offers, keeping the operator's /etc/tor/torrc (confold).
 *      On a zero-clearnet node apt goes through Tor's SOCKS port (as the
 *      bridges heal installs its transports), so only while Tor still reaches
 *      the network; when it does not, nothing is tried and the detail says how
 *      to bring the two packages on a USB stick.
 *   2. VERIFY: `tor --version` read back is 0.4.9 or newer, and Tor reaches
 *      the network (a hidden Blurt node answers through it) within a few
 *      minutes of the package's own restart.
 * A Tor already new enough is left alone ("routine"). Never downgrades, never
 * edits torrc, never adds a package source.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { runAsync, sleepMs } from './spinRun.ts';
import { torSocksFromEnv } from './torOnlyOsHeal.ts';
import { releaseTorBridgesLock, takeTorBridgesLock, TOR_BRIDGES_LOCK } from './torBridgesHeal.ts';

/** The oldest Tor today's Tor network accepts as a client. */
export const TOR_MIN_VERSION = '0.4.9';
/** apt's refresh, through Tor on a zero-clearnet node. */
export const TOR_VERSION_APT_UPDATE_MS = 5 * 60_000;
/** The install (two packages, about 4 MB). */
export const TOR_VERSION_INSTALL_MS = 5 * 60_000;
/** After the package restarted Tor: how long it gets to answer. */
export const TOR_VERSION_PROOF_MS = 4 * 60_000;
/** The longest this heal can take (the after-restart unit's time limit adds it). */
export const TOR_VERSION_HEAL_MAX_MS =
	TOR_VERSION_APT_UPDATE_MS + TOR_VERSION_INSTALL_MS + TOR_VERSION_PROOF_MS + 60_000;

/** a >= b for dotted numeric versions ("0.4.9.11" vs "0.4.9"); a missing
 *  part counts as 0. PURE. */
export function versionAtLeast(a: string, b: string): boolean {
	const pa = a.split('.').map((x) => Number.parseInt(x, 10));
	const pb = b.split('.').map((x) => Number.parseInt(x, 10));
	if ([...pa, ...pb].some((n) => !Number.isFinite(n))) return false;
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x > y;
	}
	return true;
}

/** The Tor version in `tor --version`'s first line, or null. PURE. */
export function parseTorVersion(out: string): string | null {
	return /Tor version (\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
}

export interface TorVersionRuntime {
	/** `tor --version`, parsed; null when Tor is not installed. */
	torVersion(): string | null;
	/** A zero-clearnet node (apt only through Tor). */
	hiddenOnly(): boolean;
	/** Does Tor reach the network now (a hidden Blurt node answers)? Tries for
	 *  up to `withinMs`. */
	torWorks(withinMs: number): Promise<boolean>;
	/** `apt-get update`, through Tor when `overTor`. */
	aptUpdate(overTor: boolean): Promise<boolean>;
	/** apt's candidate version of `tor`, or null. */
	candidate(): string | null;
	/** `apt-get install --only-upgrade tor tor-geoipdb`, keeping torrc. */
	install(overTor: boolean): Promise<boolean>;
	/** The Ubuntu release this system is built on (Linux Mint names it too). */
	ubuntuBase(): string | null;
}

const USB = (base: string | null): string =>
	`On a computer with internet, download Ubuntu's tor and tor-geoipdb 0.4.9 packages for ${
		base === 'noble' || base === null ? 'Ubuntu 24.04 (noble)' : `Ubuntu ${base}`
	} (noble-updates: tor_0.4.9.11-0ubuntu0.24.04.1_amd64.deb and tor-geoipdb_0.4.9.11-0ubuntu0.24.04.1_all.deb), ` +
	'copy both to this server and run here: sudo apt install ./tor_*.deb ./tor-geoipdb_*.deb';

export async function heal(ctx: HealCtx, rt: TorVersionRuntime): Promise<HealResult> {
	const before = rt.torVersion();
	if (before === null) {
		return {
			strategy: 'not-installed',
			verified: true,
			routine: true,
			detail: 'Tor is not installed here.'
		};
	}
	if (versionAtLeast(before, TOR_MIN_VERSION)) {
		return {
			strategy: 'already',
			verified: true,
			routine: true,
			detail: `Tor ${before} is new enough for the Tor network.`
		};
	}
	const overTor = rt.hiddenOnly();
	const why =
		`Tor ${before} is too old for the Tor network: since 28 October 2026 it needs ${TOR_MIN_VERSION} or newer, ` +
		'and an older Tor connects to nothing (no .onion, no hidden Blurt node).';
	if (overTor && !(await rt.torWorks(60_000))) {
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `${why} This server reaches the internet only through Tor, which is not connected, so it cannot download the update itself. ${USB(rt.ubuntuBase())}`
		};
	}
	let stop = ctx.spinner(`Asking Ubuntu for Tor's update${overTor ? ' through Tor' : ''}…`);
	const refreshed = await rt.aptUpdate(overTor);
	stop();
	const cand = rt.candidate();
	if (!refreshed || cand === null || !versionAtLeast(cand, TOR_MIN_VERSION)) {
		return {
			strategy: 'no-candidate',
			verified: false,
			detail:
				`${why} ${refreshed ? `Ubuntu offers ${cand ?? 'no Tor'} here` : "Ubuntu's package list could not be refreshed"}. ` +
				(rt.ubuntuBase() === 'noble'
					? USB('noble')
					: 'Install Tor 0.4.9 or newer from the Tor Project (support.torproject.org/apt) on this server.')
		};
	}
	stop = ctx.spinner(`Installing Tor ${cand} (your Tor settings are kept)…`);
	const installed = await rt.install(overTor);
	stop();
	const after = rt.torVersion();
	if (!installed || after === null || !versionAtLeast(after, TOR_MIN_VERSION)) {
		return {
			strategy: 'install-failed',
			verified: false,
			detail: `${why} Installing Tor ${cand} did not finish (Tor is ${after ?? 'not installed'}). On this server: sudo apt-get install --only-upgrade tor`
		};
	}
	stop = ctx.spinner(`Tor ${after} installed; waiting for it to connect…`);
	const works = await rt.torWorks(TOR_VERSION_PROOF_MS);
	stop();
	return works
		? {
				strategy: 'applied',
				verified: true,
				detail: `Tor updated from ${before} to ${after} (the Tor network refuses Tor older than ${TOR_MIN_VERSION} since 28 October 2026); it connects (a hidden Blurt node answered through it).`
			}
		: {
				strategy: 'applied-not-connected',
				verified: false,
				detail: `Tor updated from ${before} to ${after}, but it does not reach the Tor network yet; the Tor bridges check that follows tries bridges. If it still cannot, on this server: sudo morphit-ops health`
			};
}

// ── the real server ───────────────────────────────────────────────────────

/** apt's options through Tor's SOCKS port (the bridges heal's own form). */
export function aptViaTor(socks: string): string[] {
	const proxy = `socks5h://apt-transport-tor@${socks}`;
	return ['-o', `Acquire::http::Proxy=${proxy}`, '-o', `Acquire::https::Proxy=${proxy}`];
}

/** `apt-get install` keeping the operator's config files (torrc above all). */
export function torUpgradeArgs(overTor: boolean, socks: string): string[] {
	return [
		...(overTor ? aptViaTor(socks) : []),
		'-o',
		'DPkg::Lock::Timeout=300',
		'-o',
		'Dpkg::Options::=--force-confdef',
		'-o',
		'Dpkg::Options::=--force-confold',
		'install',
		'-y',
		'--only-upgrade',
		'tor',
		'tor-geoipdb'
	];
}

export function realTorVersionRuntime(): TorVersionRuntime {
	const socks = torSocksFromEnv();
	const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
	return {
		torVersion: () => {
			const r = spawnSync('tor', ['--version'], { encoding: 'utf8', timeout: 15_000 });
			return r.status === 0 ? parseTorVersion(r.stdout ?? '') : null;
		},
		hiddenOnly: () => isHiddenOnlyNode(),
		torWorks: async (withinMs) => {
			const until = Date.now() + withinMs;
			const onions = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter((u) => /\.onion:/.test(u)).slice(
				0,
				3
			);
			do {
				for (const u of onions) {
					// --noproxy '': curl applies no_proxy even to a SOCKS proxy.
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
		},
		aptUpdate: async (overTor) =>
			(
				await runAsync(
					'apt-get',
					[...(overTor ? aptViaTor(socks) : []), '-o', 'DPkg::Lock::Timeout=300', 'update', '-q'],
					{ timeoutMs: TOR_VERSION_APT_UPDATE_MS, env }
				)
			).status === 0,
		candidate: () => {
			const r = spawnSync('apt-cache', ['policy', 'tor'], { encoding: 'utf8', timeout: 30_000 });
			return (
				/Candidate:\s*(\S+)/
					.exec(r.stdout ?? '')?.[1]
					?.replace(/^\d+:/, '')
					.split('-')[0] ?? null
			);
		},
		install: async (overTor) =>
			(
				await runAsync('apt-get', torUpgradeArgs(overTor, socks), {
					timeoutMs: TOR_VERSION_INSTALL_MS,
					env
				})
			).status === 0,
		ubuntuBase: () => {
			try {
				const t = readFileSync('/etc/os-release', 'utf8');
				// Linux Mint 22.3 says VERSION_CODENAME=zena, UBUNTU_CODENAME=noble.
				return (
					/^UBUNTU_CODENAME=["']?([a-z]+)/m.exec(t)?.[1] ??
					/^VERSION_CODENAME=["']?([a-z]+)/m.exec(t)?.[1] ??
					null
				);
			} catch {
				return null;
			}
		}
	};
}

/** The heal as `morphit-ops upgrade` runs it: under the Tor bridges lock, so
 *  it never installs Tor while the bridges check restarts it. */
export async function healTorVersion(
	ctx: HealCtx,
	deps: { readonly runtime?: TorVersionRuntime; readonly lockPath?: string } = {}
): Promise<HealResult> {
	const lock = deps.lockPath ?? TOR_BRIDGES_LOCK;
	if (!takeTorBridgesLock(lock))
		return {
			strategy: 'busy',
			verified: true,
			routine: true,
			detail:
				'Tor version: a Tor check is running on this server now; it is checked again next time.'
		};
	try {
		return await heal(ctx, deps.runtime ?? realTorVersionRuntime());
	} finally {
		releaseTorBridgesLock(lock);
	}
}
