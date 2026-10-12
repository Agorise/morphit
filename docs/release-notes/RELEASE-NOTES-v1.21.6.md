# Morphit v1.21.6

A Tor/I2P-only server whose new release is not reachable yet now says so plainly and offers a way
forward, instead of stopping with a red ✗. Chats can be scrolled back to the first message and exported
whole, every FAQ answer was checked against the code and rewritten, a branded site names itself in many
more places, and the stats page's RPC card shows each node's measured state the moment it opens.

**Upgrading:** `sudo morphit-ops upgrade` on every server. No database change. Like every change to the
upgrade, the new behaviour starts with the upgrade AFTER the one that installs it. **Every instance must
run v1.21.1 or later before 2026-11-01 00:00 UTC.**

## Zero-clearnet upgrades that have to wait

On 2026-10-10, morphitlat's upgrade to v1.21.5 stopped twice ("could not reach this node's own indexer
… no answer within 60s"); the third try, a minute later, went through. Nothing was wrong: its indexer reads
the chain over Tor and I2P, and one read can take longer than a minute.

- **It keeps asking.** The signed release record is now asked for again, for up to 8 minutes, when no
  answer comes in time — not only when the answer lacks the record.
- **It says what it is doing.** One line on how a zero-clearnet upgrade works, then a spinner that names
  the step (reading the signed record over Tor/I2P; searching the federation, which instance it is asking,
  how many it has asked, how many had no copy) and counts the time. The long per-URL lines are gone.
