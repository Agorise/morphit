/**
 * journalctl tailer — spawns `journalctl -u <units> -o json
 * --follow` and emits each JSON line as a StructuredAlert.
 *
 * We deliberately do NOT use libjournald bindings — `journalctl`
 * is universally available and the protocol is just newline-
 * delimited JSON.  Simpler to run, simpler to test (you can
 * feed mock JSON lines to the parser directly).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { StructuredAlert } from './classifier.ts';

export interface JournalctlTailer {
	stop(): void;
	/** True while a journalctl process is running and being read. */
	isAlive(): boolean;
}

/** Best-effort parser: pulls the structured fields out of a
 *  journald JSON line.  Returns null if the line doesn't look
 *  like a Morphit structured alert (no `module` field, etc.) —
 *  most journald lines fall into this bucket and we skip them.
 *
 *  Expects the inner JSON shape produced by apps/indexer/src/log
 *  and apps/relay/src/log (both modules share the LogRecord
 *  shape): {ts, level, module, event, context, error?}.
 *  We map `event` → the bot's StructuredAlert.event, and pull
 *  payload from the `context` object. */
export function parseJournalLine(line: string): StructuredAlert | null {
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof obj !== 'object' || obj === null) return null;
	const j = obj as Record<string, unknown>;

	// journald wraps the original message in MESSAGE.  Morphit
	// emits a JSON string there with {ts, level, module, event,
	// context}.
	const messageField = j['MESSAGE'];
	if (typeof messageField !== 'string') return null;

	let inner: unknown;
	try {
		inner = JSON.parse(messageField);
	} catch {
		return null;
	}
	if (typeof inner !== 'object' || inner === null) return null;
	const m = inner as Record<string, unknown>;

	if (typeof m['module'] !== 'string') return null;
	if (typeof m['event'] !== 'string') return null;

	// ts: prefer the inner JSON's ts (most accurate — set by the
	// emitter), fall back to journald's __REALTIME_TIMESTAMP.
	//
	// Defensive: __REALTIME_TIMESTAMP is journald-produced and in
	// practice always a microsecond-epoch numeric string, but we
	// type-narrow + range-check it before letting it reach
	// `new Date(...)`.  If Number() returns NaN/Infinity OR the
	// derived ms value is outside Date's representable range
	// (±8.64e15), `toISOString()` would throw `RangeError: Invalid
	// time value` — and parseJournalLine's contract says it
	// returns null on malformed input, NOT that it throws.  The
	// call site (tailJournalctl's stdout 'data' handler) has no
	// outer try/catch, so a thrown RangeError would crash the
	// tailer and the bot would stop alerting silently.
	const innerTs = typeof m['ts'] === 'string' ? m['ts'] : null;
	const journaldRaw = j['__REALTIME_TIMESTAMP'];
	let journaldTs: string;
	if (typeof journaldRaw === 'string') {
		const micros = Number(journaldRaw);
		const millis = micros / 1000;
		// Date can represent ±8,640,000,000,000,000 ms (~ ±285M years).
		if (Number.isFinite(millis) && Math.abs(millis) <= 8.64e15) {
			journaldTs = new Date(millis).toISOString();
		} else {
			journaldTs = new Date().toISOString();
		}
	} else {
		journaldTs = new Date().toISOString();
	}
	const ts = innerTs ?? journaldTs;

	const source =
		typeof j['_SYSTEMD_UNIT'] === 'string' ? j['_SYSTEMD_UNIT'] : undefined;

	// Payload comes from the `context` object — that's where the
	// emitter put per-event fields.  Top-level fields (ts, level,
	// module, event, error) are envelope metadata, not payload.
	const ctx = m['context'];
	const payload =
		typeof ctx === 'object' && ctx !== null
			? (ctx as Record<string, unknown>)
			: undefined;

	// cap envelope-field lengths defensively.
	//
	// Today Morphit's own loggers emit short module/event constants
	// (typical names like "operator-balance" / "low_balance" — well
	// under 64 bytes) and journald itself bounds line size to
	// LineMax (default ~48 KiB).  Practical reach is ~zero.
	//
	// But capped the payload-details block at
	// MAX_FIELD_BYTES=1024 + MAX_PAYLOAD_BYTES=8192 because a
	// compromised SIDECAR (host-monitor / smartctl-monitor /
	// dmesg-monitor) could emit a mega-payload.  The same threat
	// model applies to module/event/source/ts: a sidecar bug or a
	// future logger refactor that accidentally lets user input
	// flow into one of these fields would create an unbounded-
	// length-string surface that the classifier's renderAlertBody
	// default-path (`${alert.module} :: ${alert.event}`) inlines
	// into the title without truncation, and the digest's `cat`
	// interpolation inlines without truncation.
	//
	// Defending at the parse boundary closes the gap for every
	// downstream consumer in one place.  256 bytes is generous —
	// 4× the longest current Morphit module/event name combined,
	// fits comfortably under Matrix's 65 KiB body cap even when
	// rendered into the HTML body.
	const MAX_ENVELOPE_FIELD_BYTES = 256;
	const truncEnv = (s: string): string =>
		s.length > MAX_ENVELOPE_FIELD_BYTES
			? `${s.slice(0, MAX_ENVELOPE_FIELD_BYTES)}…(truncated)`
			: s;

	return {
		module: truncEnv(m['module'] as string),
		event: truncEnv(m['event'] as string),
		payload,
		source: source !== undefined ? truncEnv(source) : undefined,
		ts: truncEnv(ts)
	};
}

