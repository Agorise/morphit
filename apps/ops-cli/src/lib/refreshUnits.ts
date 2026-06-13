/**
 * Refresh installed systemd unit files from the freshly-extracted repo
 * templates during `morphit-ops upgrade`.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The units in ops/systemd/ are STATIC files an operator copies to
 * /etc/systemd/system/ ONCE at init.  `upgrade` extracts a fresh tree and
 * RESTARTS the services, but historically never refreshed the unit FILES
 * — so a fix to a unit (e.g. adding `RestrictAddressFamilies=AF_UNIX` to
 * morphit-relay.service, without which a tsx-run service crash-loops on an
 * EAFNOSUPPORT error) shipped in the repo but never reached an
 * already-installed box.  This brings installed units up to date with the
 * templates so unit fixes propagate on upgrade.
 *
 * SAFETY
 * ──────
 *   - A unit is refreshed ONLY when it is already installed AND its bytes
 *     differ from the template — we never install a unit the operator
 *     didn't choose to run, and we don't churn identical files.
 *   - The previous file is copied to `<unit>.bak` before overwrite, so a
 *     hand-edited unit is never silently lost (diff it, re-apply as a
 *     drop-in if needed).
 *   - Drop-ins (`<unit>.d/*.conf`) live in a SEPARATE directory and are
 *     NEVER touched — operator overrides (like an AF_UNIX drop-in) win.
 *
 * Deterministic given its two directories + node:fs, so it's unit-tested
 * against temp dirs without a real /etc/systemd/system.
 */

import { readdirSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export type UnitAction = 'refreshed' | 'unchanged' | 'not-installed';

export interface UnitRefreshResult {
	readonly unit: string;
	readonly action: UnitAction;
	/** Where the prior installed file was saved (only for 'refreshed' when
	 *  applied). */
	readonly backupPath?: string;
}

export interface RefreshUnitsOptions {
	/** Directory holding the fresh unit templates
	 *  (`<installDir>/ops/systemd`). */
	readonly templateDir: string;
	/** Directory holding the installed units (`/etc/systemd/system`). */
	readonly systemdDir: string;
	/** When false, classify only (dry-run) and write nothing. */
	readonly apply: boolean;
}

export interface RefreshUnitsResult {
	readonly results: readonly UnitRefreshResult[];
	/** True when ≥1 unit was (or, in dry-run, would be) refreshed → the
	 *  caller must `systemctl daemon-reload`. */
	readonly reloadNeeded: boolean;
}

/** Refresh installed systemd unit files from templates.  See module doc
 *  for the safety invariants. */
export function refreshManagedUnits(opts: RefreshUnitsOptions): RefreshUnitsResult {
	if (!existsSync(opts.templateDir)) {
		return { results: [], reloadNeeded: false };
	}

	const units = readdirSync(opts.templateDir)
		.filter((f) => f.endsWith('.service') || f.endsWith('.timer'))
		.sort();

	const results: UnitRefreshResult[] = [];
	let reloadNeeded = false;

	for (const unit of units) {
		const installed = join(opts.systemdDir, unit);
		if (!existsSync(installed)) {
			results.push({ unit, action: 'not-installed' });
			continue;
		}
		const template = join(opts.templateDir, unit);
		if (readFileSync(template, 'utf-8') === readFileSync(installed, 'utf-8')) {
			results.push({ unit, action: 'unchanged' });
			continue;
		}
		reloadNeeded = true;
		if (opts.apply) {
			const backupPath = `${installed}.bak`;
			copyFileSync(installed, backupPath);
			copyFileSync(template, installed);
			results.push({ unit, action: 'refreshed', backupPath });
		} else {
			results.push({ unit, action: 'refreshed' });
		}
	}

	return { results, reloadNeeded };
}
