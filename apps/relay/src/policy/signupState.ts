/**
 * Morphit relay — the signup-state directory (v1.20.0 fix wave, D3).
 *
 * The persisted daily-ceiling counter and the kill-switch sentinel live in one
 * directory (MORPHIT_RELAY_DATA_DIR, default /var/lib/morphit-relay). Neither
 * protection works if that directory is missing or read-only: the ceiling
 * silently resets on every restart and `touch SIGNUPS_DISABLED` does nothing.
 * So at boot the relay creates it and PROVES it can write there (a probe file,
 * written and removed) — observing the real state rather than trusting a mode
 * bit — and main.ts logs the result, so the operator knows whether the two
 * protections are actually active.
 */
import { mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export interface SignupStateDirStatus {
	readonly dir: string;
	/** True when a file could be created and removed in `dir`. */
	readonly writable: boolean;
	/** Why not, when not. */
	readonly error?: string;
}

/** Create `dir` (mode 0700, parents as needed) and verify it is writable. */
export function prepareSignupStateDir(dir: string): SignupStateDirStatus {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try {
			chmodSync(dir, 0o700);
		} catch {
			/* not ours to chmod (e.g. a shared dir) — writability is what matters */
		}
		const probe = join(dir, `.write-probe-${process.pid}`);
		writeFileSync(probe, 'ok', { mode: 0o600 });
		unlinkSync(probe);
		return { dir, writable: true };
	} catch (err) {
		return { dir, writable: false, error: err instanceof Error ? err.message : String(err) };
	}
}
