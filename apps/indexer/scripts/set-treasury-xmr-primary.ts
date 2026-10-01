/**
 * set-treasury-xmr-primary — one-time laptop step (v1.20.0, MK-H2).
 *
 * Writes the treasury Monero wallet's PRIMARY (main, `4…`) address into
 * CANONICAL_TREASURY.xmrPrimary (apps/indexer/src/config/canonicalTreasury.ts),
 * from where every later release op pins it (release-build-payload.ts →
 * treasury.xmr.primary_address). From the first release carrying it, each
 * XMR-fee order must pay the integrated address of this address that carries
 * the order's own payment ID.
 *
 *   npx tsx apps/indexer/scripts/set-treasury-xmr-primary.ts <4…address>
 *
 * Run on the LAPTOP, in the repo root, and only after the pre-pin checklist
 * (docs/OPERATIONS.md §40.13) passed. It refuses a subaddress (`8…`), an
 * integrated address, a testnet/stagenet address, a typo and an address that
 * holds no valid keys, and changes nothing in that case. On success it prints
 * a sample payment ID and the integrated address Morphit makes from it: the
 * treasury wallet must make the SAME one (`integrated_address <payment id>` in
 * monero-wallet-cli). If it does not, the address came from the wrong wallet:
 * run `git checkout apps/indexer/src/config/canonicalTreasury.ts` and start
 * again.
 *
 * `--file <path>` edits another copy of canonicalTreasury.ts (tests).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTreasuryXmrPrimaryInput } from '../src/lib/treasuryXmrPrimaryInput.ts';

import { splitTreasuryArgs } from '../src/lib/treasuryCliArgs.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINE_RE = /^(\s*xmrPrimary:\s*)'[^'\n]*'(,?\s*)$/m;

function main(): number {
	const parsed = splitTreasuryArgs(process.argv.slice(2));
	const file =
		parsed.file !== null
			? resolve(parsed.file)
			: resolve(HERE, '../src/config/canonicalTreasury.ts');
	const input = parsed.value;

	const check = checkTreasuryXmrPrimaryInput(input);
	if (!check.ok) {
		process.stderr.write(`\n✗ Not saved. ${check.message}\n\n`);
		return 1;
	}

	let src: string;
	try {
		src = readFileSync(file, 'utf8');
	} catch (e) {
		process.stderr.write(
			`\n✗ Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}\n`
		);
		return 1;
	}
	if (!LINE_RE.test(src)) {
		process.stderr.write(`\n✗ No "xmrPrimary: '…'" line found in ${file} — nothing changed.\n`);
		return 1;
	}
	writeFileSync(file, src.replace(LINE_RE, `$1'${check.address}'$2`));
	if (!readFileSync(file, 'utf8').includes(`xmrPrimary: '${check.address}'`)) {
		process.stderr.write(`\n✗ The file did not take the change — check ${file} by hand.\n`);
		return 1;
	}

	const out = (s: string) => process.stdout.write(`${s}\n`);
	out('');
	out('✓ Treasury Monero main address saved (public, safe to commit).');
	out(`  file : ${file}`);
	out('');
	out('NOW CHECK — in the treasury wallet (monero-wallet-cli), type:');
	out('');
	out(`  integrated_address ${check.sample.paymentId}`);
	out('');
	out('It must print exactly this address:');
	out('');
	out(`  ${check.sample.integrated}`);
	out('');
	out('If it matches: commit this file; the next release op pins the address.');
	out('If it does NOT match: git checkout apps/indexer/src/config/canonicalTreasury.ts');
	out('and copy the main address again from the treasury wallet.');
	out('');
	return 0;
}

process.exit(main());
