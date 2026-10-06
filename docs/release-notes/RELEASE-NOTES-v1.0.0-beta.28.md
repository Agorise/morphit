# Morphit v1.0.0-beta.28

This release changes how your instance creates new Blurt accounts at signup, so
that it uses the only account-creation method Blurt still supports. Until now the
relay relied on Blurt's Account-Creation-Token system — minting tokens ahead of
time and spending one per signup. Blurt disabled that system at a hard fork (both
of its operations now hard-fail on the chain), so the relay now creates each
account with a direct account-creation operation instead, paying the chain's
account-creation fee inline at the moment someone signs up.

For people signing up, nothing changes: registration still costs you nothing, you
still get the welcome bonus after your first completed trade, and listing fees are
unchanged. The difference is entirely on the relay's side — how it talks to the
chain to create your account.

Behind Morphit's beta access gate this hadn't surfaced as a visible failure yet,
but the old token-based path would have blocked signups on any public instance.
This release puts account creation back on a working footing.

## Changed

- **New accounts are created with a direct account-creation operation.** The relay
  now pays the chain's account-creation fee (about 100 BLURT) inline, per signup,
  reading the exact current fee from the chain each time so it always matches what
  the network requires. The previous token-based approach — minting Account
  Creation Tokens in advance and consuming one per signup — is gone, because Blurt
  no longer allows either token operation. The account that ends up created, the
  one BLURT of starter bandwidth it receives, and the welcome bonus after a first
  trade are all exactly as before.

## For operators

- **No more token minting — keep the relay funded instead.** There is no longer a
  weekly token-minting ceremony, no in-process auto-minter, and no `mint-acts`
  script or timer. Your relay creates each account by paying the fee directly from
  its liquid BLURT, so the one thing it needs is enough BLURT on hand to cover your
  signups (roughly 100 BLURT each, plus the welcome bonuses for people who go on to
  trade). When the balance runs low the relay pauses signups cleanly and your
  alert bot messages you over Matrix; top it up and signups resume on their own
  within about thirty seconds. The total cost is the same as before — only the
  timing changed, from pre-paying a weekly batch to paying per signup.

- **Upgrading from an earlier deploy:** after `morphit-ops upgrade`, remove the
  leftover token-minting pieces if you set them up — the
  `morphit-relay-mint-acts.service` and `.timer` units, and any
  `MORPHIT_RELAY_AUTOMINT_*` or `MORPHIT_RELAY_WEEKLY_ACT_COUNT` lines in your
  relay's environment file. They no longer do anything. The funded-balance alert
  you may already have configured (the indexer's relay-balance threshold) keeps
  working unchanged. See OPERATIONS.md §0a for the funding math and §47 for the
  low-balance alerts. As with recent betas, **this release changes no third-party
  dependencies.**

## Under the hood

- **A regression guard pins the new path.** A new automated check verifies that the
  relay builds the direct account-creation operation with the fee paid inline and
  the exact field layout the chain expects, and fails if anyone ever tries to bring
  back the disabled token operations. The key-custody design is unchanged — the
  same online key that signed the old operation signs the new one — and the
  architecture decision record and operator runbook have been updated to match.
