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

/** The streams a spinner is drawing on right now (cursor hidden). */
const drawing = new Map<NodeJS.WriteStream, number>();
const RESTORE = '\r\u001b[K\u001b[?25h';
let signalsInstalled = false;

/** Ctrl-C (or a process.exit) while a spinner turns must give the operator's
 *  shell its cursor back: Node's default Ctrl-C exits without running any
 *  `finally`, which left the cursor hidden (review 2026-10-08). The SIGINT
 *  handler is attached only while a spinner is up, so Ctrl-C at a prompt
 *  behaves exactly as before. */
function onSigint(): void {
	for (const o of drawing.keys()) o.write(RESTORE);
	drawing.clear();
	process.removeListener('SIGINT', onSigint);
	// Another part of the program handles Ctrl-C itself: leave the exit to it.
	if (process.listenerCount('SIGINT') > 0) return;
	process.exit(130);
}
function track(out: NodeJS.WriteStream): void {
	if (!signalsInstalled) {
		signalsInstalled = true;
		process.on('exit', () => {
			for (const o of drawing.keys()) o.write(RESTORE);
		});
	}
	drawing.set(out, (drawing.get(out) ?? 0) + 1);
	if (!process.listeners('SIGINT').includes(onSigint)) process.on('SIGINT', onSigint);
}
function untrack(out: NodeJS.WriteStream): void {
	const n = (drawing.get(out) ?? 1) - 1;
	if (n > 0) drawing.set(out, n);
	else drawing.delete(out);
	if (drawing.size === 0) process.removeListener('SIGINT', onSigint);
}

/** `label` cut to fit one terminal line beside the frame: a label that wraps
 *  makes every frame land on a new line (`\r` only returns to the start of
 *  the last row), filling the screen with copies (review 2026-10-08). */
function fitLabel(label: string, columns: number | undefined): string {
	// A terminal that reports no size (0) is taken as the usual 80 columns.
	const cols = columns !== undefined && columns > 0 ? columns : 80;
	const room = Math.max(10, cols - 5); // "  ⠋ " and one spare column
	const chars = [...label];
	return chars.length <= room ? label : `${chars.slice(0, room - 1).join('')}…`;
}

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
	let i = 1;
	let stopped = false;
	out.write('\u001b[?25l'); // hide cursor
	track(out);
	// The first frame now: a spinner around synchronous work (spawnSync) gets
	// no timer tick until that work is done, and its label must be on screen
	// for the whole pause.
	out.write(`\r  ${FRAMES[0]} ${fitLabel(label, out.columns)}`);
	const timer = setInterval(() => {
		// Measured each frame: the window may be resized while it waits.
		out.write(`\r  ${FRAMES[i % FRAMES.length]} ${fitLabel(label, out.columns)}`);
		i += 1;
	}, intervalMs);
	// Don't keep the process alive just for the spinner (the await it wraps is
	// what should hold the event loop).
	if (typeof timer.unref === 'function') timer.unref();
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		untrack(out);
		out.write(RESTORE); // clear the line + show cursor
	};
}

/**
 * Run an async operation while the braille spinner turns, so a slow silent step
 * (a network check, a chain lookup, a DNS resolve) never looks frozen. The
 * spinner is ALWAYS stopped — success or throw — so it can't leave the cursor
 * hidden or the line dirty. On a non-TTY it degrades to printing the label once.
 */
export async function withSpinner<T>(
	label: string,
	fn: () => Promise<T>,
	out: NodeJS.WriteStream = process.stdout
): Promise<T> {
	const stop = startDotsSpinner(label, out);
	try {
		return await fn();
	} finally {
		stop();
	}
}

/**
 * A spinner for a wait that prints progress lines of its own (a download that
 * reports each step, a rebuild that says "still waiting…"): `say` takes the
 * spinner off its line, prints, and puts it back, so the label and a braille
 * frame are on screen for the whole wait and never mixed into a printed line.
 * On a non-TTY the label is printed once, and `say` just prints.
 */
export function startPausableSpinner(
	label: string,
	out: NodeJS.WriteStream = process.stdout
): { say: (print: () => void) => void; stop: () => void } {
	let stop = startDotsSpinner(label, out);
	let done = false;
	return {
		say: (print) => {
			stop();
			print();
			if (!done && out.isTTY === true) stop = startDotsSpinner(label, out);
		},
		stop: () => {
			done = true;
			stop();
		}
	};
}
