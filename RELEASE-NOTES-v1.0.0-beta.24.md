# Morphit v1.0.0-beta.24

A reliability, self-healing, and polish release. The headline for operators is
that your instance now keeps its own account-creation buffer topped up by
itself — so new sign-ups stop failing silently when that buffer runs dry — and
it alerts you the moment account creation is actually being refused. For
everyone else: a sign-in bug that wrongly rejected a valid account is fixed, a
couple of subtle key- and order-handling issues are closed, the FAQ comparisons
are refreshed, and a long tail of smaller annoyances is tidied up.

For operators: `morphit-ops upgrade` handles this release the usual way — it runs
`npm ci` and rebuilds the web frontend, the command-line tools, and the MCP
server for you. Unlike beta.23, **this release changes no third-party
dependencies**, so there's no special install step beyond what the upgrade tool
already does. If you haven't already, this is a good moment to set your alert
address (`morphit-ops` → Matrix alerts) so the new account-creation alerts
actually reach you.

## New

- **Your instance keeps itself able to create accounts.** Creating a new account
  consumes a pre-minted "account token" the relay holds in a small buffer; when
  that buffer empties, sign-ups fail — regardless of how much BLURT the relay is
  holding. The relay now refills that buffer on its own, in the background,
  spending only above a reserve you set, so you no longer have to top it up by
  hand. This is on by default; set the auto-mint switch to off if you'd rather
  manage it yourself.
- **An alert the moment sign-ups are actually being refused.** Previously, if the
  account-creation buffer ran dry, new users just hit a failure and you got no
  warning (the only balance alert watched BLURT, which could be plentiful while
  the buffer was empty). There's now a CRITICAL alert that fires exactly when the
  buffer falls to the point where sign-ups are being rejected — and clears itself
  when it recovers — so a silent sign-up outage can't go unnoticed.
- **Exact-phrase FAQ search.** Wrap a search in quotes ("…") to match that exact
  phrase instead of the individual words.

## Fixed

- **Sign-in no longer wrongly rejects a valid account.** Importing or signing in
  could report a perfectly valid account as "invalid" because the account-lookup
  request was being built with a doubled slash in the URL that the server then
  refused. The address is now always built correctly, so a real account is found.
- **The right key, every time.** On the key panel, the short fingerprint shown on
  screen could differ from the full key the Copy button actually gave you. It now
  shows a shortened form of the *same* value you copy.
- **No accidental duplicate orders.** If you navigated away while an order was
  mid-broadcast — unsure whether it had landed — and then posted again, you could
  create a second, duplicate order on-chain (each attempt gets its own random
  identifier). Navigation is now held while an order is being broadcast, the same
  protection the account-creation step already had.
- **"Register when you're ready" actually points somewhere.** A sign-up message
  used to tell people to "register from Settings," but Settings has no
  account-creation step — only on-chain name verification. The wording now points
  at the real path (the register prompt on the order book), in all ten languages.
- **Operator console fixes.** The `morphit-ops` status dashboard no longer dead-ends
  with "No database URL configured" when you run it from outside the install
  directory, and the menu's colored markers (including the bright "update
  available" flag) render in color again.
- **Quieter console behind the beta gate.** A harmless-but-noisy `manifest 401`
  during the beta's password gate is resolved.
- **Smaller fixes.** Clicking the logo (and a couple of other spots) no longer
  drops your in-memory session; a fresh page no longer loads with its top heading
  tucked under the sticky header; and a "you're about to switch accounts" prompt
  prevents a stale-session mix-up on the sign-in page.

## Improved

- **The FAQ comparisons are current.** The "how is Morphit different from …"
  articles were reorganized and brought up to date — including the recent
  real-world events that make the case (a major Bisq/Haveno-class exploit and the
  shutdown of a long-running competitor) — across all ten languages.
- **One wordmark, loaded once.** The header, hero, and footer logo are now the
  exact same asset, fetched a single time and cached, instead of being requested
  repeatedly.
- **Glossary and copy.** The glossary intro, the "BLURT Power" entry, and a number
  of labels and descriptions were tightened, with every change shipped in all ten
  languages.

## Under the hood

- **Self-healing by default.** The account-token refill loop is bounded (it never
  spends below your reserve, mints only toward a target, and caps how much it does
  per cycle) and logs what it does, so the relay can keep itself healthy without
  surprising you.
- **More regression guards.** New automated checks pin the behaviors above — the
  duplicate-order guard, the corrected sign-in lookup, a documentation-vs-code
  check that catches an operator example naming a setting the software doesn't
  read, and more — so a future change can't quietly undo them.
- **A deep, repo-wide audit pass.** A multi-session review swept every workspace
  for drift, dead code, hostile-input handling, privacy leaks, and documentation
  accuracy; the findings it surfaced are the fixes above.
- **Translation upkeep.** Every new or reworded piece of on-screen text ships in
  all ten languages.
