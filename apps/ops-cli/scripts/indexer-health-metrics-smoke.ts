#!/usr/bin/env tsx
/**
 * indexer-health-metrics — cp683 + AIDE health-view.
 *
 * cp683: the indexer computes the /v1/health system block (cpu_pct, mem) from
 * /proc/stat + /proc/meminfo. Its systemd unit MUST NOT set ProcSubset=pid,
 * which hides those non-process files (cpu_pct went permanently null, mem fell
 * back to a coarse source). This guards the invariant so re-hardening can't
 * silently break the metrics again.
 *
 * Also checks the ops-cli Node-health view exposes the AIDE baseline state, so a
 * background AIDE failure is visible via `morphit-ops` even without Matrix.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAideBaseline, checkTlsCert, readMatrixMxid } from '../src/commands/health.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
	if (c) {
		console.log(`  ✓ ${n}`);
		pass++;
	} else {
		console.log(`  ✗ ${n}${d ? `: ${d}` : ''}`);
		fail++;
	}
};

console.log('\n── indexer-health-metrics (cp683 + AIDE view) ─────────\n');

const indexerUnit = read('ops/systemd/morphit-indexer.service');
check(
	'indexer unit does NOT set ProcSubset=pid (would hide /proc/stat + /proc/meminfo)',
	!/^\s*ProcSubset=pid/m.test(indexerUnit),
	'cpu_pct goes permanently null and memory degrades under ProcSubset=pid'
);
check(
	'indexer unit sets ProcSubset=all (system metrics need the /proc files)',
	/^\s*ProcSubset=all/m.test(indexerUnit)
);
check(
	'indexer keeps ProtectProc=invisible (the meaningful per-process protection)',
	/^\s*ProtectProc=invisible/m.test(indexerUnit),
	'relaxing ProcSubset must not drop process hiding'
);

const health = read('apps/ops-cli/src/commands/health.ts');
check(
	'the operational-health collector reads /proc/stat + /proc/meminfo',
	/\/proc\/meminfo/.test(read('apps/indexer/src/api/operationalHealth.ts')) &&
		/cpus\(\)/.test(read('apps/indexer/src/api/operationalHealth.ts'))
);
check(
	'Node-health view reports an AIDE baseline state',
	/aide_baseline/.test(health) && /checkAideBaseline/.test(health)
);
check(
	'checkAideBaseline returns a valid state (built/building/failed/not-configured)',
	['built', 'building', 'failed', 'not-configured'].includes(checkAideBaseline().state)
);

// cp684 — Node-health verifies TLS, matrix alert address, and parallel sync.
check(
	'checkTlsCert reports HTTPS cert status (valid/expiring/expired/not-found)',
	['valid', 'expiring', 'expired', 'not-found'].includes(checkTlsCert('/nonexistent-dir').state)
);
check('readMatrixMxid reads the configured alert MXID (null when unset)', readMatrixMxid('/nope') === null);
check(
	'Node-health JSON exposes tls_cert + matrix_alert_mxid',
	/tls_cert:/.test(health) && /matrix_alert_mxid:/.test(health)
);
check(
	'Node-health shows the parallel catch-up line (fast sync from N nodes)',
	/catching up in parallel from/.test(health)
);
check(
	'Node-health confirms the matrix-bot alert address, not just the service',
	/alerts → \$\{matrixMxid\}/.test(health) || /alerts → /.test(health)
);
{
	const playbook = read('ops/ansible/playbook.yml');
	check(
		'post-install summary points to the one-command verification (option 13)',
		/morphit-ops\s+→\s+option 13/.test(playbook) || /option 13 \(Node health\)/.test(playbook)
	);
}

console.log(
	`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} indexer-health-metrics checks passed` : '✗ FAILED'}`
);
process.exit(fail === 0 ? 0 : 1);
