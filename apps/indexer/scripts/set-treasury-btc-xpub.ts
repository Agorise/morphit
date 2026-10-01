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
 * wallet's account key (m/84'/0'/0'), and changes nothing in that case.
 *
 * v1.20.2: it also refuses an account that has ever been used. It asks the
 * public explorers about receive #0–#19 (lib/treasuryXpubHistory.ts) and
 * saves only when none of them has any transaction: an address that already
 * received coins would make the order that gets it look paid. Options:
 *   --explorer <Esplora base URL>  ask this explorer instead (repeatable)
 *   --skip-history-check           save without asking (offline laptop; you
 *                                  must be sure the account is brand new)
 * Run it through Tor (`torsocks npx tsx …`) if the laptop's IP should not be
 * seen asking about these addresses.
 *
 * On success it prints receive addresses #0, #1, #2: they MUST be the first
 * three receive addresses of the wallet account — if they are not, the key came
 * from the wrong wallet; run
 * `git checkout apps/indexer/src/config/canonicalTreasury.ts` and start again.
 *
 * `--file <path>` edits another copy of canonicalTreasury.ts (tests).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTreasuryXpubInput } from '../src/lib/treasuryXpubInput.ts';

import { parseTreasuryArgs } from '../src/lib/treasuryCliArgs.ts';
import {
	DEFAULT_HISTORY_EXPLORERS,
	HISTORY_GAP,
	scanXpubHistory
} from '../src/lib/treasuryXpubHistory.ts';
import { deriveBtcFeeAddress } from '@morphit/release-schema';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINE_RE = /^(\s*btcXpub:\s*)'[^'\n]*'(,?\s*)$/m;

async function main(): Promise<number> {
	const parsed = parseTreasuryArgs(
		process.argv.slice(2),
		['file', 'explorer'],
		['skip-history-check']
	);
	if (parsed.unknown.length > 0) {
		process.stderr.write(
			`\n✗ Not saved. Unknown option ${parsed.unknown.join(' ')} (options: --explorer <url>, --skip-history-check).\n\n`
		);
		return 1;
	}
	const fileOpt = parsed.options.file?.[0];
	const file =
		fileOpt !== undefined ? resolve(fileOpt) : resolve(HERE, '../src/config/canonicalTreasury.ts');
	const key = parsed.value;
	const explorers = parsed.options.explorer ?? DEFAULT_HISTORY_EXPLORERS;
	const badExplorer = explorers.find((e) => !/^https?:\/\/[^\s/]+/.test(e));
	if (badExplorer !== undefined) {
		process.stderr.write(
			`\n✗ Not saved. --explorer needs a web address like https://blockstream.info/api (got ${badExplorer}).\n\n`
		);
		return 1;
	}
	const out = (s: string) => process.stdout.write(`${s}\n`);

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
	const showAddresses = (): void => {
		out('NOW CHECK — these must be the first three RECEIVE addresses of the wallet');
		out('account (Sparrow: Addresses → Receive Addresses, rows 0, 1, 2; Mycelium shows');
		out('only the next unused one — on a new account that is #0):');
		check.receive.forEach((a, i) => out(`  #${i}  ${a}`));
	};

	// Already saved (a re-run): nothing to change, and its addresses may by now
	// rightly have been used by orders, so the history check does not apply.
	if (src.includes(`btcXpub: '${check.xpub}'`)) {
		out('');
		out('✓ This key is already saved — nothing changed.');
		out(`  file   : ${file}`);
		out(`  key id : ${check.keyId}`);
		out('');
		showAddresses();
		out('');
		return 0;
	}

	if (parsed.flags.has('skip-history-check')) {
		out('');
		out('! History check SKIPPED (--skip-history-check). Save this key only if the');
		out('  account is brand new and has never received anything.');
	} else {
		out('');
		out(`Checking that this account has never been used (receive #0–#${HISTORY_GAP - 1})…`);
		const scan = await scanXpubHistory((i) => deriveBtcFeeAddress(check.xpub, i), {
			explorers
		});
		if (scan.kind === 'used') {
			const err = (s: string) => process.stderr.write(`${s}\n`);
			err('');
			err('✗ Not saved. This account has already been used:');
			err(
				`  receive #${scan.index}  ${scan.address}  has ${scan.txCount} transaction(s) (${scan.explorer}).`
			);
			err('');
			err('Morphit gives each BTC-fee order the next receive address of this account,');
			err('starting at #0, and an order counts as paid when its address has received');
			err('the fee. An address that already received coins would make an order look');
			err('paid when it was not.');
			err('');
			err('Make a NEW account in the wallet (in Mycelium: a new HD account), receive');
			err("nothing to it yourself, and run this again with the new account's key.");
			err('Nothing was changed.');
			err('');
			return 1;
		}
		if (scan.kind === 'unchecked') {
			const err = (s: string) => process.stderr.write(`${s}\n`);
			err('');
			err(`✗ Not saved. Could not check receive #${scan.index} (${scan.address}):`);
			err(`  no explorer answered (${explorers.join(', ')}).`);
			err('');
			err("Check the laptop's internet connection and run the same command again.");
			err('Another explorer: add  --explorer https://mempool.space/api');
			err('Only if the account is brand new and has never received anything:');
			err('add  --skip-history-check');
			err('Nothing was changed.');
			err('');
			return 1;
		}
		out(`✓ Never used: receive #0–#${scan.checked - 1} have no transactions.`);
	}

	writeFileSync(file, src.replace(LINE_RE, `$1'${check.xpub}'$2`));
	// Verify by reading back what is actually on disk.
	if (!readFileSync(file, 'utf8').includes(`btcXpub: '${check.xpub}'`)) {
		process.stderr.write(`\n✗ The file did not take the change — check ${file} by hand.\n`);
		return 1;
	}

	out('');
	out('✓ Treasury BTC key saved (public key, safe to commit).');
	out(`  file   : ${file}`);
	out(`  key id : ${check.keyId}`);
	out('');
	showAddresses();
	if (!key.trim().startsWith('zpub')) {
		out('');
		out('  (You pasted an "xpub". It does not say which wallet type it came from,');
		out('   so the comparison above is the proof. Right-click → "Copy zpub" in');
		out('   Sparrow gives a key that can only come from a native segwit wallet.)');
	}
	out('');
	out('Receive nothing to this account yourself: Morphit hands its addresses to');
	out('orders, one after another, from #0.');
	out('');
	out('If they match: commit this file; the next release op pins the key.');
	out('If they do NOT match: git checkout apps/indexer/src/config/canonicalTreasury.ts');
	out('and copy the key again from the right wallet.');
	out('');
	return 0;
}

main().then(
	(c) => process.exit(c),
	(e) => {
		process.stderr.write(`\n✗ Not saved. ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	}
);
