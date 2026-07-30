/**
 * Strip TypeScript/JavaScript comments from source text.
 *
 * Shared helper extracted in cp153 from two duplicated
 * implementations:
 *
 *   - cp142 `scripts/spawn-dist-prebuild-coverage-smoke.ts`
 *   - cp149 `scripts/mcp-server-read-only-invariant-smoke.ts`
 *
 * Both smokes scan TS/JS source for code patterns (raw `fetch(`
 * calls, `ensureBuilt()` guards, etc.) and need to ignore
 * pattern-matches inside comments — otherwise docblocks and
 * "TODO: switch to X" comments would false-positive.
 *
 * (NOTE: this docblock deliberately avoids writing the literal
 *  block-comment open and close markers inside backticks or
 *  inline — those would prematurely close this very docblock.
 *  We describe them as "OPEN" and "CLOSE" or use plain prose
 *  references below.)
 *
 * Two-pass regex strategy:
 *
 *   1. Strip block comments (CLOSE-marker lazy-matched so we
 *      stop at the first CLOSE — JS doesn't allow nesting
 *      anyway).
 *   2. Strip line comments (until end of line).
 *
 * The block-comment pass MUST come first.  If we stripped
 * line comments first, an inline OPEN/CLOSE pair following a
 * line-comment slash-slash would have its CLOSE marker eaten,
 * leaving an orphan to confuse the block-strip pass.
 *
 * KNOWN LIMITATIONS (acceptable for the smoke use case):
 *
 *   - String literals containing slash-slash or slash-star get
 *     their content stripped.  e.g. `const url = 'https://x.com';`
 *     becomes `const url = 'https:`.  This is fine because no
 *     caller uses this helper to PARSE syntax; they regex-match
 *     known patterns in the stripped text.  Stripping inside
 *     strings can only cause false NEGATIVES (a pattern
 *     accidentally hidden), never false POSITIVES.  Callers
 *     that care should switch to a tokenizer (not provided
 *     here).
 *
 *   - Regex literals containing slash-star tokens are not
 *     specially handled — they could trigger block-comment
 *     stripping.  Vanishingly rare in our codebase; the few
 *     cases use the constructor form `new RegExp('...')`.
 *
 * For higher-correctness scanning (e.g. AST-aware diffing),
 * use a proper parser like `typescript` or `@babel/parser`.
 * For repo-wide pattern checks where false negatives are
 * tolerable, this helper is sufficient.
 *
 * The helper is intentionally a pure function with no I/O.
 * Callers read files themselves and pass text strings.
 */

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;

export function stripComments(source: string): string {
	return source.replace(BLOCK_COMMENT_RE, '').replace(LINE_COMMENT_RE, '');
}
