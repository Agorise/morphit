/**
 * Pure decision logic for the ConversationView message window.
 *
 * A thread with hundreds of messages must not render every bubble. The view
 * keeps a sliding window over the loaded `messages` array — it renders only the
 * newest `INITIAL_WINDOW` and reveals older ones transparently as the reader
 * scrolls up. The newest messages are ALWAYS in the window (we slice from the
 * end), so incoming/sent messages appear immediately, and a genuine append
 * GROWS the window rather than sliding it, so nothing already on screen scrolls
 * away.
 *
 * This function is the state machine behind that window, extracted so it can be
 * unit-tested directly (the component embeds it in an `$effect`, which has no
 * test harness here). It is a pure reducer: given the previous window state, the
 * current message count, and the current peer, it returns the next state and
 * never touches the DOM.
 *
 * The subtlety it exists to get right: the message list starts EMPTY and
 * populates asynchronously when the controller delivers its first snapshot. That
 * first populated snapshot is an INITIAL LOAD, not an append — treating the
 * 0→N jump as an append (as the old inline code did, because its length tracker
 * was seeded to 0) grew the window by the whole history and rendered every
 * bubble on first open, defeating the entire windowing. So the baseline is only
 * established once messages actually exist, and the first populated snapshot for
 * a peer resets to the newest `initialWindow` slice.
 */
export interface MessageWindowState {
	/** The peer the current baseline was established for, or `null` before the
	 *  first populated snapshot. `null` is the sentinel that makes the first
	 *  populated snapshot an initial load rather than an append. */
	prevPeer: string | null;
	/** `messages.length` at the previous run, so a genuine append can be
	 *  detected as a positive delta. */
	prevLen: number;
	/** How many of the newest messages the view renders. */
	visibleCount: number;
}

/**
 * Advance the window state for the current message count and peer.
 *
 * @param prev          the previous window state
 * @param len           the current `messages.length`
 * @param peer          the current peer
 * @param initialWindow how many newest messages a fresh/switched conversation shows
 */
export function advanceMessageWindow(
	prev: MessageWindowState,
	len: number,
	peer: string,
	initialWindow: number
): MessageWindowState {
	// Nothing loaded yet: do NOT establish a baseline, or the first real
	// snapshot (0→N) would then look like an append of N messages.
	if (len === 0) return prev;

	// First populated snapshot for this peer, or the conversation switched:
	// show the newest `initialWindow` slice. This is an initial LOAD, so the
	// window is reset rather than grown — there is no already-rendered content
	// to keep anchored.
	if (prev.prevPeer !== peer) {
		return { prevPeer: peer, prevLen: len, visibleCount: initialWindow };
	}

	// Same peer, more messages than last time → a genuine append (new/sent).
	// Grow the window by the delta so the older messages already revealed stay
	// put (windowStart is unchanged) and the new ones show too.
	if (len > prev.prevLen) {
		return { prevPeer: peer, prevLen: len, visibleCount: prev.visibleCount + (len - prev.prevLen) };
	}

	// Same peer, same or fewer messages: keep the window; just update the
	// length baseline. (A shrink is absorbed by the slice's max(0, …) clamp;
	// the window is never shrunk here.)
	return { prevPeer: peer, prevLen: len, visibleCount: prev.visibleCount };
}
