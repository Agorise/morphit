/**
 * instances-directory-fast-load-smoke — the directory page must paint from the
 * fast one-shot REST query FIRST, then attach the live SSE stream on top.
 *
 * v1.16.12 — a stream-first load left the page stuck on "Loading directory…" for
 * minutes when the SSE stream was slow to first-flush (WAF/proxy buffering): a
 * buffered-but-connected stream never fires `error`, so the REST fallback never
 * kicked in (timeapp). REST-first makes the cards appear instantly and the
 * stream just layers live updates over the idempotent snapshot. Pin it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const page = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', '[lang]', 'instances', '+page.svelte'),
	'utf8'
);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  ✗ ${name}`);
	}
}

// Isolate the onMount body.
const onMountMatch = /onMount\(\(\)\s*=>\s*\{([\s\S]*?)\}\);/.exec(page);
const onMountBody = onMountMatch ? onMountMatch[1] : '';

check('onMount exists', onMountBody !== '');
check('onMount kicks off the one-shot REST load (fallbackLoad) for instant paint', /fallbackLoad\(\)/.test(onMountBody));
check('onMount still attaches the live stream (startStream)', /startStream\(\)/.test(onMountBody));
check(
	'REST paint is ordered BEFORE the stream (fallbackLoad precedes startStream in onMount)',
	onMountBody.indexOf('fallbackLoad(') !== -1 &&
		onMountBody.indexOf('startStream(') !== -1 &&
		onMountBody.indexOf('fallbackLoad(') < onMountBody.indexOf('startStream(')
);
check('applySnapshot stays idempotent (rebuilds the map by origin) so REST+stream can both apply', /new Map<string, InstanceDirectoryEntry>\(\)/.test(page) && /\.set\(e\.origin, e\)/.test(page));
check('fallbackLoad uses the REST getInstances query (not the stream)', /async function fallbackLoad[\s\S]*?getInstances\(\{\}\)/.test(page));

if (fail === 0) {
	console.log(`✓ all ${pass} instances-directory-fast-load checks passed`);
} else {
	console.error(`✗ ${fail} of ${pass + fail} instances-directory-fast-load checks FAILED`);
	process.exit(1);
}
