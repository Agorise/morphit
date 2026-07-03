/**
 * jsonHighlight — turn a pretty-printed JSON string into highlighted HTML for
 * the explorer's raw-op display.
 *
 * SECURITY (this is the whole point of the module existing): the JSON shown in
 * the explorer is chain-derived and attacker-controlled — an op's string
 * VALUES can contain anything, including `<script>`, `</span>`, quotes, and
 * ampersands. This function therefore ESCAPES every HTML-special character in
 * the content BEFORE emitting it, and the only markup it ever produces is
 * `<span class="json-…">` with STATIC class names. There is no code path that
 * copies attacker bytes into a tag or an attribute, so adversarial JSON can
 * never inject executable HTML. The escaped-content-plus-static-span output is
 * safe to render with `{@html}`. The companion smoke
 * (explorer-json-highlight-safety-smoke) pins this guarantee.
 *
 * Input is assumed to be `JSON.stringify(value, null, 2)` output (well-formed);
 * anything the tokenizer doesn't recognize is passed through escaped, so even
 * malformed input stays safe (just less colorful).
 */

/** Escape the three characters that could open a tag or entity in element
 *  text content. (`"` and `'` are only special inside attributes, and this
 *  output only ever lands in text nodes, so they're left as-is.) */
function escapeHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

// One token at a time: a quoted string (with an optional trailing `:` that
// marks it as an object key), a literal, a number, structural punctuation, or
// a run of whitespace.
const TOKEN =
	/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])|(\s+)/g;

export function highlightJsonToHtml(json: string): string {
	// Fresh lastIndex per call (module-level regex with the `g` flag is
	// stateful).
	TOKEN.lastIndex = 0;
	let out = '';
	let cursor = 0;
	let m: RegExpExecArray | null;

	while ((m = TOKEN.exec(json)) !== null) {
		// Anything the tokenizer skipped over is emitted escaped (defensive;
		// shouldn't happen for well-formed JSON).
		if (m.index > cursor) out += escapeHtml(json.slice(cursor, m.index));
		cursor = TOKEN.lastIndex;

		if (m[1] !== undefined) {
			// A quoted string. m[2] present ⇒ it's followed by a colon ⇒ key.
			const isKey = m[2] !== undefined;
			out += `<span class="${isKey ? 'json-key' : 'json-string'}">${escapeHtml(m[1])}</span>`;
			if (isKey) out += escapeHtml(m[2] as string); // the ":" — plain
		} else if (m[3] !== undefined) {
			out += `<span class="${m[3] === 'null' ? 'json-null' : 'json-bool'}">${escapeHtml(m[3])}</span>`;
		} else if (m[4] !== undefined) {
			out += `<span class="json-num">${escapeHtml(m[4])}</span>`;
		} else if (m[5] !== undefined) {
			out += escapeHtml(m[5]); // { } [ ] , — plain punctuation
		} else if (m[6] !== undefined) {
			out += m[6]; // whitespace only — no HTML-special chars possible
		}
	}
	if (cursor < json.length) out += escapeHtml(json.slice(cursor));
	return out;
}
