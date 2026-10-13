/**
 * installProgress.ts — the guided install remembers its answers as you go.
 *
 * 2026-10-12, a live install: a reflex Ctrl+C on the "save your database
 * password" screen (step 11) ended the guided install, and the re-run asked
 * every question again from step 1. The plain wizard (`morphit-ops init`,
 * init/progress.ts) has long remembered its answers; the guided install did not.
 *
 * Each NON-SECRET answer is written here the moment it is given; the next run
 * offers to reuse them. Deliberately NEVER written here, and asked again:
 *   - the relay account's active key (a private key that controls funds);
 *   - the alert bot's access token (and so the whole alerts step);
 *   - the home dynamic-DNS update URL (it carries the provider's password);
 *   - the database password (generated afresh on every run).
 * `InstallProgress` has no field for any of them, so none can be saved even by
 * mistake; the test also checks the file for them.
 *
 * Removed once the install itself succeeds (the answers then live in the
 * node's configuration), or when the operator chooses to start fresh.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { InstallMode } from './ansibleVars.ts';

export interface InstallProgress {
	readonly mode?: InstallMode;
	readonly torOnly?: boolean;
	readonly relayAccount?: string;
	readonly feesAccount?: string;
	readonly domain?: string;
	readonly instanceName?: string;
	/** '' = skipped. */
	readonly instanceTagline?: string;
	/** '' = skipped. */
	readonly matrixAddress?: string;
	readonly acmeEmail?: string;
	/** '' = plain-text backups chosen. */
	readonly backupAgeRecipient?: string;
}

interface ProgressFile {
	readonly version: 1;
	readonly savedAt: string;
	readonly answers: InstallProgress;
}

/** Only these keys are ever read back, whatever else a file holds. */
const KEYS: readonly (keyof InstallProgress)[] = [
	'mode',
	'torOnly',
	'relayAccount',
	'feesAccount',
	'domain',
	'instanceName',
	'instanceTagline',
	'matrixAddress',
	'acmeEmail',
	'backupAgeRecipient'
];

/** Home-scoped, next to the plain wizard's file. */
export function installProgressPath(home: string = homedir()): string {
	return join(home, '.morphit-install-progress.json');
}

/** Keep only known keys with the right type. PURE. */
export function sanitizeInstallProgress(raw: unknown): InstallProgress {
	if (typeof raw !== 'object' || raw === null) return {};
	const o = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of KEYS) {
		const v = o[k];
		if (k === 'torOnly') {
			if (typeof v === 'boolean') out[k] = v;
		} else if (k === 'mode') {
			if (v === 'home' || v === 'vps') out[k] = v;
		} else if (typeof v === 'string' && v.length <= 512) {
			out[k] = v;
		}
	}
	return out as InstallProgress;
}

export function loadInstallProgress(
	path: string = installProgressPath()
): { answers: InstallProgress; savedAt: string | null } | null {
	try {
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProgressFile>;
		if (parsed?.version !== 1) return null;
		const answers = sanitizeInstallProgress(parsed.answers);
		if (Object.keys(answers).length === 0) return null;
		return { answers, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null };
	} catch {
		return null;
	}
}

/** Merge `more` into the saved answers and write them (0600). Best-effort:
 *  a write failure never stops the install. */
export function rememberInstallAnswers(
	more: InstallProgress,
	path: string = installProgressPath(),
	now: () => Date = () => new Date()
): void {
	try {
		const prev = loadInstallProgress(path)?.answers ?? {};
		const file: ProgressFile = {
			version: 1,
			savedAt: now().toISOString(),
			answers: sanitizeInstallProgress({ ...prev, ...more })
		};
		writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
		chmodSync(path, 0o600);
	} catch {
		/* resume is a convenience; the install goes on without it */
	}
}

export function clearInstallProgress(path: string = installProgressPath()): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {
		/* best-effort */
	}
}
