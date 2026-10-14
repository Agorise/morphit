/**
 * RTL @handle isolation ("set in stone").
 *
 * A Blurt @handle (e.g. @tester3) is a stable ASCII identifier — the exact
 * thing a URL uses (`/@tester3`, never `/tester3@`). But inside RTL prose
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
 *      In an RTL locale, literal handles written into the text ("@bob with
 *      @sally", v1.21.8) are isolated the same way, and so are Matrix
 *      addresses (@agorise:matrix.org) and /@paths (/@username/).
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
/**
 * A literal Blurt handle written into the text ("@bob with @sally"): '@' not
 * after a word character, '/', or an LRI (so not an email, a /@path, nor one
 * already isolated), then a Blurt account name, not followed by a word
 * character, '.'+word, ':' or '{' (so not a Matrix id like @agorise:matrix.org,
 * nor an @{var} slot).
 */
const AT_LITERAL = /(^|[^\w/\u2066])@([a-z][a-z0-9.-]{1,14}[a-z0-9])(?![\w:{]|\.\w)/g;

/** A Matrix address written into the text (@agorise:matrix.org): '@' not
 *  after a word character, '/' or an LRI, the user part, ':', a server name. */
const AT_MATRIX = /(^|[^\w/\u2066])@([a-z0-9._=-]+:[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?![\w.-]*\u2069)/g;

/** A /@path written into the text (/@username/): starts after a space, an
 *  opening quote or '*' (never inside a link target "](…)", a `code` span,
 *  or one already isolated), up to the next space or closing mark. */
const AT_PATH = /(^|[\s*"«])(\/@[a-z{][^\s`*)\]»"]*)/g;

export function isolateHandleString(s: string, opts: { literals?: boolean } = {}): string {
	let out = s;
	if (out.indexOf('@{') !== -1)
		out = out.replace(AT_HANDLE, (match, brace: string, offset: number, full: string) =>
			offset > 0 && full[offset - 1] === LRI ? match : `${LRI}@${brace}${PDI}`
		);
	// v1.21.8 — in an RTL locale, literal handles too (the FAQ's examples).
	if (opts.literals === true && out.indexOf('@') !== -1) {
		out = out.replace(AT_LITERAL, (_m, pre: string, name: string) => `${pre}${LRI}@${name}${PDI}`);
		// Matrix addresses and /@paths read wrong the same way ("agorise:matrix.org@",
		// "/username@/"): the whole address is one LTR unit.
		out = out.replace(AT_MATRIX, (_m, pre: string, id: string) => `${pre}${LRI}@${id}${PDI}`);
		out = out.replace(AT_PATH, (_m, pre: string, path: string) => `${pre}${LRI}${path}${PDI}`);
	}
	return out;
}

/**
 * Recursively transform a loaded messages tree, isolating `@{var}` in every
 * string leaf. Returns a NEW value; never mutates the imported module object.
 */
export function isolateAtHandles<T>(node: T, opts: { literals?: boolean } = {}): T {
	if (typeof node === 'string') return isolateHandleString(node, opts) as unknown as T;
	if (Array.isArray(node)) return node.map((v) => isolateAtHandles(v, opts)) as unknown as T;
	if (node !== null && typeof node === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
			out[k] = isolateAtHandles(v, opts);
		}
		return out as unknown as T;
	}
	return node;
}
