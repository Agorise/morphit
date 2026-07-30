/**
 * Smoke: the smoke RUNNERS must extract each smoke's scenario count with a
 * sed anchored at the line start (`^✓ all N`), NOT a greedy `.*all `.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-07-30 a triple-pulse CI run failed with:
 *     Total: 16127 scenarios passed, 2 runners failed
 * The two "failures" were assemble-install-smoke and local-install-smoke,
 * each reported as "passed runner but emitted no canonical '^✓ all N …' line".
 * Both printed the line perfectly — the RUNNER mis-parsed it. The count sed was
 *     a greedy sed matching ".*all " then the digit-run then the tail
 * and the greedy `.*all ` matched the "all " inside the smoke NAME
 * ("assemble-INSTALL ", "local-INSTALL " — "install" ends in "all", followed by
 * a space) instead of "all 19", so `\([0-9]*\)` captured empty → the runner saw
 * an empty count → "no canonical line". It was misdiagnosed for a long time as
 * an "overlay-fs read-timing artifact"; it is nothing of the sort — it is
 * deterministic and reproduces everywhere. The fix anchors the sed at `^✓ all `
 * (grep already guarantees the line starts there), so it reads the FIRST count.
 *
 * This smoke guards both `scripts/run-smokes.sh` and `scripts/run-smokes-chunk.sh`
 * structurally (they must use the anchored pattern and must NOT reintroduce the
 * greedy one) and behaviourally (the real sed, run on tricky lines, must extract
 * the right number). Any smoke whose name contains a word ending in "all" (like
 * "install", "wall", "small", "ball") followed by the trailing " checks/scenarios
 * passed" would have silently regressed the tally; this locks that door.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

let checks = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
	checks++;
	if (ok) {
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.log(`  ✗ ${label}`);
	}
}

// The exact substrings as they appear in the shell scripts.
const ANCHORED = 's/^✓ all \\([0-9]*\\).*/\\1/';
const GREEDY = 's/.*all \\([0-9]*\\)';

console.log('── smoke-runner count-extraction (2026-07-30 install-name sed bug) ──');

for (const rel of ['scripts/run-smokes.sh', 'scripts/run-smokes-chunk.sh']) {
	const src = readFileSync(join(REPO, rel), 'utf8');
	check(`${rel}: uses the anchored count sed (^✓ all N)`, src.includes(ANCHORED));
	check(`${rel}: does NOT use the greedy count sed (.*all )`, !src.includes(GREEDY));
}

// Behavioural: run the REAL anchored sed on lines that tripped the greedy one,
// plus normal lines. Use a sed script file + input file to sidestep all shell
// quoting of the multi-byte ✓ and the backslashes.
const dir = mkdtempSync(join(tmpdir(), 'morphit-sed-'));
const sedFile = join(dir, 'extract.sed');
const lineFile = join(dir, 'line.txt');
writeFileSync(sedFile, 's/^✓ all \\([0-9]*\\).*/\\1/\n');

function extract(line: string): string {
	writeFileSync(lineFile, line + '\n');
	return execSync(`sed -f "${sedFile}" < "${lineFile}"`, { encoding: 'utf8' }).trim();
}

check('extracts 19 from an assemble-install line (the CI failure)', extract('✓ all 19 assemble-install checks passed') === '19');
check('extracts 12 from a local-install line (the CI failure)', extract('✓ all 12 local-install checks passed') === '12');
check('extracts 8 from a price-primary-fallback line', extract('✓ all 8 price-primary-fallback scenarios passed') === '8');
check('extracts 140 from a normal multi-word line', extract('✓ all 140 ansible-env-var-consumer checks passed') === '140');
check('extracts 1668 from a large count', extract('✓ all 1668 whatever scenarios passed') === '1668');
check('extracts a count when a later word also ends in "all " (wall)', extract('✓ all 7 draw-the-wall checks passed') === '7');

// Document the regression: the OLD greedy pattern captured EMPTY on the install
// line. This asserts the bug was real (and would return if the anchor is lost).
const greedyFile = join(dir, 'greedy.sed');
writeFileSync(greedyFile, 's/.*all \\([0-9]*\\).*/\\1/\n');
function extractGreedy(line: string): string {
	writeFileSync(lineFile, line + '\n');
	return execSync(`sed -f "${greedyFile}" < "${lineFile}"`, { encoding: 'utf8' }).trim();
}
check('regression documented: the greedy sed DID capture empty on install', extractGreedy('✓ all 19 assemble-install checks passed') === '');

if (failed > 0) {
	console.log(`\n✗ ${failed} of ${checks} smoke-runner-count-extraction checks FAILED`);
	process.exit(1);
}
console.log(`\n✓ all ${checks} smoke-runner-count-extraction checks passed`);
