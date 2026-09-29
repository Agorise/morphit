/**
 * set-treasury-btc-xpub — one-time laptop step (v1.20.0, MK-H2).
 *
 * Writes the treasury BTC wallet's ACCOUNT extended PUBLIC key into
 * CANONICAL_TREASURY.btcXpub (apps/indexer/src/config/canonicalTreasury.ts),
 * from where every later release op pins it (release-build-payload.ts →
 * treasury.btc.xpub). From the first release carrying it, each BTC-fee order
 * gets its own address of this key instead of paying the shared address.
 *
 *   npx tsx apps/indexer/scripts/set-treasury-btc-xpub.ts <xpub-or-zpub>
 *
 * Run on the LAPTOP, in the repo root. It refuses a private key (xprv/zprv…),
 * a testnet key, a nested-segwit or multisig key and anything that is not the
 * wallet's account key (m/84'/0'/0'), and changes nothing in that case. On
 * success it prints receive addresses #0, #1, #2: they MUST be the first three
 * lines of the wallet's Addresses tab — if they are not, the key came from the
 * wrong wallet; run `git checkout apps/indexer/src/config/canonicalTreasury.ts`
 * and start again.
 *
 * `--file <path>` edits another copy of canonicalTreasury.ts (tests).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTreasuryXpubInput } from '../src/lib/treasuryXpubInput.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINE_RE = /^(\s*btcXpub:\s*)'[^'\n]*'(,?\s*)$/m;

function main(): number {
	const args = process.argv.slice(2);
	const fileIdx = args.indexOf('--file');
	const file =
		fileIdx >= 0 && args[fileIdx + 1] !== undefined
			? resolve(args[fileIdx + 1]!)
			: resolve(HERE, '../src/config/canonicalTreasury.ts');
	const key = args.filter((_, i) => i !== fileIdx && i !== fileIdx + 1)[0] ?? '';

	const check = checkTreasuryXpubInput(key);
	if (!check.ok) {
		// Never echo the input back: it may be a private key.
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
		process.stderr.write(`\n✗ No "btcXpub: '…'" line found in ${file} — nothing changed.\n`);
		return 1;
	}
	writeFileSync(file, src.replace(LINE_RE, `$1'${check.xpub}'$2`));
	// Verify by reading back what is actually on disk.
	if (!readFileSync(file, 'utf8').includes(`btcXpub: '${check.xpub}'`)) {
		process.stderr.write(`\n✗ The file did not take the change — check ${file} by hand.\n`);
		return 1;
	}

	const out = (s: string) => process.stdout.write(`${s}\n`);
	out('');
	out('✓ Treasury BTC key saved (public key, safe to commit).');
	out(`  file   : ${file}`);
	out(`  key id : ${check.keyId}`);
	out('');
	out('NOW CHECK — these must be the first three RECEIVE addresses on the');
	out("wallet's Addresses tab (Sparrow: Addresses → Receive Addresses, rows 0, 1, 2):");
	check.receive.forEach((a, i) => out(`  #${i}  ${a}`));
	if (!key.trim().startsWith('zpub')) {
		out('');
		out('  (You pasted an "xpub". It does not say which wallet type it came from,');
		out('   so the comparison above is the proof. Right-click → "Copy zpub" in');
		out('   Sparrow gives a key that can only come from a native segwit wallet.)');
	}
	out('');
	out('If they match: commit this file; the next release op pins the key.');
	out('If they do NOT match: git checkout apps/indexer/src/config/canonicalTreasury.ts');
	out('and copy the key again from the right wallet.');
	out('');
	return 0;
}

process.exit(main());
