/**
 * apps/ops-cli/src/init/spinner.ts
 *
 * A tiny, dependency-free braille "dots" spinner for slow wizard steps.
 *
 * WHY THIS EXISTS. Generating the alt-DNS (Tor / I2P) addresses runs `i2pd`,
 * which can take a few minutes on a small VPS. With no on-screen motion an
 * operator assumes the wizard has hung, hits Ctrl-C, and loses the work — the
 * opposite of the "SUPER SMOOTH, minimal decisions" node-setup goal. An
 * animated single character plus a "stand by" label reassures them it is
 * working and to wait.
 *
 * TTY-AWARE. On a non-interactive stdout (piped, CI, log capture) there is no
 * cursor to animate, so it prints the label once and no-ops the animation —
 * the resume/replay and smoke paths stay clean, non-garbled text.
 */

/**
 * Braille "dots" frames — a SINGLE character whose dots rotate (each glyph is a
 * braille cell, so the animation is the classic "6-dot animation character").
 */
const FRAMES = [
	'\u280b',
	'\u2819',
	'\u2839',
	'\u2838',
	'\u283c',
	'\u2834',
	'\u2826',
	'\u2827',
	'\u2807',
	'\u280f'
];

/**
 * Start an inline spinner with `label`. Returns a stop function that clears the
 * line and restores the cursor.
 *
 * The stop function is IDEMPOTENT, so a caller can safely stop it on BOTH the
 * success and the error path (whichever runs first) without double-clearing or
 * leaving the cursor hidden.
 */
export function startDotsSpinner(
	label: string,
	out: NodeJS.WriteStream = process.stdout,
	intervalMs = 80
): () => void {
	// No TTY → nothing to animate. Print the label once so the operator still
	// sees which slow step is running, then return a no-op stopper.
	if (!out.isTTY) {
		out.write(`  ${label}\n`);
		return () => {};
	}
	let i = 0;
	let stopped = false;
	out.write('\u001b[?25l'); // hide cursor
	const timer = setInterval(() => {
		out.write(`\r  ${FRAMES[i % FRAMES.length]} ${label}`);
		i += 1;
	}, intervalMs);
	// Don't keep the process alive just for the spinner (the await it wraps is
	// what should hold the event loop).
	if (typeof timer.unref === 'function') timer.unref();
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		out.write('\r\u001b[K\u001b[?25h'); // clear the line + show cursor
	};
}
