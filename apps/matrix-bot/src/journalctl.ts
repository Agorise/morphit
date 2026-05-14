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
	const innerTs = typeof m['ts'] === 'string' ? m['ts'] : null;
	const journaldTs =
		typeof j['__REALTIME_TIMESTAMP'] === 'string'
			? new Date(Number(j['__REALTIME_TIMESTAMP']) / 1000).toISOString()
			: new Date().toISOString();
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

	return {
		module: m['module'] as string,
		event: m['event'] as string,
		payload,
		source,
		ts
	};
}

export function tailJournalctl(
	units: ReadonlyArray<string>,
	onAlert: (alert: StructuredAlert) => void,
	onError: (err: Error) => void = console.error
): JournalctlTailer {
	const args = ['-o', 'json', '--follow', '--no-pager'];
	for (const unit of units) {
		args.push('-u', unit);
	}
	let child: ChildProcess;
	try {
		child = spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (err) {
		onError(err instanceof Error ? err : new Error(String(err)));
		return { stop: () => {} };
	}

	const stdout = child.stdout as Readable | null;
	const stderr = child.stderr as Readable | null;
	if (stdout === null || stderr === null) {
		onError(new Error('journalctl spawn produced no stdout/stderr streams'));
		return { stop: () => child.kill('SIGTERM') };
	}

	let stdoutBuffer = '';
	stdout.setEncoding('utf-8');
	stdout.on('data', (chunk: string) => {
		stdoutBuffer += chunk;
		let newlineIdx: number;
		while ((newlineIdx = stdoutBuffer.indexOf('\n')) >= 0) {
			const line = stdoutBuffer.slice(0, newlineIdx);
			stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
			if (line.trim() === '') continue;
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

	child.on('exit', (code) => {
		onError(new Error(`journalctl exited with code ${code}`));
	});

	return {
		stop() {
			child.kill('SIGTERM');
		}
	};
}
