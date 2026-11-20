/**
 * Installed-box heal (after-restart unit): on a hidden-only node, bring the
 * frontend's pinned nginx base image onto the box — from this release's
 * offline bundle when it carries one, else through Tor, with the time Tor
 * needs.
 *
 * The frontend moves to this release's pinned base image when its container is
 * rebuilt (lib/proxyConfigHeal.ts). On a hidden-only node that rebuild waits
 * until the image is on the box: the web heal's rebuild has under a minute, and
 * a pull through Tor takes minutes (morphitlat, 2026-10-05: the
 * `upgrade --heals` run after the switch still reported the older base).
 *
 * So, here, last in the after-restart unit (after the tor-only egress heal sets
 * Docker to pull through Tor), only on a hidden-only node with a frontend
 * container that does not run on the pinned base yet:
 *  1. the image is already here and usable → the caller rebuilds onto it;
 *  2. the offline bundle carries it → `docker load`, then proven to be the
 *     pinned image (lib/frontendBaseImage.ts) → the caller rebuilds;
 *  3. the RUNNING Docker daemon pulls through Tor's SocksPort → `docker pull`
 *     of the pinned reference (with its digest) for as long as the unit has
 *     left (at most 15 minutes), then the image must be seen here; what Docker
 *     said is shown when it fails.
 *  4. (v1.24.7) otherwise, the pinned base is fetched from Docker Hub's registry
 *     through Tor without Docker (lib/registryOverTor.ts): every piece hashed
 *     against the pinned digest before `docker load`, then proven as in 2.
 * The same runs on a clearnet server that Docker Hub refuses (its `/v2/`
 * answers 403, as on morphitir): such a server could never pull the new base
 * itself. On any other clearnet server nothing happens here: the web heal's
 * rebuild pulls the base directly.
 * Nothing is fetched any other way. Docker that does not answer is said, never
 * counted as "nothing to change" (lib/dockerStatus.ts).
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { dockerStatus, type DockerStatus } from './dockerStatus.ts';
import {
	FRONTEND_BASE,
	FRONTEND_BASE_LABEL,
	dockerDaemonPullsThroughTor
} from './proxyConfigHeal.ts';
import {
	bundledBaseFile,
	frontendBaseState,
	loadBundledFrontendBase
} from './frontendBaseImage.ts';
import {
	dockerHubRefusesThisServer,
	dockerPlatform,
	fetchImageOverTor,
	realRegistryFetchHost
} from './registryOverTor.ts';
import { torSocksFromEnv } from './torOnlyOsHeal.ts';

export interface PullResult {
	/** `docker pull` exited 0. */
	readonly ok: boolean;
	/** It was stopped at the time limit. */
	readonly timedOut: boolean;
	/** The end of what Docker printed (raw; shown only after termSafe). */
	readonly output: string;
}

export interface BaseFetchRuntime {
	hiddenOnly(): boolean;
	/** Docker on this box: not installed, not answering, or answering. */
	docker(): DockerStatus;
	/** The running frontend container (it mounts this install's web build), or null. */
	frontend(): string | null;
	/** The pinned-base label of that container ('' when none); null when unreadable. */
	frontendBase(name: string): string | null;
	/** The pinned base is here and a build can use it without a pull. */
	basePresent(): boolean;
	/** `docker load` the offline bundle's copy and prove it is the pinned
	 *  image; true when a build can use it now. False without a bundle. */
	loadBundled(): boolean;
	/** The RUNNING Docker daemon pulls through Tor's SocksPort. */
	dockerPullsThroughTor(): boolean;
	/** `docker pull` the pinned base, stopped after `timeoutMs`. */
	pull(timeoutMs: number): Promise<PullResult>;
	/** Docker Hub refuses this (clearnet) server: `/v2/` answers 403 (v1.24.7,
	 *  morphitir). Asked only on a server that is not hidden-only. Optional:
	 *  absent → no. */
	hubRefused?(): boolean;
	/** Fetch the pinned base for this server's platform from Docker Hub's
	 *  registry through Tor, without Docker (lib/registryOverTor.ts), every
	 *  piece checked against the pinned digest; then load it and prove it is
	 *  the pinned image. Optional: absent → not tried. */
	fetchOverTor?(timeoutMs: number): Promise<{ ok: true } | { ok: false; why: string }>;
}

/** The base's name without its digest, for people. */
const BASE_NAME = FRONTEND_BASE.split('@')[0]!;

/** Longest pull through Tor. */
export const BASE_FETCH_TIMEOUT_MS = 15 * 60_000;
/** Less time than this left in the unit: no pull is started. */
export const BASE_FETCH_MIN_MS = 2 * 60_000;

/** "15 minutes", "90 seconds". */
function duration(ms: number): string {
	return ms >= 120_000
		? `${Math.round(ms / 60_000)} minutes`
		: `${Math.max(1, Math.round(ms / 1000))} seconds`;
}

