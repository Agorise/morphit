/**
 * cors-star-smoke — the public read-only API must send
 * `Access-Control-Allow-Origin: *`, not a per-instance allowlist.
 *
 * v1.16.12 — a per-instance allowlist can never scale to the whole federation,
 * so the /compare orderbook diff (which fetches a PEER's /v1/orders from the
 * browser) failed cross-origin with a NetworkError. The API is read-only with no
 * credentials, so `*` is safe. This pins it so it can't silently regress.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(resolve(root, 'indexer/src/api/middleware/cors.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  ✗ ${name}`);
	}
}

check(
	"cors emits Access-Control-Allow-Origin: * (public read API, no credentials)",
	/access-control-allow-origin['"],\s*['"]\*['"]/.test(src)
);
check(
	'cors does NOT gate the allow-origin header on a per-origin allowlist (that broke cross-instance compare)',
	!/allowSet\.has\(origin\)/.test(src)
);
check('cors never sets allow-credentials (so * is valid + leaks nothing)', !/header\(['"]access-control-allow-credentials/i.test(src));
check('cors stays read-only (GET, OPTIONS only)', /GET,\s*OPTIONS/.test(src) && !/POST/.test(src));

if (fail === 0) {
	console.log(`✓ all ${pass} cors-star checks passed`);
} else {
	console.error(`✗ ${fail} of ${pass + fail} cors-star checks FAILED`);
	process.exit(1);
}
