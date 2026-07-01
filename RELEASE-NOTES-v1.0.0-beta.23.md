# Morphit v1.0.0-beta.23

A privacy, reliability, and polish release. The headline is that your browser
no longer talks to third-party Blurt nodes to do everyday things: reading your
balance and history, browsing the block explorer, and confirming your key when
you sign in all now go through the instance you're already using. That closes a
quiet leak where outside servers could see your IP address and which account you
were looking at. On top of that, the "a new version is available" prompt now
shows up reliably, the QR sign-in code lasts its full five minutes, signing in
checks your input more helpfully, the first-trade flow is clearer, and a long
list of smaller annoyances are fixed.

For operators: this release **does** require reinstalling dependencies — run
`npm install` (or `npm ci`) as part of your deploy, because a dependency was
updated since beta.22. If you run behind BunkerWeb and your instance was first
deployed before the frontend config was switched to a bind-mount, do a one-time
`docker compose up -d frontend` so the new no-cache rules for the update files
take effect (a plain restart won't attach the new volume; fresh installs get it
automatically). `morphit-ops upgrade` now also rebuilds the command-line tools
and the MCP server, not just the web frontend.

## New

- **Your browser stops phoning third-party servers to read the chain.** Looking
  at your balance, your transaction history, and the block explorer used to make
  your browser contact outside Blurt nodes directly — which meant those nodes
  could see your IP address and which account you were viewing. All of that now
  goes through the instance you're already on, so there's nothing new for an
  outside server to learn about you. It's also more reliable: reads no longer
  break just because one particular set of public nodes is down.
- **Signing in no longer leaks which account is yours.** When you sign in or
  import a key, Morphit checks that your key matches your on-chain account. That
  check used to go straight to a third-party node, tying your IP to your account
  at the moment you logged in. It now goes through your instance instead. Your
  secret key still never leaves your device — only your public account name is
  ever looked up.
- **A "refresh now" button on the block explorer.** An account's explorer page
  updates on its own, but slows down its checks when the page sits idle, so a
  brand-new transaction could take up to a minute to appear. There's now a
  refresh button that pulls the latest straight away, plus a small note so you
  know roughly how fresh what you're seeing is.

## Fixed

- **The logo no longer logs you out.** Clicking the Morphit logo (and a couple of
  other spots) used to drop your in-memory session. Those now keep you signed in,
  the same way the rest of the site's links already did.
- **The "new version available" prompt now actually appears.** On some setups a
  caching layer could keep serving the old app, so the prompt to reload into a
  fresh version never showed. The app now also checks the deployed version
  directly and offers the update even in that case.
- **The QR sign-in code lasts the full five minutes it promises.** Pairing a
  phone by QR code could quietly expire after about a minute on some setups. It
  now stays valid for the whole five minutes.
- **Smaller fixes:** a couple of explorer/account links that showed a placeholder
  and led nowhere now work; a mistyped "blurt.media" link that used to slip
  through is now caught.

## Improved

- **Signing in checks your input as you type.** The account-name box re-checks
  when you edit it and turns red with a clear marker if the name can't exist or
  isn't found; the posting-key box flags an obviously-wrong key the moment you
  paste it; the confirm-password field tells you right away if it doesn't match.
  A connection problem never shows a false red — that isn't your fault.
- **The "how will you pay?" step is clearer.** The payment section on a new
  listing was relabeled and tidied, the four payment categories now start
  collapsed so the page isn't a wall of options, and the currency you want paid
  in is now a searchable picker instead of a free-text box.
- **Your first trade is guided.** Because a brand-new account needs a little
  BLURT before it can do anything else, your very first trade is set up as a buy
  of BLURT — explained on the page, with the listing fee waived — and is set to
  expire in seven days. After that first trade, everything is fully open as
  before.
- **A few helpful notes added.** The instances page suggests bookmarking a few
  instances (and their privacy-network addresses) since the order book lives
  on-chain and is reachable through any of them; the privacy page now spells out
  plainly what Morphit does and doesn't collect; and the "back up my keys" page
  shows the right guidance when you signed in with only a posting key.
- **Small polish.** Your avatar matches your public profile everywhere, the cards
  on your Orders page lift on hover and press on click, rows with a checkbox or
  radio button highlight on hover, and a number of labels and bits of wording
  were tightened.

## Under the hood

- **Privacy-first by construction.** The chain reads and the sign-in key check
  now run server-side on the instance you're using, over its own vetted set of
  nodes, so no outside party sees your IP or your account during normal use. The
  parts that exist specifically to *catch a misbehaving instance* — verifying
  signatures, release authenticity, and a chat correspondent's key — deliberately
  still query the wider network directly, because routing those through a single
  instance would defeat their purpose.
- **A dependency was updated** to pick up upstream security fixes, which is why
  this release needs `npm install` on deploy.
- **More regression guards, and translation upkeep.** New automated checks pin
  the behaviors above so a future change can't quietly undo them, and every new
  or reworded piece of on-screen text ships in all ten languages.
