/**
 * tag-reserved-parity-smoke (L3 follow-through).
 *
 * The indexer refuses, on first registration, an operator tag that looks like
 * a reserved name (`tagImpersonatesReserved`) unless the signer owns it. The
 * web form (run-a-node) and `morphit-ops register` must refuse the same tags,
 * or an operator broadcasts a registration the network silently ignores — the
 * gap the deep audit's fixer noted. The web has its own copy of the confusables
 * tables (packages/indexer-client is types-only), so this RUNS both copies over
 * one corpus and requires identical verdicts. The web form's validator itself
 * is driven in src/lib/blurt/ops/operatorRegisterTag.test.ts.
 */
import { tagImpersonatesReserved as idx } from '../../indexer/src/indexer/confusables.ts';
import { tagImpersonatesReserved as web } from '../src/lib/crypto/confusables.ts';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const CORPUS = [
	'morphit',
	'm0rphit',
	'rnorphit',
	'morphit-io',
	'morphit.io',
	'morphit_io',
	'morphitlat',
	'morphitlat-relay',
	'mymorphit',
	'agorise',
	'ag0rise-node',
	'kencode-node',
	'vigilante-trading',
	'example-node',
	'time-foundation'
];

const differ = CORPUS.filter((t) => idx(t) !== web(t));
check(
	'the web and indexer copies give the same verdict on every tag in the corpus',
	differ.length === 0,
	differ.join(', ')
);
check(
	'look-alikes are caught by both',
	['m0rphit', 'rnorphit', 'morphit-io'].every((t) => idx(t) && web(t))
);
check(
	'ordinary and deliberately allowed tags pass both',
	['example-node', 'mymorphit', 'morphitlat-relay'].every((t) => !idx(t) && !web(t))
);

console.log('');
if (fail > 0) {
	console.log(`✗ ${fail} of ${pass + fail} tag-reserved parity checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${pass} tag-reserved parity checks passed`);
