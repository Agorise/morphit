/**
 * splitOnPlaceholder — split an i18n string around a paired
 * `{open}…{close}` placeholder so the caller can render the
 * delimited text as a clickable link (or any other inline
 * element) without losing the surrounding sentence.
 *
 * Why a helper instead of {@html} or message-format
 * interpolation:
 *
 *   - {@html} would let any locale string inject arbitrary
 *     HTML.  We don't want that — translators are part of
 *     our trust boundary, but a compromised-CDN locale file
 *     should not be able to inject script tags.
 *   - svelte-i18n's MessageFormat doesn't natively support
 *     embedded HTML elements, only text interpolation.
 *
 * So we keep the locale string as plain text containing a
 * pair of stable tokens (e.g. `{matrix_open}`/`{matrix_close}`)
 * and the component substitutes a real anchor element at
 * render time.  The component code reads:
 *
 *     const [before, linkText, after] = splitOnPlaceholder(
 *         $_('some.key'), '{matrix_open}', '{matrix_close}'
 *     );
 *     {before}<a href="…">{linkText || 'fallback'}</a>{after}
 *
 * Translators can position the placeholder pair anywhere in
 * their sentence; the component doesn't care about word
 * order.
 *
 * Graceful degradation: if a token is missing or out of
 * order, returns `[text, '', '']` so the caller renders
 * plain text.  Better UX than a broken layout when a
 * translator drops a placeholder by mistake — the link
 * silently disappears, the sentence still reads.
 *
 * Constraint on token choice: the open token must not
 * contain the close token as a substring, and vice versa.
 * Otherwise indexOf can find the close inside the open and
 * the math goes wrong.  In practice we use distinct
 * `{x_open}`/`{x_close}` pairs (no shared content), so the
 * constraint holds trivially.
 */
export function splitOnPlaceholder(
	text: string,
	openToken: string,
	closeToken: string
): readonly [string, string, string] {
	const o = text.indexOf(openToken);
	const c = text.indexOf(closeToken);
	if (o < 0 || c < 0 || c <= o) {
		return [text, '', ''];
	}
	return [text.slice(0, o), text.slice(o + openToken.length, c), text.slice(c + closeToken.length)];
}
