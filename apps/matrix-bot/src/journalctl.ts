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
 *  most journald lines fall into this bucket and we skip them. */
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
	// emits a JSON string there with {module, kind, ...payload}.
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
	if (typeof m['kind'] !== 'string') return null;

	// Extract optional fields.
	const ts =
		typeof j['__REALTIME_TIMESTAMP'] === 'string'
			? // journald gives microseconds since epoch as a string;
			  // convert to ISO 8601.
			  new Date(Number(j['__REALTIME_TIMESTAMP']) / 1000).toISOString()
			: new Date().toISOString();
	const source =
		typeof j['_SYSTEMD_UNIT'] === 'string' ? j['_SYSTEMD_UNIT'] : undefined;

	// Strip module + kind from the payload so it's not duplicated.
	const { module: _mod, kind: _knd, ...rest } = m;
	void _mod;
	void _knd;
	const payload = Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : undefined;

	return {
		module: m['module'] as string,
		kind: m['kind'] as string,
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
