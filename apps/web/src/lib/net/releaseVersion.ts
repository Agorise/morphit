/**
 * Order release versions (the payload's `version`, which @morphit signs).
 *
 * Semantic-version precedence: MAJOR.MINOR.PATCH numerically; a pre-release
 * (`1.2.0-beta.3`) comes before its release; pre-release identifiers compare
 * numerically when both are numbers, else as text, a shorter list first when
 * all shared ones are equal; build metadata (`+…`) is ignored. A version that
 * is not of that shape sorts before every valid one.
 */

interface Parsed {
	readonly core: readonly [number, number, number];
	readonly pre: readonly string[];
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v: string): Parsed | null {
	const m = VERSION_RE.exec(v);
	if (m === null) return null;
	return {
		core: [Number(m[1]), Number(m[2]), Number(m[3])],
		pre: m[4] === undefined ? [] : m[4].split('.')
	};
}

function compareIdent(a: string, b: string): number {
	const an = /^\d+$/.test(a);
	const bn = /^\d+$/.test(b);
	if (an && bn) return Math.sign(Number(a) - Number(b));
	if (an !== bn) return an ? -1 : 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** > 0 when `a` is the newer version, < 0 when `b` is, 0 when equal. */
export function compareReleaseVersions(a: string, b: string): number {
	const pa = parse(a);
	const pb = parse(b);
	if (pa === null || pb === null) return pa === null ? (pb === null ? 0 : -1) : 1;
	for (let i = 0; i < 3; i++) {
		const d = pa.core[i]! - pb.core[i]!;
		if (d !== 0) return Math.sign(d);
	}
	if (pa.pre.length === 0 || pb.pre.length === 0) {
		return pa.pre.length === pb.pre.length ? 0 : pa.pre.length === 0 ? 1 : -1;
	}
	for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
		const d = compareIdent(pa.pre[i]!, pb.pre[i]!);
		if (d !== 0) return d;
	}
	return Math.sign(pa.pre.length - pb.pre.length);
}
