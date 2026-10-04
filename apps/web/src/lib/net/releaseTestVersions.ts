/**
 * Versions for the release tests, taken from the same place the code takes the
 * running version (`__MORPHIT_VERSION__`, baked in from apps/web/package.json),
 * with fixture releases built relative to it — so a version bump never turns a
 * "current" fixture into an "older than this build" one.
 */
export const RUNNING_VERSION: string =
	typeof __MORPHIT_VERSION__ === 'string' ? __MORPHIT_VERSION__ : '0.0.0';

function parts(v: string): [number, number, number] {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
	if (m === null) throw new Error(`not a release version: ${v}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** A release version just below `v` (the previous patch, minor or major). */
export function olderThan(v: string = RUNNING_VERSION): string {
	const [a, b, c] = parts(v);
	if (c > 0) return `${a}.${b}.${c - 1}`;
	if (b > 0) return `${a}.${b - 1}.0`;
	if (a > 0) return `${a - 1}.0.0`;
	throw new Error(`nothing is older than ${v}`);
}

/** A release version above `v` (the next major). */
export function newerThan(v: string = RUNNING_VERSION): string {
	return `${parts(v)[0] + 1}.0.0`;
}
