# Morphit v1.0.0-beta.26

A reliability release, with one fix that matters more than all the others: new
account creation works again. On the way to launch we discovered that the Blurt
library Morphit relies on couldn't sign the two operations behind account
sign-ups and the relay's automatic token top-up, so a relay with plenty of funds
could still turn people away with a misleading "temporarily out of funds"
message. That's fixed. Alongside it: the "a new version is ready" prompt now
appears on desktop, not just mobile; the node-health screen shows your
account-creation-token buffer at a glance; the block explorer's account page got
a thorough polish; and a handful of smaller display bugs are closed.

For operators: `morphit-ops upgrade` handles this release the usual way — it runs
`npm ci` and rebuilds the web frontend, the command-line tools, and the MCP
server for you. Like the last few betas, **this release changes no third-party
dependencies**, so there's no special install step beyond the upgrade tool. After
upgrading, your relay will top its account-creation-token buffer back up on its
own; you can watch it on the node-health screen (option 13 in `morphit-ops`).

## New

- **Node health shows the auto-minter.** The node-health screen now reports your
  relay's automatic account-creation-token (ACT) minter right next to version and
  uptime: a green "✓ N ACT's ready" with the buffer it tops up to, or a red
  "Disabled" if you've turned it off. It's on by default for every instance, so a
  relay keeps itself stocked to create accounts without you having to think about
  it.
- **The block explorer shows an account's four public keys.** The account page now
  lists Owner, Active, Posting, and Memo public keys, instead of just the posting
  key — the full picture for anyone inspecting an account on-chain.
- **Reachability addresses are clickable.** On the public instances directory, an
  instance's Tor, Lokinet, I2P, and Nostr addresses are now links you can open
  directly, rather than text you had to copy out of a tooltip.

## Fixed

- **New account sign-ups work again — and the relay restocks itself.** The two
  on-chain operations behind creating an account and minting account-creation
  tokens couldn't be signed by the bundled Blurt library, which is why some
  instances showed "our registration service is temporarily out of funds" even
  with a healthy balance. Both operations now sign correctly, so sign-ups go
  through and the relay refills its token buffer automatically.
- **The "update ready" prompt now appears on desktop.** Previously the prompt to
  load a freshly deployed version reliably showed up on mobile but often never
  appeared on a desktop browser, which would quietly pick up the new version on
  its own. The desktop prompt now appears the way it should, so loading an update
  is your choice on every device.
- **The footer remembers your instance's name.** An over-eager cache could revert
  the operator's instance name in the footer back to the default until a hard
  reload; it now stays correct after a normal page load.
- **The order book's interest rate reads correctly.** A display bug overstated the
  live BLURT annual rate by roughly five times on one surface; it now matches the
  real, on-chain-derived figure (the rate is always computed live, never
  hard-coded).
- **"Load older operations" no longer stalls near the start of history.** On the
  explorer's account page, paging further back used to silently fail once you got
  close to the beginning of an account's history; it now loads the remaining
  operations correctly, with a clear loading indicator.
- **Explorer account links resolve.** Transaction and block links on the account
  page no longer lead to a not-found page.
- **Two smaller display bugs.** A profile picture that could differ between
  surfaces now derives from one consistent source, and a private account card no
  longer briefly appears for signed-out visitors.

## Improved

- **An accurate voting-power reading.** The account's voting-power percentage now
  accounts for delegation (power received and delegated away), so heavy delegators
  see a correct figure rather than an understated one. For an account with no
  delegation, nothing changes. The label across the app is now simply "Voting,"
  and the accompanying hint drops an old, inaccurate description of how the chain
  charges for actions.
- **Clearer wording while signing in and setting up keys.** Several small pieces of
  on-screen text on the login, avatar, and key-import screens were reworded for
  clarity, the key-import field now caps overly long input, and a private-key field
  shows a clearer icon.
- **A friendlier "leave this page?" warning.** The prompt shown if you try to
  navigate away while choosing a username is now plainer, and the page previews
  your chosen "@name" on the claim button as you type.

## Under the hood

- **More regression guards.** New automated checks pin the behaviors above — the
  account-creation-token serializers (proven byte-for-byte against the reference
  library), the node-health auto-minter line, the desktop update prompt, and the
  cache rules that keep the update surface fresh — so a future change can't quietly
  undo them.
- **The full project test suite runs clean again.** Two service components that
  carry their checks as standalone smoke tests rather than unit tests were causing
  the repo-wide `npm test` to report a false failure; the command is green end to
  end again.
- **A repo-wide audit pass.** A full security and code audit — including hostile-
  input checks on every on-chain operation handler, a sweep for dead database
  fields, stale references, and resource leaks, and complete persona walkthroughs
  across the app, the operator tools, and the read-only agent interface — found the
  tree in good shape, with the fixes above applied.
- **Translation upkeep.** Every new or reworded piece of on-screen text ships in
  all ten languages.
