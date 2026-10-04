/**
 * Post-upgrade self-heal: the onion BTC fee explorers for an installed node
 * (v1.21.0).
 *
 * `morphit-ops init` wrote MORPHIT_INDEXER_BTC_EXPLORER_URLS into
 * /opt/morphit/morphit.env with the defaults of its day — blockstream.info and
 * mempool.space only — so such a node would keep asking clearnet websites and
 * never the onion explorers the indexer now asks first, over Tor. This adds
 * each current default (the four onion explorers; the two clearnet ones stay
 * as the fallback) the same way the Monero list heal does
 * (lib/feeExplorerListHeal.ts): once, keeping every entry the operator has and
 * its order, never re-adding a default the operator removed after it was
 * offered, and never touching an explicitly empty list (BTC fees off). An
 * Ansible install leaves the key unset: the indexer's default applies, nothing
 * to do. A zero-clearnet node needs nothing more: it never contacts the
 * clearnet entries of its list.
 */
import { DEFAULT_BTC_FEE_EXPLORERS } from '@morphit/operator-config/fee-sources';
import { healExplorerList, type ExplorerListOutcome } from './feeExplorerListHeal.ts';

export { DEFAULT_BTC_FEE_EXPLORERS };

export const BTC_EXPLORER_ENV_KEY = 'MORPHIT_INDEXER_BTC_EXPLORER_URLS';

export function healBtcExplorerList(
	root = '',
	log: (m: string) => void = () => {},
	warn: (m: string) => void = () => {}
): ExplorerListOutcome {
	return healExplorerList(
		{
			key: BTC_EXPLORER_ENV_KEY,
			defaults: DEFAULT_BTC_FEE_EXPLORERS,
			retired: [],
			label: 'Bitcoin fee checks',
			what: 'Bitcoin fee sources'
		},
		root,
		log,
		warn
	);
}
