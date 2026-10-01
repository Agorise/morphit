/**
 * What BunkerWeb's scheduler did with the settings it was given. (v1.20.1)
 *
 * WHY. BunkerWeb 1.5 does not apply a settings change when its containers
 * restart: the scheduler first runs its jobs (blacklist, BunkerNet, GeoIP and
 * update downloads), THEN generates the nginx config, asks the edge to test it,
 * and only loads it if the test passes. If the test fails it quietly keeps
 * serving the last config that worked ("failing over to last working
 * configuration"). Two consequences we met on morphitir (2026-09-30):
 *
 *  - A settings change can be refused while everything looks healthy: the
 *    containers run, the site answers, the settings file and the container
 *    environment both show the new values — only the scheduler's log says the
 *    config test failed (there: a ModSecurity rule id loaded twice). morphitir
 *    had been refusing every change since Sep 7 this way.
 *  - On a network where those downloads time out, a rebuild takes minutes
 *    (morphitir: ~2 min from restart to the generated config).
 *
 * So a heal that changes BunkerWeb must read the scheduler's own verdict — and
 * wait for it as long as that takes — instead of sleeping a fixed time and
 * inspecting files. Everything here that parses is PURE; the runtime helpers
 * below are thin `docker` calls.
 */
import { spawnSync } from 'node:child_process';

export type SchedulerCycle =
	| { kind: 'pending' }
	| { kind: 'loaded' }
	| { kind: 'refused'; reason: string };

/** The scheduler's own words when the edge's config test rejects its config. */
const REFUSED = /config check failed|failing over to last working configuration/i;
/** …and when the edge accepted a reload. BunkerWeb logs this after a failover
 *  too (it reloads the OLD config), so a refusal anywhere in the window wins. */
const RELOADED = /Successfully sent API request to \S+\/reload\b/;

/** nginx's reason, from the edge's log: `[emerg] 162#162: <reason>`. PURE. */
export function nginxRefusal(edgeLogs: string): string | null {
	for (const line of edgeLogs.split('\n')) {
		const m = /\[emerg\]\s+(?:\d+#\d+:\s+)?(.+?)\s*$/.exec(line);
		if (m) return m[1]!;
	}
	return null;
}

/**
 * The scheduler's verdict on the config it built since the logs start. `edgeLogs`
 * (the edge container's log over the same window) supplies nginx's reason when
 * the config was refused. PURE.
 */
export function readSchedulerCycle(schedulerLogs: string, edgeLogs = ''): SchedulerCycle {
	const lines = schedulerLogs.split('\n');
	if (lines.some((l) => REFUSED.test(l))) {
		const why = nginxRefusal(edgeLogs);
		return {
			kind: 'refused',
			reason: why
				? `BunkerWeb's own config test failed (${why}), so it kept serving its previous config`
				: "BunkerWeb's own config test failed, so it kept serving its previous config"
		};
	}
	if (lines.some((l) => RELOADED.test(l))) return { kind: 'loaded' };
	return { kind: 'pending' };
}

/**
 * How long this box's scheduler took, at its last start, from starting to a
 * generated config — the time any BunkerWeb settings change needs here. From
 * `docker logs --timestamps` (every line starts with an RFC 3339 time) and the
 * container's StartedAt. null when the log does not show it. PURE.
 */
export function schedulerCycleMs(startedAtIso: string, timestampedLogs: string): number | null {
	const started = Date.parse(startedAtIso);
	if (!Number.isFinite(started)) return null;
	for (const line of timestampedLogs.split('\n')) {
		if (!/Generator successfully executed/.test(line)) continue;
		const at = Date.parse(line.split(/\s/, 1)[0] ?? '');
		if (Number.isFinite(at) && at >= started) return at - started;
	}
	return null;
}

// ─── runtime (docker) ───────────────────────────────────────────────────

/** `docker logs --since <iso> <name>`, stdout + stderr; '' when unreadable. */
export function dockerLogsSince(
	name: string,
	sinceIso: string,
	timeoutMs: number,
	timestamps = false
): string {
	try {
		const r = spawnSync(
			'docker',
			['logs', ...(timestamps ? ['--timestamps'] : []), '--since', sinceIso, name],
			{ encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }
		);
		return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
	} catch {
		return '';
	}
}

/** The scheduler's verdict since `sinceIso`, read now. */
export function schedulerCycleNow(
	scheduler: string,
	edge: string | null,
	sinceIso: string,
	timeoutMs = 15_000
): SchedulerCycle {
	return readSchedulerCycle(
		dockerLogsSince(scheduler, sinceIso, timeoutMs),
		edge ? dockerLogsSince(edge, sinceIso, timeoutMs) : ''
	);
}

/** This box's last measured rebuild time (see schedulerCycleMs); null if unknown. */
export function measuredSchedulerCycleMs(scheduler: string, timeoutMs = 15_000): number | null {
	try {
		const started = (
			spawnSync('docker', ['inspect', scheduler, '--format', '{{.State.StartedAt}}'], {
				encoding: 'utf8',
				timeout: timeoutMs
			}).stdout ?? ''
		).trim();
		if (!started) return null;
		return schedulerCycleMs(started, dockerLogsSince(scheduler, started, timeoutMs, true));
	} catch {
		return null;
	}
}

/**
 * Poll the scheduler until it has loaded or refused the config it builds after
 * `sinceIso`, or `budgetMs` passes. Synchronous (the WAF heal is), with a
 * progress line every `noteEveryMs` so no wait is silent.
 */
export function waitForSchedulerCycle(opts: {
	scheduler: string;
	edge: string | null;
	sinceIso: string;
	budgetMs: number;
	pollMs?: number;
	noteEveryMs?: number;
	note?: (msg: string) => void;
	now?: () => number;
	sleep?: (ms: number) => void;
	read?: () => SchedulerCycle;
}): SchedulerCycle & { waitedMs: number } {
	const now = opts.now ?? (() => Date.now());
	const sleep =
		opts.sleep ??
		((ms: number) => {
			spawnSync('sleep', [String(Math.max(1, Math.round(ms / 1000)))], { timeout: ms + 5_000 });
		});
	const read = opts.read ?? (() => schedulerCycleNow(opts.scheduler, opts.edge, opts.sinceIso));
	const start = now();
	let lastNote = start;
	for (;;) {
		const c = read();
		if (c.kind !== 'pending') return { ...c, waitedMs: now() - start };
		if (now() - start >= opts.budgetMs) return { kind: 'pending', waitedMs: now() - start };
		if (opts.note && now() - lastNote >= (opts.noteEveryMs ?? 30_000)) {
			lastNote = now();
			opts.note(
				`still waiting for BunkerWeb to rebuild its settings (${Math.round((now() - start) / 1000)} s so far — its downloads are slow on this network)…`
			);
		}
		sleep(opts.pollMs ?? 3_000);
	}
}
