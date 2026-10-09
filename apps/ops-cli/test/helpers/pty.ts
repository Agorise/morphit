/**
 * Run a few lines of TypeScript in a child process whose stdout and stderr are
 * a real terminal (`script` allocates a pseudo-terminal), as an operator's
 * `sudo morphit-ops upgrade` has — the only way to see whether a spinner
 * actually turns (it draws nothing without a terminal, and nothing at all
 * while a blocking spawnSync holds the event loop).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const OPS = resolve(import.meta.dirname, '..', '..');
export const REPO = resolve(OPS, '..', '..');
export const TSX = join(REPO, 'node_modules', '.bin', 'tsx');

/** `body` runs inside an async module; `$` is its import of `module` (an
 *  absolute path or one relative to apps/ops-cli). Returns everything the
 *  terminal received. */
export function runInTerminal(
	module: string,
	body: string,
	opts: { env?: Record<string, string>; timeoutMs?: number } = {}
): { out: string; status: number | null } {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-pty-'));
	try {
		const runner = join(dir, 'run.mts');
		const path = module.startsWith('/') ? module : join(OPS, module);
		writeFileSync(
			runner,
			`const $ = await import(${JSON.stringify(path)});\n${body}\nprocess.exit(0);\n`
		);
		const r = spawnSync('script', ['-qec', `${TSX} ${runner}`, '/dev/null'], {
			encoding: 'utf8',
			timeout: opts.timeoutMs ?? 60_000,
			env: { ...process.env, ...(opts.env ?? {}) }
		});
		return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Run a shell command line in a pseudo-terminal; everything it printed
 *  (also when it was stopped at `timeoutMs`). */
export function commandInTerminal(
	line: string,
	opts: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {}
): string {
	const r = spawnSync('script', ['-qec', line, '/dev/null'], {
		encoding: 'utf8',
		timeout: opts.timeoutMs ?? 60_000,
		cwd: opts.cwd,
		env: { ...process.env, ...(opts.env ?? {}) }
	});
	return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** How many times a braille spinner frame was drawn beside `label`. */
export function spinnerFrames(out: string, label: string): number {
	// As drawn on an 80-column terminal: a longer label is cut to fit the line
	// (init/spinner.ts), and these terminals report no size, so 80 is assumed.
	const chars = [...label];
	const shown = chars.length <= 75 ? label : `${chars.slice(0, 74).join('')}…`;
	const esc = shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return (out.match(new RegExp(`\\r {2}[\\u2800-\\u28ff] ${esc}`, 'g')) ?? []).length;
}

/** A stand-in command on PATH: `name` runs `body` (sh). */
export function stub(bin: string, name: string, body: string): void {
	writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
