/**
 * remediation.ts (cp-installer-hardening) — makes the installer SELF-HEALING and
 * self-documenting, so a node admin runs it ONCE.
 *
 * For every failing system check it knows:
 *   - a plain-English SUGGESTION (what to do), and
 *   - when the fix is safe + scriptable, an AUTO-FIX the wizard offers as
 *     "Shall I fix this for you right now? (y/N)".
 *
 * Everything the wizard does or skips is recorded in a JOURNAL that the final
 * status report prints: what we fixed, what the admin approved, what got skipped,
 * and — only when there's no automatic path — the agorise@pm.me / @agorise:matrix.org last-resort line.
 *
 * remediationFor + renderRemediationReport are PURE + unit-tested. The
 * interactive runner (runRemediations) takes injected deps so it tests cleanly.
 */
import type { Check } from './systemCheck.ts';

export const SUPPORT_EMAIL = 'agorise@pm.me';
/** Matrix user MXID (private DM) — the PREFERRED support contact. Deliberately
 *  the `@` user handle, never the `#agorise:matrix.org` public room alias. */
export const SUPPORT_MATRIX = '@agorise:matrix.org';

export interface AutoFix {
	/** The exact shell command, shown to the admin and run on consent. */
	readonly command: string;
	readonly needsSudo: boolean;
	/** Default answer for "shall I fix this?" — true for small, obviously-safe
	 *  fixes (press Enter and move on); false for anything that installs software
	 *  or reshapes the box (explicit consent). */
	readonly defaultYes: boolean;
}

export interface Remediation {
	readonly checkName: string;
	readonly problem: string;
	readonly suggestion: string;
	/** Present ⇒ we can offer to do it automatically. */
	readonly autoFix?: AutoFix;
	/** No automatic path AND no obvious manual one ⇒ point at support. */
	readonly lastResort?: boolean;
}

export type RemediationOutcome = 'fixed' | 'fix-failed' | 'declined' | 'manual';

export interface RemediationRecord {
	readonly checkName: string;
	readonly problem: string;
	readonly outcome: RemediationOutcome;
	/** What we did / what the admin still needs to do. */
	readonly detail: string;
	readonly lastResort: boolean;
}

export type RemediationJournal = readonly RemediationRecord[];

/**
 * Map a failing Check to its remediation. PURE. Returns null for a passing check
 * or one with no known remedy (those just show their own note). Any 'error' with
 * no specific handler still gets a generic support-pointer so nothing is a dead
 * end.
 */
export function remediationFor(check: Check): Remediation | null {
	if (check.status === 'ok') return null;

	switch (check.name) {
		case 'localhost resolves':
			if (check.actual === 'no') {
				return {
					checkName: check.name,
					problem: 'localhost does not resolve',
					suggestion:
						'The local install inventory and the Postgres URL both need localhost. Adding it to /etc/hosts fixes it.',
					autoFix: { command: "echo '127.0.0.1 localhost' | sudo tee -a /etc/hosts", needsSudo: true, defaultYes: true }
				};
			}
			return {
				checkName: check.name,
				problem: `localhost maps to ${check.actual}`,
				suggestion: 'Harmless — the wizard already normalises the database host to 127.0.0.1 for you, so no action is needed.'
			};

		case 'Port availability':
			return {
				checkName: check.name,
				problem: check.actual,
				suggestion:
					'Another service already holds a port Morphit needs (80/443/5432). Run `sudo ss -tlnp` to see what it is, then stop or move it and re-run. I can\'t safely stop your other apps for you.'
			};

		case 'Docker subnet':
			return {
				checkName: check.name,
				problem: check.actual,
				suggestion:
					'An existing docker network overlaps Morphit\'s 172.20.0.0/16 subnet. Remove or relocate it (`docker network ls` / `docker network rm <name>`), then re-run. A compose subnet override is coming in a future release.'
			};

		case 'PostgreSQL':
			return {
				checkName: check.name,
				problem: `PostgreSQL is ${check.actual}`,
				suggestion:
					check.actual === 'not found'
						? 'Install PostgreSQL (Ubuntu 24.04\'s `apt install postgresql` = 16, which is fine), then re-run. The installer can also set it up for you.'
						: 'Morphit needs PostgreSQL >= 14. Your server is older — install a newer one (PGDG apt repo, apt.postgresql.org) and migrate your data; I won\'t auto-upgrade Postgres since that touches your database. Then re-run.'
			};

		case 'Ansible version':
			return {
				checkName: check.name,
				problem: `Ansible is ${check.actual}`,
				suggestion:
					"Morphit needs Ansible >= 2.10 (Ubuntu 24.04's default 2.16 is fine). Yours is older — upgrade it (pipx install --include-deps ansible, or your distro packages), then re-run.",
				autoFix: {
					command:
						'sudo apt-get remove -y ansible; sudo apt-get install -y pipx && pipx ensurepath && pipx install --include-deps ansible',
					needsSudo: true,
					defaultYes: true
				}
			};

		case 'Docker':
			// checkDocker warns when docker is absent; only actionable if they want BunkerWeb.
			return {
				checkName: check.name,
				problem: check.actual,
				suggestion:
					'Docker is only needed for the BunkerWeb web firewall. Install it (`curl -fsSL https://get.docker.com | sudo sh`) and add yourself to the docker group (`sudo usermod -aG docker $USER`, then log out/in), or choose the plain-nginx path which needs no Docker.',
				autoFix: check.actual === 'not installed'
					? { command: 'curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker "$USER"', needsSudo: true, defaultYes: true }
					: undefined
			};

		case 'RAM total':
			return {
				checkName: check.name,
				problem: `RAM ${check.actual}`,
				suggestion:
					'Morphit can OOM under load with little RAM. Adding a swapfile gives it headroom.',
				autoFix: {
					command:
						'sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab',
					needsSudo: true,
					defaultYes: true
				}
			};

		case 'Node.js':
			return {
				checkName: check.name,
				problem: `Node.js ${check.actual}`,
				suggestion:
					'The ops-cli needs Node 22+. Upgrade with nvm (`nvm install 22`) or NodeSource. I won\'t auto-upgrade Node so I don\'t disturb your other tooling.'
			};

		case 'Disk free':
		case 'Disk space':
			return {
				checkName: check.name,
				problem: `disk ${check.actual}`,
				suggestion:
					'The chain-synced database grows over time — free up space or attach a larger volume before syncing.',
				lastResort: false
			};

		default:
			// Unknown error: if we have ANY note to offer, that's guidance the admin
			// can act on → NOT a last resort. Only a truly unclassifiable error with
			// nothing to suggest is the worst case that warrants the support email.
			if (check.status === 'error') {
				const guidance = check.note?.trim();
				return {
					checkName: check.name,
					problem: check.actual,
					suggestion: guidance && guidance.length > 0
						? guidance
						: 'The installer hit a problem it could not classify or work around on its own.',
					lastResort: !(guidance && guidance.length > 0)
				};
			}
			return null;
	}
}

