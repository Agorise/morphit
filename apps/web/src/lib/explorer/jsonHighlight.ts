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

/** Render a JSON string VALUE token (quotes included) with the whitespace
 *  escapes \n, \r, \t shown as REAL line breaks / tabs instead of literal
 *  backslash sequences, so multi-line markdown values — an order's `terms`,
 *  a post `body` — read naturally in the explorer instead of as one long
 *  `...\n\n...` line. Continuation lines hang-indent under the value.
 *
 *  DISPLAY-ONLY: the wire value is unchanged. This deliberately trades strict
 *  JSON-literal validity in the *rendered* view for readability — the point
 *  is a nicer view of the same bytes, matching the module's existing
 *  expandNestedJsonStrings posture.
 *
 *  SAFETY: every literal character is still passed through escapeHtml (the
 *  only non-escaped output is real whitespace we insert ourselves and the
 *  surrounding quotes), so the "no injectable markup" guarantee is preserved
 *  — a `<script>` or `</span>` inside the string stays inert. Non-whitespace
 *  escapes (\" \\ \/ \uXXXX \b \f) are left as their literal backslash form. */
function renderMultilineStringValue(token: string, indent: string): string {
	const inner = token.slice(1, -1); // drop the surrounding quotes
	const cont = '\n' + indent + '  '; // real break + hang indent under the value
	let html = '"';
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]!;
		if (ch === '\\' && i + 1 < inner.length) {
			const next = inner[i + 1]!;
			if (next === 'n') {
				html += cont;
				i++;
				continue;
			}
			if (next === 't') {
				html += '\t';
				i++;
				continue;
			}
			if (next === 'r') {
				// Fold a CR into the LF that follows it (CRLF → one break);
				// a lone CR is simply dropped.
				i++;
				continue;
			}
			// Any other escape (\" \\ \/ \uXXXX \b \f) stays in literal form.
			html += escapeHtml(ch + next);
			i++;
			continue;
		}
		html += escapeHtml(ch);
	}
	return html + '"';
}

// One token at a time: a quoted string (with an optional trailing `:` that
// marks it as an object key), a literal, a number, structural punctuation, or
// a run of whitespace.
const TOKEN =
	/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])|(\s+)/g;

/**
 * Recursively expand JSON-in-strings for the explorer's raw-op view. Chain ops
 * commonly carry a field (e.g. a `custom_json` op's `json`, or a memo) whose
 * value is itself a JSON document encoded as a STRING —
 * `"{\"v\":1,\"peer\":\"kentest2\",\"ts\":1783121335}"`. Left as-is,
 * `JSON.stringify(value, null, 2)` renders that as one long escaped line;
 * parsing it first lets the pretty-printer indent it like any other nested
 * object, so the keys line up and read cleanly.
 *
 * DISPLAY-ONLY: the raw wire value is the string; this is just a nicer view of
 * the same data. Only strings that parse to an OBJECT or ARRAY are expanded —
 * a plain memo, a numeric string like "42", or a bare word is never silently
 * retyped. Parsing is wrapped in try/catch (non-JSON stays as-is) and recursion
 * is depth-bounded against pathological / deeply-nested input.
 *
 * SAFETY: the result is still fed through `JSON.stringify` + `highlightJsonToHtml`,
 * which escapes every HTML-special character, so expanding attacker-controlled
 * JSON introduces no injection surface — it only changes the shape, not the
 * escaping.
 */
export function expandNestedJsonStrings(value: unknown, depth = 0): unknown {
	if (depth > 8) return value;
	if (typeof value === 'string') {
		const t = value.trim();
		// Cheap pre-check: only attempt a parse if it even looks like an
		// object/array, so ordinary strings aren't run through JSON.parse.
		if (t.length >= 2 && (t[0] === '{' || t[0] === '[')) {
			try {
				const parsed: unknown = JSON.parse(t);
				if (parsed !== null && typeof parsed === 'object') {
					return expandNestedJsonStrings(parsed, depth + 1);
				}
			} catch {
				// Not JSON after all — leave the original string untouched.
			}
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => expandNestedJsonStrings(v, depth + 1));
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = expandNestedJsonStrings(v, depth + 1);
		}
		return out;
	}
	return value;
}

export function highlightJsonToHtml(json: string): string {
	// Fresh lastIndex per call (module-level regex with the `g` flag is
	// stateful).
	TOKEN.lastIndex = 0;
	let out = '';
	let cursor = 0;
	// Indentation of the current line, tracked from whitespace tokens so a
	// multi-line string value can hang-indent its continuation lines.
	let currentIndent = '';
	let m: RegExpExecArray | null;

	while ((m = TOKEN.exec(json)) !== null) {
		// Anything the tokenizer skipped over is emitted escaped (defensive;
		// shouldn't happen for well-formed JSON).
		if (m.index > cursor) out += escapeHtml(json.slice(cursor, m.index));
		cursor = TOKEN.lastIndex;

		if (m[1] !== undefined) {
			// A quoted string. m[2] present ⇒ it's followed by a colon ⇒ key.
			const isKey = m[2] !== undefined;
			if (isKey) {
				out += `<span class="json-key">${escapeHtml(m[1])}</span>`;
				out += escapeHtml(m[2] as string); // the ":" — plain
			} else {
				// Value strings render \n/\t as real breaks/tabs so multi-line
				// markdown (an order's terms, a post body) reads cleanly.
				out += `<span class="json-string">${renderMultilineStringValue(m[1], currentIndent)}</span>`;
			}
		} else if (m[3] !== undefined) {
			out += `<span class="${m[3] === 'null' ? 'json-null' : 'json-bool'}">${escapeHtml(m[3])}</span>`;
		} else if (m[4] !== undefined) {
			out += `<span class="json-num">${escapeHtml(m[4])}</span>`;
		} else if (m[5] !== undefined) {
			out += escapeHtml(m[5]); // { } [ ] , — plain punctuation
		} else if (m[6] !== undefined) {
			out += m[6]; // whitespace only — no HTML-special chars possible
			// Track the current line's indent so a following multi-line
			// string value can hang-indent under itself.
			const lastNl = m[6].lastIndexOf('\n');
			if (lastNl !== -1) currentIndent = m[6].slice(lastNl + 1);
		}
	}
	if (cursor < json.length) out += escapeHtml(json.slice(cursor));
	return out;
}