/** PURE. Text from a program, fit to show in a terminal and a log: no escape
 *  sequences, control or bidirectional-override characters; one line; the
 *  last `max` characters that say something. */
export function termSafe(text: string, max = 300): string {
	const line = text
		// eslint-disable-next-line no-control-regex
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b./g, '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return line.length > max ? `…${line.slice(line.length - max + 1)}` : line;
}

export async function fetchFrontendBaseThroughTor(
	ctx: HealCtx,
	rt: BaseFetchRuntime,
	/** The pull's time limit, or how to work it out when the pull starts (the
	 *  checks and the bundle load before it take time too). */
	budget: number | (() => number) = BASE_FETCH_TIMEOUT_MS
): Promise<HealResult> {
	const hidden = rt.hiddenOnly();
	if (!hidden) {
		// A clearnet server: only one Docker Hub refuses needs this (the web
		// heal's rebuild pulls the base directly otherwise). The question goes
		// to Docker Hub, so it is asked last, only when the base is wanted.
		const quiet: HealResult = { strategy: 'not-tor-only', verified: true, detail: '' };
		if (rt.docker() !== 'up') return quiet;
		const name = rt.frontend();
		if (name === null || rt.frontendBase(name) === FRONTEND_BASE || rt.basePresent()) return quiet;
		if (rt.hubRefused?.() !== true) return quiet;
	}
	const d = rt.docker();
	if (d === 'missing')
		return {
			strategy: 'skipped',
			verified: true,
			routine: true,
			detail: 'Frontend base image: no Docker on this server.'
		};
	if (d === 'down')
		return {
			strategy: 'docker-down',
			verified: false,
			detail: `The frontend's nginx base image (${BASE_NAME}) was not checked: Docker is not answering on this server. On this server check: sudo systemctl status docker — then: sudo morphit-ops upgrade --heals`
		};
	const fe = rt.frontend();
	if (fe === null) return { strategy: 'skipped', verified: true, detail: '' };
	// Already built on the pinned base: nothing to fetch, whether or not the
	// base image itself is still here (`docker image prune -a` removes it).
	if (rt.frontendBase(fe) === FRONTEND_BASE)
		return { strategy: 'already', verified: true, detail: '' };
	if (rt.basePresent()) return { strategy: 'here', verified: true, detail: '' };
	const stopLoad = ctx.spinner(
		`Loading the frontend's nginx base image (${BASE_NAME}) from this release's offline bundle…`
	);
	let loaded = false;
	try {
		loaded = rt.loadBundled();
	} finally {
		stopLoad();
	}
	if (loaded)
		return {
			strategy: 'loaded',
			verified: true,
			detail: `Loaded the frontend's nginx base image (${BASE_NAME}) from this release's offline bundle (checked: it is the pinned image).`
		};
	const timeoutMs = typeof budget === 'function' ? budget() : budget;
	// A hidden-only node whose Docker pulls through Tor: Docker pulls it (3).
	// Otherwise (a hidden-only node whose Docker does not, or a clearnet server
	// Docker Hub refuses): fetched through Tor without Docker (4).
	if (!hidden || !rt.dockerPullsThroughTor()) {
		// Said first on a clearnet server: why it is not Docker's own pull.
		const lead = hidden ? '' : 'Docker Hub does not answer this server directly. ';
		if (rt.fetchOverTor === undefined)
			return {
				strategy: 'waiting',
				verified: true,
				detail: `The frontend's new nginx base (${BASE_NAME}) waits until Docker pulls through Tor; nothing is fetched from Docker Hub before then.`
			};
		if (timeoutMs < BASE_FETCH_MIN_MS)
			return {
				strategy: 'no-time',
				verified: false,
				detail: `The frontend's nginx base image (${BASE_NAME}) was not fetched this time: the background checks had no time left to fetch it through Tor. The frontend keeps its current base and works as before. To fetch it, on this server: sudo morphit-ops upgrade --heals`
			};
		const stop = ctx.spinner(
			`${lead}Fetching the frontend's nginx base image (${BASE_NAME}) through Tor, each piece checked against the pinned digest — this can take several minutes…`
		);
		let got: { ok: true } | { ok: false; why: string };
		try {
			got = await rt.fetchOverTor(timeoutMs);
		} finally {
			stop();
		}
		if (got.ok && rt.basePresent())
			return {
				strategy: 'fetched',
				verified: true,
				detail: `${lead}Fetched the frontend's nginx base image (${BASE_NAME}) through Tor: every piece matched the pinned digest, and Docker has it (checked).`
			};
		return {
			strategy: 'failed',
			verified: false,
			detail: `${lead}Could not fetch the frontend's nginx base image (${BASE_NAME}) through Tor (${got.ok ? 'Docker does not have it after loading it' : termSafe(got.why)}); the frontend keeps its current base and works as before. To try again later, on this server: sudo morphit-ops upgrade --heals`
		};
	}
	if (timeoutMs < BASE_FETCH_MIN_MS)
		return {
			strategy: 'no-time',
			verified: false,
			detail: `The frontend's nginx base image (${BASE_NAME}) was not fetched this time: the background checks had no time left for a pull through Tor. The frontend keeps its current base and works as before. To fetch it, on this server: sudo morphit-ops upgrade --heals`
		};
	const stop = ctx.spinner(
		`Fetching the frontend's nginx base image (${BASE_NAME}) through Tor — this can take several minutes…`
	);
	let r: PullResult;
	try {
		r = await rt.pull(timeoutMs);
	} finally {
		stop();
	}
	if (r.ok && rt.basePresent())
		return {
			strategy: 'fetched',
			verified: true,
			detail: `Fetched the frontend's nginx base image (${BASE_NAME}) through Tor (seen on this server).`
		};
	const said = termSafe(r.output);
	return {
		strategy: 'failed',
		verified: false,
		detail:
			(r.timedOut
				? `Could not fetch the frontend's nginx base image (${BASE_NAME}) through Tor within ${duration(timeoutMs)}`
				: r.ok
					? `Docker said it fetched the frontend's nginx base image (${BASE_NAME}), but it is not usable on this server`
					: `Fetching the frontend's nginx base image (${BASE_NAME}) through Tor failed`) +
			(said ? ` (Docker said: ${said})` : '') +
			'; the frontend keeps its current base and works as before. To try again later, on this server: sudo morphit-ops upgrade --heals'
	};
}

