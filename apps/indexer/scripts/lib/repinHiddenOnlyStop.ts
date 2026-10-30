/**
 * The treasury re-pin scripts run on a SERVER too (ops/systemd/
 * morphit-treasury-repin.service, via ops/scripts/morphit-treasury-repin.sh):
 * the detect-only check (treasury-repin-check.ts, the default) and the
 * broadcast (treasury-repin-broadcast.ts). Both need clearnet: the prices come
 * from CoinGecko, CoinPaprika and Kraken, and the broadcast reads the current
 * release op from clearnet Blurt nodes. A hidden-only Morphit server must not
 * reach clearnet at all, so both stop before anything is asked (v1.21.18
 * review). MORPHIT_REPIN_HIDDEN_ONLY=no|yes in /etc/morphit/treasury-repin.env
 * says it where the unit's user (morphit-host-monitor) cannot read the
 * server's settings.
 */
import { hostHiddenOnly } from './signOnceBroadcast.ts';

/** null to go on, else the lines to print before exiting 1. `needs`: what the
 *  script would ask over clearnet, for the hidden-only line. */
export function repinHiddenOnlyStop(
	needs: string,
	deps: {
		readonly env?: NodeJS.ProcessEnv;
		readonly hiddenOnly?: () => 'yes' | 'no' | 'unknown';
	} = {}
): string | null {
	const env = deps.env ?? process.env;
	const said = (env.MORPHIT_REPIN_HIDDEN_ONLY ?? '').trim().toLowerCase();
	const here =
		said === 'no' ? 'no' : said === 'yes' ? 'yes' : (deps.hiddenOnly ?? (() => hostHiddenOnly()))();
	if (here === 'yes') {
		return (
			'✗ This server is hidden-only (its indexer.env has no clearnet Blurt RPC nodes, or its IPFS routes\n' +
			`  nothing): ${needs} — so nothing was asked. Run the re-pin on a machine with clearnet.`
		);
	}
	if (here === 'unknown') {
		return (
			'✗ Could not tell whether this server is hidden-only: /etc/morphit/indexer.env is there but this\n' +
			'  user cannot read it, and IPFS does not say. Nothing was asked. If this server is NOT\n' +
			'  hidden-only, say so, on this server:\n' +
			"    echo 'MORPHIT_REPIN_HIDDEN_ONLY=no' | sudo tee -a /etc/morphit/treasury-repin.env"
		);
	}
	return null;
}