- **When the release cannot be reached yet:** what it searched and for how long, what each instance
  answered (by its directory name: "does not have v1.21.6 yet", "did not answer in time", "could not be
  reached"), and that nothing was changed. At a terminal it asks: 1 try again now, 2 keep trying by itself
  for up to an hour, 5 minutes after each try (it still asks before installing), 3 stop for now and try
  again once more trusted instances have upgraded. Unattended it explains and stops, nothing changed
  (exit 5).
- A record signed by another key, or any other fault, is still a plain fail-closed error — also when the
  node it asks lists a second record or did not answer in time on an earlier try.
- An instance that does not answer no longer holds up the others: the next one is asked as soon as any
  one has answered (before, one silent instance could hold up every one after it for up to 20 minutes).
- If the server was upgraded by another session while it waited, it says so and stops, nothing changed.
- The waits run on a steady clock, so a Tor-only box that corrects its clock mid-wait neither stretches
  nor cuts them; "kept trying for" shows the time it really took. Instance names in other scripts
  (Chinese, Hindi, Persian) are shown whole and fit the spinner line; anything that could steer the
  terminal is removed from them.

## The site

- **Chats: scroll back to the first message, and export all of it.** Scrolling up in a conversation now
  loads older messages, page by page, all the way to the first one. Before, only the newest 50 messages
  between the two of you could be reread, and a discussion whose messages were all older than those 50
  showed as empty; it now shows them. **Export chat** now puts every message the two of you ever exchanged
  in the PDF, from every discussion, each run of messages headed by the order it is about ("Not about an
  order" for the rest). It reads the whole history first and keeps trying for up to about two minutes if
  the site is busy; if part of it still can't be read, nothing is saved and it says so. Nothing is saved
  either if the session locks while the file is being made. Messages sent in the same block now show in
  the order the chain recorded them (they could appear the other way round). Old payment and address
  messages loaded by scrolling back never change the status of a trade.
- **Run a node → "Your relay account pays".** Shorter lines, in every language: "Startup: 102 BLURT for
  each **new** account your site creates (the chain's fee plus 2 BLURT to start)."; "10 BLURT + 10 Blurt
  Power (BP) upon your user's first completed (paid) trade."; "BP rewards lent: 1 BP welcome stake and
  loyalty-program rewards up to 1260 BP per user. You can retract it." The top-up line is unchanged.

- **A branded site names itself in many more places.** About 120 more strings now show the site's own
  name instead of "Morphit" (about 150 more mentions in English, mirrored in all ten languages): the FAQ (21 questions
  and the answers that speak about the site the visitor is using), the glossary, sign-up and the backup
  card, the backup-keys page, the wallet and posting errors, the post form, the security page, settings,
  page descriptions, the update notice, and the Blurt posts a user publishes ("I joined Vigilante
  Trading", "Check out my offer on Vigilante Trading!"). Mentions of the software, the project, the
  federation and other instances, releases and versions, the treasury and @morphit still say Morphit.
  The degraded-mode page names the site too.
- Places that showed the address morphit.io on every site no longer do: the cheat sheet's "lost your
  device" step, the Safari push-notification help, the phishing warning ("sites that look like this
  one"), the QR-login warning and "the web app you see at morphit.io". The footer's Compare link said it
  compares Morphit "to other options"; it compares this site's orderbook with another instance's, and
  now says so.
- **Homepage: the first-trades card.** No "Your first trades" pill; the line under the heading reads "Pick
  a cool username, that's it. Once it's registered on the chain, you can start trading anything,
  instantly." Six numbered tiles, all in the brand tint and all floating gently: Get in, Post a buy (its
  "(it's free)" only where this site pays the free first buy), Private chat, Welcome coins, Passive income
  ("…auto-pay you daily at N.NN% apr", the same staking rate and formula as the wallet, read through this
  site's indexer; no rate is named until it arrives, or when the figure is not one a real chain gives) and
  Loyalty rewards. A site without an operator tag
  pays no rewards, so it shows four tiles (no welcome coins, no loyalty rewards). More room above and
  below, so the glow no longer crowds the cards above or the coins below. The card, and its rate read,
  load only when it scrolls near (a placeholder of the same height holds its place; without JavaScript
  the placeholder takes no room).
- **Primary buttons light up on hover.** Every button with the solid brand face (the "Create your free
  account" style, including the hand-built ones in the wallet, chat and modals) shows a 1px edge in the
  brand accent on hover; disabled buttons do not.
- **"BLURT" in capitals means the coin, and only the coin.** The chain is "Blurt": "Blurt is Morphit's
  coordination chain", "Morphit runs on Blurt, and listing fees are paid in its coin, BLURT", the
  glossary entry ("Blurt (BLURT)": a blockchain and its coin), the BLURT payment-method and asset
  descriptions ("the coin of Blurt, the chain … runs on"), and "Blurt Power" everywhere (it was written
  "BLURT Power" in ten places per language). Every BLURT left is an amount, a balance, a price or a fee.
- **Footer.** The "Runs on Morphit" line under the footer logo is gone (it showed only on branded sites).
  *About this instance*, linked in the footer, still shows which Morphit version a site runs.
- Six languages still said "on Morphit" in three older texts (the USDT and Dash privacy guides, the
  Dogecoin asset note) where English names no site; they name the site now.
- **FAQ search** finds the introduction for "what is this", "what is this site", "what's this app" and
  "what is this platform about" again, and on a branded site also for the site's name ("what is
  Vigilante Trading"). In v1.21.5 it answered "what is this" with an unrelated entry (the iPhone one on
  an unbranded site). On a branded site, a name made of everyday words no longer buries answers about
  those words ("escrow" on a site called "Escrow Shop" finds the escrow answer), a name inside other
  words is left alone ("Bit" in "Bitcoin"), and a search that names Morphit still finds its answer.
  "where is the app" finds how to install it.

- **Stats → RPC endpoints shows real measurements the moment the page opens, and keeps them fresh.**
  Before, the card first showed the relay pool's passive view (every hidden node "offline", clearnet
  latencies from whenever they were last used), then about 20 seconds later the result of a fresh probe;
  the refresh button repainted the passive view (mostly red) while it spun. Now the indexer measures
  every published node itself, each one every 20 seconds (with one retry on a miss), and answers the
  card instantly from those measurements. The card asks again every 10 seconds while it is visible and
  when you come back to the tab, shows how long ago each node was measured ("measured 6s ago"), and never
  replaces a newer answer with an older one. The refresh button asks the indexer for a fresh round
  (at most once every 5 seconds; nodes are never probed twice at once) and keeps the current rows on
  screen while it waits. A node not measured yet (just after the indexer starts) says "probing…", not
  "offline"; a failed node shows its real reason (a node that stalls mid-answer now reads "timed out"); the
  "reestablishing" label is gone. The card no longer waits for the page's other statistics to load first
  (or vanishes when they fail), and those statistics keep their place while they load, so the card does
  not jump. It counts "measured … ago" on the indexer's clock, and keeps working if either clock is off or
  is corrected; without JavaScript the stats page shows no empty figures or "probing…". `morphit-ops
  health` now shows each node's latency (it showed "—" for every node), and a node the indexer has not
  measured yet reads "being measured" instead of counting as unreachable.
- **For API users:** `/v1/chat/:a/:b` takes `order=<permlink>` to read one discussion (`order=` with no
  value: the one about no order). Paging through `/v1/chat/:a/:b`, `/v1/accounts/:account/feedback` and
  `/v1/accounts/:account/feedback-given` could skip rows recorded in the same block (they were sorted by
  their id as text, "100" before "99", while the cursor compares numbers); every row now comes once. A
  page far back in a chat history reads only that page. Each row of `/v1/rpc-endpoints` now carries
  `checked_at`, and `cooldown_ms` is always 0. `/v1/stats` counted a trade reviewed by both people twice; it counts it once now.
  `/v1/activity/volume` added an order's volume once per review; it adds it once per order now. `docs/API.md`
  documents `/v1/rpc-endpoints` and the reputation receipt, and no longer lists a `/v1/accounts/:account`
  route the indexer never served.
- **Every FAQ answer was checked against the code and rewritten to be short and plain.** All 146
  answers, in all ten languages, about 40% shorter overall (44% in English). A second, independent check
  of every answer against the code followed, and its corrections are in too. Every number and claim was verified in the
  code (fees, limits, timings, rewards, rate limits, menu labels); claims the code does not support were
  removed or corrected, internals and history were cut, and cross-references now match the current
  question titles. Answers now link to the pages they mention (My Orders, Run a node, the privacy
  guides, the explorer…), and the three that showed "/privacy/{asset}" literally now link to the privacy
  guides. "What's the most private way to sign in?" has a new title. Notable corrections: the no-JavaScript
  answers (the FAQ answers, privacy guides, orderbook, profiles and reviews need JavaScript; pages like
  security, glossary and run-a-node, the FAQ's questions and the RSS feeds do not), the welcome bonus (two
  welcome rewards, how the free first buy fits in), hidden accounts (saved with your encrypted settings
  while signed in, so they follow you; the hide button is on computers and tablets), the "New trader"
  label (fewer than 4 completed trades), QR sign-in (the computer can't read chat messages), the chain's
  smallest Blurt Power loan (about 33 BP), the chat export and rereading old messages (now everything
  ever said, see above), the Monero TxID (also asked for when you tell a partner you paid in XMR), and when a
  BTC/XMR price falls back to other sources.
- The same check found a few screens saying things the code does not do; they now match it: the
  no-JavaScript notice (it said orders, profiles and reviews work without JavaScript), Settings →
  Utility (signing out does wipe your keys from the device; Lock session keeps them), the hidden-accounts
  note and hide button (the list follows you while signed in), the "New trader" screen-reader label, the
  stranger-fee slow-down notice (blocks do not lower your standing), the QR-paired computer (chat
  messages open only on the phone), the DAI network warning, the free first order's next steps (a review
  can't cite the free order) and the review form ("free" → only Blurt's tiny network fee).

## Smaller

- The snapshot mirror names only the addresses this server really has (clearnet, .onion, .b32.i2p).
- The staking rate shown on the wallet, the explorer and the homepage is left out when the chain data
  behind it gives a rate no real chain state gives (20% or more); a lying RPC node could otherwise put any
  rate there.
- FAQ links that point to another site always open in a new tab and never pass the page along.
- The indexer reads at most as many RPC directory nodes as a valid signed directory can hold.
- A chat that reconnects to its live stream no longer misses messages sent in the same block as the last
  one it had (the catch-up read sorted ids as text). The indexer also sorted block numbers as text in a
  few places (operator registrations, BTC fee addresses, the upgrade reconcile); that would have gone
  wrong from block 100,000,000. Fixed now.

## About the v1.21.5 upgrade (no action)

- An upgrade to v1.21.5 run by v1.21.4 printed "⚠ Your instance origin could not be applied (… this build
  is branded …)" and the same run then applied the origin anyway. v1.21.4's branding reset wrote back a
  setting v1.21.5 no longer uses, so the fresh build looked branded for a moment. One-time: the self-heal
  (run by v1.21.5) fixed it, and v1.21.5's own upgrades do not do it. A box upgraded straight from an
  older release (timeapp) shows it once too, then the same fix.
