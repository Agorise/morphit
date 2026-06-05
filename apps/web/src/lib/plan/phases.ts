/**
 * Phase manifest for /plan.
 *
 * Single source of truth for the project's phase status,
 * surfaced as a badge on /plan.  Replaces the hardcoded
 * "in progress" chip removed in Part 68 (Sally finding L11).
 *
 * Source-of-truth-discipline rule: when a phase ships, the
 * maintainer flips it here in the same commit that tags the
 * release.  No "the chip is wrong but the docs are right"
 * drift — the chip IS the doc.
 *
 * Why a static manifest instead of reading chain ops?  Reading
 * a `morphit_phase_complete_v1` chain op would be the most
 * decentralized answer, but:
 *
 *   1. There's no such op type defined yet.  Phase-completion
 *      isn't a federation-wide event — every operator is on
 *      the same code, so phase status is a project-level
 *      claim, not an operator-level one.
 *   2. Adding a new chain-op type costs an indexer migration
 *      + relay support + handler implementation + a smoke;
 *      that's Phase-5 work to surface a status badge.
 *   3. A manifest in code is auditable (git blame shows when
 *      it flipped) and ships with the build, so a build
 *      operator running their own fork can override the
 *      manifest if they're forking phase boundaries.
 *
 * If you're updating this file, also update:
 *   - The corresponding `i18n.plan.phase_N_*` strings if the
 *     scope of a phase changed
 *   - `docs/PLAN.md` for the textual canonical
 *   - The brag-list if a "Phase X shipped" claim moves
 */

export type PhaseStatus = 'shipped' | 'in_progress' | 'planned';

export interface Phase {
	readonly number: 1 | 2 | 3 | 4 | 5 | 6;
	readonly status: PhaseStatus;
	/** Title key in i18n (`plan.phase_N_title`). */
	readonly titleKey: string;
	/** Body key in i18n (`plan.phase_N_body`). */
	readonly bodyKey: string;
}

/**
 * Current phase manifest.  Order matches /plan rendering order.
 *
 * Last reviewed: 2026-06-05 (cp200).  Phases 1–5 are
 * code-complete (shipped); phase 6 (API integrations &
 * marketing) is the current campaign and is in progress.
 *
 * NOTE: "shipped" here means the phase's deliverables are
 * code-complete; it doesn't mean Morphit is publicly launched.
 * Pre-launch hardening sits under the shipped phases.
 */
export const PHASES: readonly Phase[] = [
	{
		number: 1,
		status: 'shipped',
		titleKey: 'plan.phase_1_title',
		bodyKey: 'plan.phase_1_body'
	},
	{
		number: 2,
		status: 'shipped',
		titleKey: 'plan.phase_2_title',
		bodyKey: 'plan.phase_2_body'
	},
	{
		number: 3,
		status: 'shipped',
		titleKey: 'plan.phase_3_title',
		bodyKey: 'plan.phase_3_body'
	},
	{
		number: 4,
		status: 'shipped',
		titleKey: 'plan.phase_4_title',
		bodyKey: 'plan.phase_4_body'
	},
	{
		number: 5,
		status: 'shipped',
		titleKey: 'plan.phase_5_title',
		bodyKey: 'plan.phase_5_body'
	},
	{
		number: 6,
		status: 'in_progress',
		titleKey: 'plan.phase_6_title',
		bodyKey: 'plan.phase_6_body'
	}
];

/** i18n key for the status badge text. */
export function statusI18nKey(s: PhaseStatus): string {
	return `plan.status_badge.${s}`;
}

/** Tailwind class set for the status badge. */
export function statusBadgeClass(s: PhaseStatus): string {
	switch (s) {
		case 'shipped':
			return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100';
		case 'in_progress':
			return 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100';
		case 'planned':
			return 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300';
	}
}