/**
 * Interactive pass over the checks: for each remediation, show the problem +
 * suggestion; if it has an auto-fix, offer "Shall I fix this for you right now?"
 * and act on the answer; record every outcome in the journal. Deps are injected
 * so this is testable without a real terminal or shell.
 */
export interface RemediationDeps {
	readonly ask: (question: string, defaultYes: boolean) => Promise<boolean>;
	readonly exec: (command: string) => boolean;
	readonly print: (line: string) => void;
}

export async function runRemediations(
	checks: readonly Check[],
	deps: RemediationDeps
): Promise<RemediationJournal> {
	const journal: RemediationRecord[] = [];
	for (const check of checks) {
		const rem = remediationFor(check);
		if (!rem) continue;

		const mark = check.status === 'error' ? '\u2717' : '\u26a0';
		deps.print(`\n  ${mark} ${rem.checkName}: ${rem.problem}`);
		deps.print(`     ${rem.suggestion}`);

		if (rem.autoFix) {
			deps.print(`     Fix: ${rem.autoFix.command}`);
			const yes = await deps.ask(
				`     Shall I fix this for you right now?${rem.autoFix.defaultYes ? ' (recommended — just press Enter)' : ''}`,
				rem.autoFix.defaultYes
			);
			if (yes) {
				const okFix = deps.exec(rem.autoFix.command);
				if (okFix) {
					deps.print('     \u2713 done.');
					journal.push({ checkName: rem.checkName, problem: rem.problem, outcome: 'fixed', detail: `you approved: ${rem.autoFix.command}`, lastResort: false });
				} else {
					deps.print('     \u2717 that fix did not complete — you can run the command above yourself.');
					journal.push({ checkName: rem.checkName, problem: rem.problem, outcome: 'fix-failed', detail: `tried but failed: ${rem.autoFix.command}. ${rem.suggestion}`, lastResort: false });
				}
			} else {
				journal.push({ checkName: rem.checkName, problem: rem.problem, outcome: 'declined', detail: rem.suggestion, lastResort: rem.lastResort ?? false });
			}
		} else {
			journal.push({ checkName: rem.checkName, problem: rem.problem, outcome: 'manual', detail: rem.suggestion, lastResort: rem.lastResort ?? false });
		}
	}
	return journal;
}

/**
 * Render the end-of-wizard remediation section. PURE + byte-stable for smokes.
 * Empty string when there's nothing to report (a totally clean install).
 */
export function renderRemediationReport(journal: RemediationJournal): string {
	if (journal.length === 0) return '';
	const fixed = journal.filter((r) => r.outcome === 'fixed');
	const pending = journal.filter((r) => r.outcome !== 'fixed');
	const lines: string[] = ['\u2500\u2500 Setup actions & anything to review \u2500\u2500'];

	if (fixed.length > 0) {
		lines.push('', 'Fixed during setup (you approved):');
		for (const r of fixed) lines.push(`  \u2713 ${r.checkName} \u2014 ${r.detail}`);
	}
	if (pending.length > 0) {
		lines.push('', 'Still needs your attention:');
		for (const r of pending) {
			const tag = r.outcome === 'declined' ? '(skipped)' : r.outcome === 'fix-failed' ? '(fix failed)' : '(manual)';
			lines.push(`  \u2022 ${r.checkName} ${tag} \u2014 ${r.detail}`);
		}
	}
	if (pending.some((r) => r.lastResort)) {
		lines.push(
			'',
			`If any of the above has you stuck, reach us with this summary and we'll get you online — email ${SUPPORT_EMAIL} or on Matrix: ${SUPPORT_MATRIX} (preferred).`
		);
	}
	return lines.join('\n');
}

// ── Journal accumulator ──────────────────────────────────────────────
// The wizard (init.ts) records outcomes here; the final report
// (runAnsibleInstall.ts) reads them at the very end, without threading the
// journal through every intermediate call. Reset at the start of each wizard run.
let ACCUMULATED: RemediationRecord[] = [];
export function recordRemediations(journal: RemediationJournal): void {
	ACCUMULATED = ACCUMULATED.concat(journal);
}
export function getRemediationJournal(): RemediationJournal {
	return [...ACCUMULATED];
}
export function resetRemediationJournal(): void {
	ACCUMULATED = [];
}
