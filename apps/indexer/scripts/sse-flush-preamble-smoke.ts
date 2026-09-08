/**
 * sse-flush-preamble-smoke — every SSE stream must send a flush-forcing padding
 * comment before its first real event.
 *
 * v1.16.12 — a compressing/buffering proxy (BunkerWeb gzip/brotli) holds an SSE
 * stream's first bytes until its buffer fills, ignoring no-transform and
 * X-Accel-Buffering, stalling the stream for minutes (the maintainer/timeapp directory
 * "Loading…"). ~2 KB of leading SSE comment fills+flushes that buffer at once.
 * Pin it on every stream so the mitigation can't quietly drop off one of them.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api');
const streams = ['instancesStream.ts', 'orderbookStream.ts']; // chat streams intentionally EXCLUDED — hands-off fast-chat (the maintainer)

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  ✗ ${name}`);
	}
}

for (const s of streams) {
	const src = readFileSync(join(apiDir, s), 'utf8');
	// The preamble pushes ~2 KB of spaces as an SSE comment (`:`-prefixed), either
	// as a template literal or string concat.
	const hasPad = /repeat\(2048\)/.test(src);
	check(`${s}: pushes a ~2 KB flush-forcing preamble`, hasPad);
	check(`${s}: keeps the anti-buffering headers (no-transform + X-Accel-Buffering)`, /no-transform/.test(src) && /X-Accel-Buffering/.test(src));
	// The preamble must precede the first real sseEvent push.
	const padAt = src.search(/repeat\(2048\)/);
	const evtAt = src.search(/safePush\(\s*sseEvent\(/);
	check(`${s}: preamble comes BEFORE the first sseEvent push`, hasPad && padAt >= 0 && evtAt >= 0 && padAt < evtAt);
}

if (fail === 0) {
	console.log(`✓ all ${pass} sse-flush-preamble checks passed (2 streams: directory + orderbook)`);
} else {
	console.error(`✗ ${fail} of ${pass + fail} sse-flush-preamble checks FAILED`);
	process.exit(1);
}
