/**
 * RTL @handle isolation (t.txt — Ken, "set in stone").
 *
 * A Blurt @handle (e.g. @kentest3) is a stable ASCII identifier — the exact
 * thing a URL uses (`/@kentest3`, never `/kentest3@`). But inside RTL prose
 * (Farsi is our only RTL locale today) the '@' is a bidi-NEUTRAL character, so
 * "@alice" embedded in right-to-left text renders as "alice@" — the '@' drifts
 * to the trailing side. That is not a stylistic quibble: `blurt.blog/alice@`
 * 404s where `blurt.blog/@alice` loads, so the wrong rendering reads as a
 * different, invalid handle.
 *
 * The rule, set in stone: an @handle ALWAYS renders left-to-right, '@' first,
 * regardless of surrounding text direction. Enforced structurally in two places
 * so a translator (or a future string) can't reintroduce the bug:
 *
 *   1. i18n strings — every `@{var}` interpolation slot is wrapped, ONCE at
 *      load time (see i18n/index.ts), in Unicode LTR-isolate marks
 *      (U+2066 … U+2069). Harmless in LTR locales (the marks are invisible and
 *      change nothing); in RTL they pin the '@' + account as one LTR unit. Any
 *      NEW string that writes `@{account}` inherits the fix for free.
 *   2. The two non-i18n render sites (a profile <h1> and the backup-card print)
 *      wrap the handle in `<bdi class="ltr-in-rtl">` — same isolate +
 *      direction:ltr, expressed in the template.
 */

/** LEFT-TO-RIGHT ISOLATE — opens an LTR bidi-isolated run. */
export const LRI = '\u2066';
/** POP DIRECTIONAL ISOLATE — closes the run opened by LRI. */
export const PDI = '\u2069';

/**
 * Matches a literal '@' immediately followed by a simple `{var}` interpolation
 * — i.e. an @handle slot. ICU constructs like `{n, plural, …}` contain a comma
 * and are deliberately NOT matched.
 */
const AT_HANDLE = /@(\{[A-Za-z0-9_]+\})/g;

/**
 * Wrap every `@{var}` in one message string with LTR isolate marks. Idempotent:
 * an already-wrapped slot (a '@' already preceded by U+2066) is left alone, so
 * re-running the transform never double-wraps.
 */
export function isolateHandleString(s: string): string {
	if (s.indexOf('@{') === -1) return s;
	return s.replace(AT_HANDLE, (match, brace: string, offset: number, full: string) =>
		offset > 0 && full[offset - 1] === LRI ? match : `${LRI}@${brace}${PDI}`
	);
}

/**
 * Recursively transform a loaded messages tree, isolating `@{var}` in every
 * string leaf. Returns a NEW value; never mutates the imported module object.
 */
export function isolateAtHandles<T>(node: T): T {
	if (typeof node === 'string') return isolateHandleString(node) as unknown as T;
	if (Array.isArray(node)) return node.map((v) => isolateAtHandles(v)) as unknown as T;
	if (node !== null && typeof node === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
			out[k] = isolateAtHandles(v);
		}
		return out as unknown as T;
	}
	return node;
}
