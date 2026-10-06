/**
 * Installed-box heal (after-restart unit): on a hidden-only node, fetch the
 * frontend's pinned nginx base image through Tor, with the time Tor needs.
 *
 * The frontend moves to this release's pinned base image when its container is
 * rebuilt (lib/proxyConfigHeal.ts). On a hidden-only node that rebuild waits
 * until the image is on the box or Docker pulls through Tor, which the tor-only
 * egress heal sets up in this same unit. The rebuild itself only gets about 40
 * seconds, and a pull through Tor takes minutes (morphitlat, 2026-10-05: the
 * `upgrade --heals` run after the switch still reported the older base).
 *
 * So, here, with up to 15 minutes: only on a hidden-only node, only when a
 * frontend container exists, the image is not here yet and the running Docker
 * daemon is seen pulling through Tor, `docker pull` the pinned base, then check
 * the image is really on the box. The caller then rebuilds the frontend onto
 * it. Nothing is fetched any other way.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { FRONTEND_BASE, dockerDaemonPullsThroughTor } from './proxyConfigHeal.ts';

export interface BaseFetchRuntime {
	hiddenOnly(): boolean;
	/** A frontend container serves the web build on this box. */
	frontendPresent(): boolean;
	/** The pinned base image is on this box. */
	basePresent(): boolean;
	/** The RUNNING Docker daemon pulls through Tor. */
	dockerPullsThroughTor(): boolean;
	/** `docker pull` the pinned base; true when it exited 0 in time. */
	pull(timeoutMs: number): Promise<boolean>;
}

/** The base's name without its digest, for people. */
const BASE_NAME = FRONTEND_BASE.split('@')[0]!;

export const BASE_FETCH_TIMEOUT_MS = 15 * 60_000;

export async function fetchFrontendBaseThroughTor(
	ctx: HealCtx,
	rt: BaseFetchRuntime,
	timeoutMs = BASE_FETCH_TIMEOUT_MS
): Promise<HealResult> {
	if (!rt.hiddenOnly()) return { strategy: 'not-tor-only', verified: true, detail: '' };
	if (!rt.frontendPresent()) return { strategy: 'skipped', verified: true, detail: '' };
	if (rt.basePresent()) return { strategy: 'already', verified: true, detail: '' };
	if (!rt.dockerPullsThroughTor())
		return {
			strategy: 'waiting',
			verified: true,
			detail: `The frontend's new nginx base (${BASE_NAME}) waits until Docker pulls through Tor; nothing is fetched from Docker Hub before then.`
		};
	const stop = ctx.spinner(
		`Fetching the frontend's nginx base image (${BASE_NAME}) through Tor — this can take several minutes…`
	);
	let pulled = false;
	const t0 = Date.now();
	try {
		pulled = await rt.pull(timeoutMs);
	} finally {
		stop();
	}
	const timedOut = !pulled && Date.now() - t0 >= timeoutMs - 1_000;
	if (pulled && rt.basePresent())
		return {
			strategy: 'fetched',
			verified: true,
			detail: `Fetched the frontend's nginx base image (${BASE_NAME}) through Tor (seen on this server).`
		};
	return {
		strategy: 'failed',
		verified: false,
		detail:
			(timedOut
				? `Could not fetch the frontend's nginx base image (${BASE_NAME}) through Tor within ${Math.round(timeoutMs / 60_000)} minutes; `
				: pulled
					? `Docker said it fetched the frontend's nginx base image (${BASE_NAME}), but it is not on this server; `
					: `Fetching the frontend's nginx base image (${BASE_NAME}) through Tor failed; `) +
			'the frontend keeps its current base and works as before. To try again later, on this server: sudo morphit-ops upgrade --heals'
	};
}

function dockerOk(args: string[], timeout = 15_000): boolean {
	try {
		return spawnSync('docker', args, { stdio: 'ignore', timeout }).status === 0;
	} catch {
		return false;
	}
}

/** The real runtime. `frontendPresent` is decided by the caller (it knows the
 *  install's build directory). */
export function realBaseFetchRuntime(frontendPresent: () => boolean): BaseFetchRuntime {
	return {
		hiddenOnly: () => isHiddenOnlyNode(),
		frontendPresent,
		basePresent: () => dockerOk(['image', 'inspect', FRONTEND_BASE]),
		dockerPullsThroughTor: () => dockerDaemonPullsThroughTor(),
		// Async, so the spinner turns while Docker works.
		pull: (timeoutMs) =>
			new Promise<boolean>((resolve) => {
				let child;
				try {
					child = spawn('docker', ['pull', '--quiet', FRONTEND_BASE], { stdio: 'ignore' });
				} catch {
					resolve(false);
					return;
				}
				const timer = setTimeout(() => {
					try {
						child.kill('SIGKILL');
					} catch {
						/* already gone */
					}
				}, timeoutMs);
				child.on('error', () => {
					clearTimeout(timer);
					resolve(false);
				});
				child.on('close', (code) => {
					clearTimeout(timer);
					resolve(code === 0);
				});
			})
	};
}