/** Keep the last `max` characters of a stream. */
function tail(max: number): { add(b: Buffer): void; text(): string } {
	let s = '';
	return {
		add: (b) => {
			s = (s + b.toString('utf8')).slice(-max);
		},
		text: () => s
	};
}

/** The real runtime. `frontend` finds the frontend container (the caller
 *  knows how); `buildDir` is the install's apps/web/build (its install holds
 *  the offline bundle, if any). */
export function realBaseFetchRuntime(opts: {
	readonly frontend: () => string | null;
	readonly buildDir: string;
}): BaseFetchRuntime {
	const bundle = bundledBaseFile(dirname(dirname(dirname(opts.buildDir))), FRONTEND_BASE);
	return {
		hiddenOnly: () => isHiddenOnlyNode(),
		docker: () => dockerStatus(),
		frontend: () => {
			try {
				return opts.frontend();
			} catch {
				return null;
			}
		},
		frontendBase: (name) => {
			try {
				const r = spawnSync(
					'docker',
					['inspect', '--format', `{{index .Config.Labels "${FRONTEND_BASE_LABEL}"}}`, name],
					{ encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }
				);
				return r.status === 0 ? `${r.stdout ?? ''}`.trim() : null;
			} catch {
				return null;
			}
		},
		basePresent: () => frontendBaseState(FRONTEND_BASE, bundle) !== 'absent',
		loadBundled: () => loadBundledFrontendBase(FRONTEND_BASE, bundle, 5 * 60_000) !== 'absent',
		dockerPullsThroughTor: () => dockerDaemonPullsThroughTor(),
		hubRefused: () => dockerHubRefusesThisServer(),
		fetchOverTor: async (timeoutMs) => {
			const t0 = Date.now();
			const platform = await dockerPlatform();
			if (platform === null) return { ok: false, why: "Docker did not say this server's platform" };
			const r = await fetchImageOverTor(
				FRONTEND_BASE,
				bundle,
				{ socks: torSocksFromEnv(), platform, timeoutMs: Math.max(60_000, timeoutMs - 3 * 60_000) },
				realRegistryFetchHost
			);
			if (!r.ok) return r;
			const left = Math.max(60_000, timeoutMs - (Date.now() - t0));
			return loadBundledFrontendBase(FRONTEND_BASE, bundle, left) !== 'absent'
				? { ok: true }
				: { ok: false, why: 'Docker did not take the fetched image' };
		},
		// Async, so the spinner turns while Docker works.
		pull: (timeoutMs) =>
			new Promise<PullResult>((resolve) => {
				const out = tail(4096);
				let timedOut = false;
				let child;
				try {
					child = spawn('docker', ['pull', '--quiet', FRONTEND_BASE], {
						stdio: ['ignore', 'pipe', 'pipe']
					});
				} catch (e) {
					resolve({ ok: false, timedOut: false, output: String(e) });
					return;
				}
				child.stdout?.on('data', out.add);
				child.stderr?.on('data', out.add);
				const timer = setTimeout(() => {
					timedOut = true;
					try {
						child.kill('SIGKILL');
					} catch {
						/* already gone */
					}
				}, timeoutMs);
				child.on('error', (e) => {
					clearTimeout(timer);
					resolve({ ok: false, timedOut, output: `${out.text()} ${e.message}` });
				});
				child.on('close', (code) => {
					clearTimeout(timer);
					resolve({ ok: code === 0 && !timedOut, timedOut, output: out.text() });
				});
			})
	};
}
