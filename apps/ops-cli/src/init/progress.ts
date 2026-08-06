// Wizard "save-as-you-go" progress.
//
// As the operator answers each step, the wizard remembers their
// NON-SECRET answers to a small file so an interrupted run can be
// resumed without re-typing everything.  On the next `init`, if a
// saved file is found, the operator is offered a resume that reuses
// those answers and only re-asks the two sensitive things.
//
// ─── SECURITY: what is DELIBERATELY NOT saved, and why ───────────────
//   - `activeKey`   — the relay's ACTIVE private key (plaintext WIF, or
//                     the encrypted envelope + its passphrase hint).  A
//                     private key must NEVER be written to this file: the
//                     file lives at a predictable home-directory path and
//                     PERSISTS across an interrupted run (it is only
//                     removed on a successful setup or an explicit "start
//                     fresh"), so persisting a key here would leave a
//                     dangling, fund-controlling secret on disk.
//   - `databaseUrl` — the Postgres connection string embeds the DB
//                     PASSWORD; same dangling-secret reasoning.
//   - `torOnion`    — the generated Tor hidden-service SECRET key (the
//                     onion's identity).  Same reasoning; the public
//                     .onion address itself rides in altNetworks.tor and
//                     IS fine to remember.
// All three are re-derived/re-prompted on resume.  The `WizardProgress`
// type below STRUCTURALLY omits them, so none can be persisted even by
// mistake, and `init-progress-smoke` additionally asserts the serialized
// form contains no key/password material.
//
// Everything else (instance name, account names, contact URL, asset and
// payment-method toggles, fee settings, RPC list, SEO, backup/BunkerWeb/
// hardening choices, Matrix surface IDs) is operator CONFIG — it is
// written to the 0600 config file at the end anyway — so remembering it
// between runs adds no new exposure.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import type { WizardAnswers } from './render.ts';

/** The subset of answers the wizard may remember between runs — every
 *  field EXCEPT the two secrets.  `Partial` because the file is written
 *  incrementally (only the steps answered so far are present). */
export type WizardProgress = Partial<Omit<WizardAnswers, 'databaseUrl' | 'activeKey' | 'torOnion'>>;

/** On-disk shape: a version tag (so an incompatible future format is
 *  ignored rather than mis-parsed) + when it was saved + the answers. */
interface ProgressFile {
	readonly version: 1;
	readonly savedAt: string;
	readonly answers: WizardProgress;
}

const PROGRESS_VERSION = 1 as const;

/** Home-scoped so it survives a working-directory change and is trivial
 *  to find and delete.  A host typically configures one instance; the
 *  resume prompt shows the saved instance name + age so a stale file is
 *  easy to recognize and discard. */
export function progressFilePath(): string {
	return join(homedir(), '.morphit-init-progress.json');
}

/** Persist the non-secret answers collected so far.  BEST-EFFORT: a
 *  write failure logs a one-line note and returns — resume is a
 *  convenience, never a requirement, so it must not abort the wizard. */
export function saveProgress(answers: WizardProgress): void {
	const p = progressFilePath();
	// Defense-in-depth: the type already omits them, but hard-delete the
	// two secret fields before writing so no future refactor or stray
	// Object.assign can ever land a private key or DB password here.
	const safe: Record<string, unknown> = { ...(answers as Record<string, unknown>) };
	delete safe.databaseUrl;
	delete safe.activeKey;
	// torOnion carries the Tor HS SECRET key — never persist it (the
	// public .onion address rides in altNetworks.tor, which is fine).
	delete safe.torOnion;
	const body: ProgressFile = {
		version: PROGRESS_VERSION,
		savedAt: new Date().toISOString(),
		answers: safe as WizardProgress
	};
	try {
		writeFileSync(p, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
		// Re-assert perms in case the file pre-existed with looser ones.
		chmodSync(p, 0o600);
	} catch {
		console.log('  ⓘ (could not save setup progress for resume — continuing)');
	}
}

/** Load saved progress, or null if absent / unreadable / from an
 *  incompatible version.  NEVER throws. */
export function loadProgress(): WizardProgress | null {
	const p = progressFilePath();
	try {
		if (!existsSync(p)) return null;
		const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<ProgressFile>;
		if (
			!parsed ||
			parsed.version !== PROGRESS_VERSION ||
			typeof parsed.answers !== 'object' ||
			parsed.answers === null
		) {
			return null;
		}
		return parsed.answers as WizardProgress;
	} catch {
		return null;
	}
}

/** The ISO timestamp the saved progress was last written, or null.
 *  Used to show the operator how old the resumable run is. */
export function loadProgressSavedAt(): string | null {
	const p = progressFilePath();
	try {
		if (!existsSync(p)) return null;
		const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<ProgressFile>;
		return typeof parsed?.savedAt === 'string' ? parsed.savedAt : null;
	} catch {
		return null;
	}
}

/** Remove the progress file — on a successful setup, or when the
 *  operator chooses to start fresh.  Best-effort. */
export function clearProgress(): void {
	try {
		const p = progressFilePath();
		if (existsSync(p)) unlinkSync(p);
	} catch {
		/* ignore — a leftover file is harmless (no secrets) and will be
		   offered for resume / overwritten next run. */
	}
}

/** A short, human-friendly age like "3 minutes ago" / "2 days ago" for
 *  the resume prompt.  Falls back to the raw timestamp on any oddity. */
export function describeAge(iso: string | null): string {
	if (!iso) return 'a previous run';
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return iso;
	const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (secs < 90) return 'just now';
	const mins = Math.round(secs / 60);
	if (mins < 90) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
	const hrs = Math.round(mins / 60);
	if (hrs < 36) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
	const days = Math.round(hrs / 24);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}
