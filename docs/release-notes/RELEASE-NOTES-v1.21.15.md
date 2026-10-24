# Morphit v1.21.15

**On a Tor or I2P site, every explorer link stays on Tor or I2P.** A payment's "view on explorer" link used to
open a clearnet block explorer (mempool.space, Blockchair, etherscan…) even when you were using the site's
`.onion` or `.i2p` address — one click and you left the hidden network. Now a page opened on a `.onion`, `.i2p`
or `.loki` address links only to explorers that are Tor or I2P services themselves:

- **Bitcoin:** mempool.space, Blockstream, mempool.emzy.de, Foundation and Cake Wallet onions, then Blockchair
  and 3xpl; on an I2P site, RunBTC's I2P explorer first.
- **Monero:** xmr.mx and P2Pool.io's explorer, then Blockchair and 3xpl; on an I2P site, xmr.mx's and
  moneroexamples' I2P explorers first.
- **Bitcoin Cash, Litecoin, Dash, Dogecoin, Zcash, Solana, Ethereum, XRP and every token network** (USDT, USDC,
  DAI on Ethereum, Tron, Solana, BNB Chain, Base, Polygon and Arbitrum): Blockchair's and 3xpl's onions.
- **Decred and Pirate Chain** have no working Tor or I2P explorer, so a hidden site shows no link for them; the
  transaction id stays on the page to copy. The "check on blocks.blurtwallet.com" link is not shown there either.

Every address was opened in Tor Browser or an I2P browser before it went in. The clearnet site is unchanged.

Two fixes ride along on the links: a Solana transaction's link keeps its signature exactly as written
(letter case matters there), and an Ethereum one always gets its `0x`.

**The warrant canary keeps working when clearnet explorers and nodes do not.** Its Blurt and Bitcoin block
heights and its news headline now come from onion (and I2P) sources when every clearnet one fails — asked all
at once — and a Tor-only server asks them first. They are reached only through the server's Tor proxy or i2pd,
never directly. Two hidden explorers must agree on the Bitcoin head before it is signed, so one lying explorer
cannot choose it.

**What the canary signs is checked first.** A Blurt head must be a real block id that carries its own height, a
Bitcoin hash must show its proof of work, every answer is read up to 64 KB, and the news headline becomes one
line of plain ASCII (at most 200 characters) that is filled in literally. Before, a headline with an `&` (say
"Q&A") came out as a broken placeholder that the canary check then rejected, and a headline could carry text
that looked like part of the signature block.

**More hidden data sources.** Bitcoin fee checks also ask mempool.foundation.xyz's onion and RunBTC's I2P
explorer; Monero fee checks also ask xmr.mx's I2P explorer. (Cake Wallet's onion timed out and xmr.mx's onion
answers only behind a captcha, so neither is a data source; both stay as links.)

**"No such payment" only when an explorer says so.** A source that answers with a captcha or an error page —
even with HTTP 404 — counts as a malformed answer, not as "no such payment": only an explorer's own "not found"
does (Bitcoin: Esplora's `Transaction not found`; Monero: the explorer's JSON error). Before, any 404 counted,
so explorers whose API was off or blocked could, together, reject a fee that was paid.

**When clearnet does not answer, the hidden network is tried** (on servers that still use clearnet):

- **Upgrades:** if the code host and every mirror are unreachable, and @morphit's signed record names a newer
  release, the upgrade fetches it from the other Morphit instances over Tor/I2P, checked against that record, as
  a zero-clearnet server always does. A newer release you dropped in the offline folder still comes first;
  `--check-only` and `--json` never fetch.
- **Clock:** a new timer (`morphit-clock-fallback.timer`) checks every 6 hours whether NTP keeps the clock;
  if it cannot (UDP blocked, pools unreachable), the clock is set from onion time sources over Tor, only when at
  least three agree it is more than 30 seconds off. While NTP works it does nothing. Only one time check runs at
  a time, and a server switched to Tor-only has this timer removed (its own replaces it).
- **Prices (BLURT, BTC, XMR):** if every clearnet price source is down, the median of other instances' prices
  comes before this server's own trades alone — only in USD, and only where the chain-pinned fee bounds it; where
  that bound cannot be read, the federation's price is not used at all, so sybil instances cannot set it. A peer
  whose web address does not answer is asked on its Tor or I2P address; a peer registered under a hidden name is
  reached only through Tor or I2P, never through this server's DNS. Every server now samples the other instances'
  prices (every 30 minutes); `MORPHIT_INDEXER_PEER_PRICE_MONITOR_ENABLED` still decides whether a clearnet server
  alerts on disagreement.

## For operators

- **Upgrade every instance** (`sudo morphit-ops`, option 2). No database change. The upgrade adds the new
  hidden fee sources to a fee-source list the wizard wrote, once (a source you remove later stays removed), and
  installs the clock fallback on a server that keeps clearnet NTP.
- **Your explorer overrides** (`MORPHIT_FRONTEND_*_CHAT_LINK_URL`) apply on the pages that can open them: a
  clearnet explorer on your clearnet site, a Tor onion on your `.onion` / `.loki` addresses, an I2P or Tor one on
  your `.i2p` address; otherwise the built-in list is used.
  An override may now use plain `http://` for a Tor v3 `.onion` or an `.i2p` host (the wizard, the indexer and
  the browser all accept it); everything else must still be `https://`. The wizard never checks such an address
  from the server, and none of its checks follows a redirect to one. See OPERATIONS, "Explorer links on a hidden
  site".
- **The canary** reads `MORPHIT_CANARY_TOR_SOCKS` (default `127.0.0.1:9050`) and the new
  `MORPHIT_CANARY_I2P_HTTP_PROXY` (default `127.0.0.1:4444`) for those hidden sources, and the new
  `MORPHIT_CANARY_ONION_NEWS_RSS` (space-separated `.onion` feeds; default the BBC's) for the news line. Pinning
  `MORPHIT_CANARY_BTC_EXPLORER` asks that explorer only. On a clearnet box without Tor the hidden sources fail at
  once and change nothing.
- **`MORPHIT_HIDDEN_RPC_TIMEOUT_MS`** that is not a positive number now falls back to 60 seconds; before, it made
  every Tor/I2P call time out at once.
- **Dependencies:** body-parser, qs, iconv-lite, fast-uri and undici updated within their versions for new advisories. A new zod
  advisory (memory use on an unbounded list) does not reach Morphit: every list it checks from outside input has
  a size limit, and the one that had none (a broadcast's `extensions`) now has one.
