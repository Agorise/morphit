/**
 * The shape every installed-box heal added for the v1.21.0 review returns, so
 * `morphit-ops upgrade` can print and record them the same way.
 *
 *  - strategy: which way the heal took, in a word or two ('already',
 *    'applied', 'fallback-…', 'skipped', 'left-alone' …), for the log;
 *  - verified: the end state was OBSERVED on the box (a value read back, a
 *    process seen running as the right user, a probe answered) — never just a
 *    command's exit status;
 *  - detail: one calm sentence for the operator, naming what was checked and,
 *    when something is left to do, the exact command and the machine to run
 *    it on.
 */
export interface HealResult {
	readonly strategy: string;
	readonly verified: boolean;
	readonly detail: string;
}

/** What a heal may use to talk to the operator while it works. */
export interface HealCtx {
	readonly info: (m: string) => void;
	readonly warn: (m: string) => void;
	/** Shown before every wait; returns the function that stops it. */
	readonly spinner: (label: string) => () => void;
}
