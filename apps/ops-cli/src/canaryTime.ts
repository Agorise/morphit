/**
 * Morphit ops-cli — canary timestamp parsing.
 *
 * The canary's `Generated:` / `Valid through:` lines carry Ken's sitewide
 * format, "22 July, 2026 @ 23:45:18 UTC". Older canaries — including any signed
 * before 2026-07-08 — carry a Zulu ISO stamp, "2026-07-22T23:45:18Z". Both must
 * parse, or `morphit-ops` health would report a perfectly good canary as
 * `unparsable` and an operator would go hunting for a problem that isn't there.
 *
 * Why not just `new Date(str)`? V8 happens to parse the human form, and even
 * honours the trailing "UTC". But ECMA-262 leaves the parsing of anything that
 * isn't an ISO 8601 string **implementation-defined** — a different runtime, or
 * a future V8, may return NaN or silently interpret it as LOCAL time. The
 * canary's staleness window is a security signal: a silent 6-hour skew, or an
 * `unparsable` that an operator learns to ignore, both erode it. So we parse
 * explicitly.
 *
 * This mirrors `parseCanaryTimestamp` in `scripts/canary/verify.ts`. The two
 * live in different module systems (root is CommonJS, ops-cli is ESM), so they
 * are kept in lockstep by `canary-timestamp-parity-smoke` rather than by an
 * import.
 */

const MONTHS = [
	'january',
	'february',
	'march',
	'april',
	'may',
	'june',
	'july',
	'august',
	'september',
	'october',
	'november',
	'december'
];

const HUMAN = /^(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})\s*@\s*(\d{2}):(\d{2}):(\d{2})\s*UTC$/;

/**
 * Parse a canary timestamp into epoch milliseconds, or NaN when it matches
 * neither the human format nor an unambiguous ISO 8601 instant.
 */
export function parseCanaryTimestamp(raw: string): number {
	const s = raw.trim();
	const m = HUMAN.exec(s);
	if (m) {
		const [, d, monthName, y, hh, mm, ss] = m;
		const mi = MONTHS.indexOf(monthName!.toLowerCase());
		if (mi === -1) return NaN;
		return Date.UTC(Number(y), mi, Number(d), Number(hh), Number(mm), Number(ss));
	}
	// Legacy Zulu ISO. Require the explicit Z so a bare "2026-07-22 23:45:18"
	// can't be silently read as local time.
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) return Date.parse(s);
	return NaN;
}