export interface TailOptions {
	/** First wait before respawning journalctl after it exits. Default 1 s. */
	readonly initialBackoffMs?: number;
	/** Longest wait between respawns. Default 60 s. */
	readonly maxBackoffMs?: number;
}

/** The journald cursor of a raw `journalctl -o json` line, or null. */
function cursorOf(line: string): string | null {
	try {
		const c = (JSON.parse(line) as Record<string, unknown>)['__CURSOR'];
		return typeof c === 'string' && c !== '' ? c : null;
	} catch {
		return null;
	}
}

/**
 * Follow the given units' journal and hand every Morphit structured line to
 * `onAlert`.
 *
 * journalctl is RESPAWNED whenever it exits (journald restarted, the process
 * was killed, a spawn failed), with a backoff that doubles from
 * `initialBackoffMs` to `maxBackoffMs` and resets after a run that lasted a
 * minute. A respawn resumes with `--after-cursor` at the last line seen, so
 * nothing in between is lost and nothing already handled is sent again.
 * Before this, an exit was only logged: the bot went deaf while its health
 * endpoint still answered ok. `isAlive()` is what the health endpoint reports.
 */
export function tailJournalctl(
	units: ReadonlyArray<string>,
	onAlert: (alert: StructuredAlert) => void,
	onError: (err: Error) => void = console.error,
	options: TailOptions = {}
): JournalctlTailer {
	const initialBackoffMs = options.initialBackoffMs ?? 1_000;
	const maxBackoffMs = options.maxBackoffMs ?? 60_000;
	let child: ChildProcess | null = null;
	let alive = false;
	let stopped = false;
	let cursor: string | null = null;
	let backoffMs = initialBackoffMs;
	let respawnTimer: NodeJS.Timeout | null = null;

	const scheduleRespawn = (): void => {
		alive = false;
		child = null;
		if (stopped) return;
		const wait = backoffMs;
		backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
		onError(new Error(`journalctl is not running; restarting it in ${Math.round(wait / 1000)}s`));
		respawnTimer = setTimeout(start, wait);
	};

	function start(): void {
		respawnTimer = null;
		if (stopped) return;
		const args = ['-o', 'json', '--follow', '--no-pager'];
		if (cursor !== null) args.push(`--after-cursor=${cursor}`);
		for (const unit of units) {
			args.push('-u', unit);
		}
		let proc: ChildProcess;
		try {
			proc = spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (err) {
			onError(err instanceof Error ? err : new Error(String(err)));
			scheduleRespawn();
			return;
		}
		child = proc;
		const startedAt = Date.now();
		let ended = false;
		const onEnd = (): void => {
			if (ended) return;
			ended = true;
			// A run that lasted a while was healthy: the next failure starts the
			// backoff from the beginning again.
			if (Date.now() - startedAt >= 60_000) backoffMs = initialBackoffMs;
			scheduleRespawn();
		};
		proc.on('error', (err) => {
			onError(err);
			onEnd();
		});

		const stdout = proc.stdout as Readable | null;
		const stderr = proc.stderr as Readable | null;
		if (stdout === null || stderr === null) {
			onError(new Error('journalctl spawn produced no stdout/stderr streams'));
			proc.kill('SIGTERM');
			onEnd();
			return;
		}
		alive = true;

		let stdoutBuffer = '';
		stdout.setEncoding('utf-8');
		stdout.on('data', (chunk: string) => {
			stdoutBuffer += chunk;
			let newlineIdx: number;
			while ((newlineIdx = stdoutBuffer.indexOf('\n')) >= 0) {
				const line = stdoutBuffer.slice(0, newlineIdx);
				stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
				if (line.trim() === '') continue;
				cursor = cursorOf(line) ?? cursor;
				const alert = parseJournalLine(line);
				if (alert !== null) {
					try {
						onAlert(alert);
					} catch (err) {
						onError(err instanceof Error ? err : new Error(String(err)));
					}
				}
			}
		});

		stderr.setEncoding('utf-8');
		stderr.on('data', (chunk: string) => {
			onError(new Error(`journalctl stderr: ${chunk.trim()}`));
		});

		proc.on('exit', (code) => {
			onError(new Error(`journalctl exited with code ${code}`));
			onEnd();
		});
	}

	start();

	return {
		stop() {
			stopped = true;
			alive = false;
			if (respawnTimer !== null) clearTimeout(respawnTimer);
			child?.kill('SIGTERM');
		},
		isAlive() {
			return alive && !stopped;
		}
	};
}
