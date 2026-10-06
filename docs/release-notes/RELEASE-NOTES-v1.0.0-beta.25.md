# Morphit v1.0.0-beta.25

A trust, transparency, and launch-readiness release. The headline for operators
is that the project's treasury addresses (BLURT, BTC, and XMR) are now baked into
the software itself as a single source of truth — and the public instances
directory flags any instance whose on-chain treasury doesn't match them, so a
look-alike can't quietly redirect fees. Operators can also set their instance's
display name and branding on the directory card. For everyone else: signing out
now signs you out everywhere, the FAQ search is more precise, and a couple of
small interface bugs are closed. Under the hood, the on-chain release machinery
that the public launch depends on was completed and hardened.

For operators: `morphit-ops upgrade` handles this release the usual way — it runs
`npm ci` and rebuilds the web frontend, the command-line tools, and the MCP
server for you. Like beta.24, **this release changes no third-party
dependencies**, so there's no special install step beyond the upgrade tool.

## New

- **The project treasury is part of the software now.** The canonical BLURT, BTC,
  and XMR treasury addresses are baked into the code as the single source of
  truth, rather than something each piece configures separately. Fee routing and
  every on-chain treasury check derive from that one place, which removes a whole
  class of "which address is right?" mistakes.
- **The directory flags treasury mismatches.** On the public instances page, an
  instance whose on-chain treasury address doesn't match the canonical project
  treasury now carries a clear mismatch indicator — a trust signal that makes a
  fee-redirecting look-alike visible at a glance.
- **Name and brand your instance.** Operators can set their instance's display
  name and branding for its directory card through `morphit-ops`, so your node
  shows up the way you want it to.

## Fixed

- **Sign out means sign out — everywhere.** Signing out from any control,
  including the avatar menu, now clears your session across the whole app
  consistently, instead of leaving some surfaces still showing you as signed in.
- **Your instance's directory name actually updates.** A bug kept an operator's
  chosen instance name from changing on the directory card; it now reflects what
  you set.
- **The asset picker on the order book closes properly.** Selecting an asset no
  longer leaves the picker stuck open.

## Improved

- **Sharper FAQ search.** Search now accepts ordinary straight quotes (not just
  curly ones) for exact-phrase matching, waits for a few characters before it
  starts matching so a single keystroke doesn't flood the results, and subtly
  highlights the matched terms so you can see why a result came up.
- **A foolproof path to the on-chain release.** The release ceremony now has
  proper tooling: a laptop-only helper signs and broadcasts the on-chain release
  record with the signing key entered at a masked prompt (never stored, never
  logged), and previews exactly what it will send before asking for the key. The
  release bundle's integrity manifest now generates in the exact format the
  on-chain record and the in-browser verifier expect.
- **Clearer launch documentation.** The operator launch runbook was de-duplicated
  and reconciled into one canonical sequence, so there's a single, unambiguous
  set of steps to follow at go-live.

## Under the hood

- **The on-chain release pipeline works end to end.** The chain of build → integrity
  manifest → signed release record was completed and proven end to end, and is now
  pinned by automated checks so it can't drift back out of shape. This is the
  groundwork the public launch (which will let any visitor's browser verify the
  running site hasn't been tampered with) is built on.
- **Leaner chat bundle.** A type-only import was corrected so a byte-handling
  polyfill no longer rides along into a chat code chunk it never needed.
- **More regression guards.** New automated checks pin the behaviors above — the
  treasury single-source-of-truth, the release-manifest format, and more — so a
  future change can't quietly undo them.
- **Translation upkeep.** Every new or reworded piece of on-screen text ships in
  all ten languages.
