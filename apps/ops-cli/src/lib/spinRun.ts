/**
 * apps/ops-cli/src/lib/spinRun.ts
 *
 * Run a child process WITHOUT blocking the event loop, under the braille
 * spinner, for the commands an operator sits through at the terminal (a
 * systemctl stop/start/restart, a docker query, a helper script).
 *
 * WHY. A spinner around a blocking `spawnSync` can only draw its first frame —
 * the event loop is stuck until the child exits, so the dots never turn and a
 * long wait looks frozen. Spawning asynchronously keeps the spinner turning for
 * the whole wait; the child's output is captured and shown AFTER the spinner
 * line is cleared, so it never mixes with the spinner.
 */

import { spawn, spawnSync } from 'node:child_process';
import { startDotsSpinner } from '../init/spinner.ts';

export interface AsyncRunResult {
	/** Exit code; null when killed by a signal, stopped at its time limit, or never started. */
	readonly status: number | null;
	/** stdout and stderr, interleaved as they arrived (tail kept to 1 MiB). */
	readonly output: string;
	/** stdout alone (tail kept to 1 MiB), for a caller that parses it. */
	readonly stdout: string;
	/** Why it could not be started (e.g. the binary is missing), else null. */
	readonly error: string | null;
	readonly timedOut: boolean;
}

export interface AsyncRunOpts {
	readonly timeoutMs?: number;
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
	/** How much of the output is kept (its tail), default 1 MiB. */
	readonly maxOutputBytes?: number;
}

/** Spawn `cmd args`, collect its output, resolve when it exits. Never throws. */
export function runAsync(
	cmd: string,
	args: readonly string[],
	opts: AsyncRunOpts = {}
): Promise<AsyncRunResult> {
	return new Promise((resolve) => {
		let output = '';
		let stdout = '';
		let timedOut = false;
		let done = false;
		let timer: NodeJS.Timeout | null = null;
		const finish = (status: number | null, error: string | null): void => {
			if (done) return;
			done = true;
			if (timer !== null) clearTimeout(timer);
			resolve({ status: timedOut ? null : status, output, stdout, error, timedOut });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, [...args], {
				stdio: ['ignore', 'pipe', 'pipe'],
				...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
				...(opts.env !== undefined ? { env: opts.env } : {})
			});
		} catch (e) {
			finish(null, e instanceof Error ? e.message : String(e));
			return;
		}
		const max = opts.maxOutputBytes ?? 1024 * 1024;
		// Decoded per stream, so a character split across two reads stays whole.
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		const add = (d: string): void => {
			output = (output + d).slice(-max);
		};
		child.stdout?.on('data', (d: string) => {
			stdout = (stdout + d).slice(-max);
			add(d);
		});
		child.stderr?.on('data', add);
		/** The child's own exit code once it has exited (undefined before). */
		let exitedWith: number | null | undefined;
		const dropPipes = (): void => {
			child.stdout?.destroy();
			child.stderr?.destroy();
		};
		if (opts.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				if (exitedWith !== undefined) {
					// The child is done; something it started still holds the
					// output open. Its result stands; that is not waited for.
					dropPipes();
					finish(exitedWith, null);
					return;
				}
				timedOut = true;
				child.kill('SIGKILL');
			}, opts.timeoutMs);
		}
		child.on('error', (e) => finish(null, e.message));
		child.on('exit', (code) => {
			exitedWith = code;
			// A grandchild may hold the pipes open after a kill; don't wait on it.
			if (timedOut) {
				dropPipes();
				finish(null, null);
			}
		});
		child.on('close', (code) => finish(code, null));
	});
}

/** {@link runAsync} with the braille spinner turning for the whole wait. The
 *  spinner is always stopped (line cleared) before this resolves. */
export async function runSpinning(
	label: string,
	cmd: string,
	args: readonly string[],
	opts: AsyncRunOpts & { readonly out?: NodeJS.WriteStream } = {}
): Promise<AsyncRunResult> {
	const stop = startDotsSpinner(label, opts.out);
	try {
		return await runAsync(cmd, args, opts);
	} finally {
		stop();
	}
}

/** Put a captured run's output on the terminal (what an inherited-stdio call
 *  used to show), after the spinner line has been cleared. */
export function showOutput(r: AsyncRunResult, out: NodeJS.WriteStream = process.stdout): void {
	const tail =
		r.error !== null
			? r.error
			: r.timedOut
				? '(it did not finish in time and was stopped; what it was doing may still be going on)'
				: null;
	const text =
		tail !== null
			? `${r.output}${r.output.endsWith('\n') || r.output === '' ? '' : '\n'}${tail}`
			: r.output;
	if (text.trim() === '') return;
	out.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** True when this process is uid 0. */
export function isRoot(): boolean {
	return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * `systemctl <args>` for an operator at the terminal. As root it runs under the
 * turning spinner (output shown after). NOT as root, systemctl may ask polkit
 * for a password on the terminal, so it runs as before — inherited stdio, no
 * spinner over a password prompt.
 */
export async function systemctlSpinning(
	label: string,
	args: readonly string[],
	opts: { readonly timeoutMs?: number; readonly out?: NodeJS.WriteStream } = {}
): Promise<{ readonly status: number | null; readonly error: boolean }> {
	if (!isRoot()) {
		const r = spawnSync('systemctl', [...args], { stdio: 'inherit' });
		return { status: r.status, error: r.error !== undefined };
	}
	const r = await runSpinning(label, 'systemctl', args, {
		timeoutMs: opts.timeoutMs ?? 120_000,
		...(opts.out !== undefined ? { out: opts.out } : {})
	});
	showOutput(r, opts.out);
	return { status: r.status, error: r.error !== null };
}

/** A promise that resolves after `ms` (keeps the event loop free for the spinner). */
export function sleepMs(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
