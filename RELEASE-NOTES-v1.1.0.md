# Morphit v1.1.0

A feature release on top of **1.0.1** — faster featured orders, wallet
improvements, sign-in support for older accounts, and a batch of polish and
operator fixes.

## Featured orders

- **Featured orders on the home page** now render as full-width horizontal
  cards, matching the order book, on desktop and mobile.
- When you **feature one of your orders**, it now takes you to the order book
  and appears as featured within a few seconds, instead of the button seeming
  to do nothing while the network caught up. (Other viewers see it as soon as
  the indexer confirms it.)

## Wallet

- Your **fiat value** now shows in the currency for your interface language
  (German → €, French/Italian/Spanish → €, Polish → zł, and so on) instead of
  always US dollars. You can still pick a specific currency in preferences.
- **Powering down no longer flashes your BLURT balance red.** That red tick was
  only the tiny network fee — the balance that actually moves is your BP,
  released weekly over 4 weeks. All other balance changes still animate as
  before.
- Clearer wording on the power-down screen about the 4-week schedule.

## Sign in

- **Older accounts can now sign in with a posting key.** If your account was
  created before Blurt existed (a "prefork" account) and we can't detect it
  from your key automatically, a username field now appears and checks your
  username against your key in real time — so you're no longer stuck with a
  "couldn't detect your account" dead end.
- Corrected the posting-key hint to simply "Starts with a 5."

## Fixes

- The **Canary** link in the site footer now opens correctly.
- The warrant canary now displays correctly in every browser (a text-encoding
  fix) and reads more cleanly.

## For operators

- **`morphit-ops upgrade`** reminds you to re-upload your warrant canary after
  an upgrade, and **`morphit-ops health`** checks it where it's actually served.
- **Release tooling** is now consistent about size limits — the release manifest
  is validated against the real on-chain limit before you sign, so you can't
  build one that broadcasts but then gets rejected.
- The **warrant-canary documentation** has been rewritten around signing on your
  own machine (a proper dead-man's switch) rather than a server cron job.
- The **on-chain release announcement no longer pins the Blurt RPC endpoint
  list.** It was redundant (clients ship their own default list) and only added
  weight to the chain. Release payloads now carry the version, asset hashes, and
  treasury addresses only — you no longer need an endpoints file to broadcast.
