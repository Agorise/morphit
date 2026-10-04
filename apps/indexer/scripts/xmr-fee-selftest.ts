/**
 * xmr-fee-selftest — the pre-pin check for bound XMR fees (v1.20.0, MK-H2).
 * Run on the LAPTOP, in the repo root (docs/OPERATIONS.md §40.13 has the
 * whole checklist):
 *
 *   # 1. where to send the test payment (nothing is sent anywhere):
 *   node_modules/.bin/tsx apps/indexer/scripts/xmr-fee-selftest.ts \
 *     --account <blurt account> --permlink <permlink> --primary <4… treasury main address>
 *
 *   # 2. after paying it (1+ confirmation), check it end to end:
 *   node_modules/.bin/tsx apps/indexer/scripts/xmr-fee-selftest.ts \
 *     --txid <64 hex> --txkey <64 hex> --account <blurt account> --permlink <permlink> \
 *     --primary <4… treasury main address> [--piconero 781250000] \
 *     [--explorer https://xmrchain.net --explorer raw-tx+https://moneroblocks.info …]
 *
 *   # the pre-pin (unbound) path: a plain payment to the shared fee address
 *   node_modules/.bin/tsx apps/indexer/scripts/xmr-fee-selftest.ts \
 *     --txid <64 hex> --txkey <64 hex> --unbound <the fee address> [--piconero …] [--explorer …]
 *
 * Without --explorer it uses the indexer's default list
 * (DEFAULT_XMR_EXPLORERS in apps/indexer/src/config/xmrExplorers.ts: explorers,
 * raw-transaction explorers and public Monero nodes). It asks them
 * about that one transaction exactly as every indexer will: a txprove explorer
 * (`https://…`) gets the txid and its tx key; a raw-tx explorer
 * (`raw-tx+https://…`) gets only the txid, and the payment is checked here
 * from the raw transaction. It prints each step and exits 0 only on PASS. Run it through Tor (`torsocks node_modules/.bin/tsx …`) if the laptop's
 * IP should not be seen asking about a treasury payment.
 */
import {
	runXmrFeeSelftest,
	runXmrUnboundFeeSelftest,
	xmrSelftestPayTo
} from '../src/lib/xmrFeeSelftest.ts';
import { DEFAULT_MONERO_PROOF_VERIFIER_CONFIG } from '../src/indexer/fee/moneroProofVerifier.ts';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
function args(name: string): string[] {
	const out: string[] = [];
	process.argv.forEach((a, i) => {
		if (a === `--${name}` && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]!);
	});
	return out;
}

async function main(): Promise<number> {
	const pico = arg('piconero') ?? '781250000';
	if (!/^[0-9]{1,30}$/.test(pico)) {
		process.stderr.write('--piconero must be a whole number\n');
		return 2;
	}
	const explorerArgs = args('explorer');
	const explorerList =
		explorerArgs.length > 0 ? explorerArgs : DEFAULT_MONERO_PROOF_VERIFIER_CONFIG.explorerUrls;
	const out = (l: string) => process.stdout.write(`${l}\n`);
	const unbound = arg('unbound');
	if (unbound !== undefined) {
		if (arg('txid') === undefined || arg('txkey') === undefined) {
			process.stderr.write('--unbound needs --txid and --txkey\n');
			return 2;
		}
		const ok = await runXmrUnboundFeeSelftest(
			{
				txid: arg('txid')!,
				txKey: arg('txkey')!,
				feeAddress: unbound,
				piconero: BigInt(pico),
				explorers: explorerList
			},
			fetch,
			out
		);
		return ok ? 0 : 1;
	}
	if (
		arg('txid') === undefined &&
		arg('txkey') === undefined &&
		arg('account') &&
		arg('permlink') &&
		arg('primary')
	) {
		const to = xmrSelftestPayTo(arg('primary')!, arg('account')!, arg('permlink')!);
		if (to === null) {
			process.stderr.write('--primary is not a mainnet main (4…) address\n');
			return 2;
		}
		out(`Send exactly ${pico} piconero, in a payment of its own, to:`);
		out(`  ${to}`);
		out('Then run this again with --txid and --txkey (monero-wallet-cli: get_tx_key <txid>).');
		return 0;
	}
	const need = ['txid', 'txkey', 'account', 'permlink', 'primary'] as const;
	for (const n of need) {
		if (arg(n) === undefined) {
			process.stderr.write(`missing --${n}  (see the header of this file)\n`);
			return 2;
		}
	}
	const ok = await runXmrFeeSelftest(
		{
			txid: arg('txid')!,
			txKey: arg('txkey')!,
			account: arg('account')!,
			permlink: arg('permlink')!,
			primary: arg('primary')!,
			piconero: BigInt(pico),
			explorers: explorerList
		},
		fetch,
		out
	);
	return ok ? 0 : 1;
}

main().then(
	(c) => process.exit(c),
	(e) => {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	}
);
