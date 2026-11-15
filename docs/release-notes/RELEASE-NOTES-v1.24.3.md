# Morphit v1.24.3

The relay's payment queue can no longer send one payment twice, however long a send takes to get
going.

This release contains everything in v1.24.2. The deadline v1.23.5 set still stands: every site must
run v1.23.5 or later (so this release is fine) before **2026-11-22 00:00 UTC**.

## For people using the site

Nothing changes on the site. Welcome bonuses and loyalty rewards are paid as before.

## For operators

Upgrade as usual. Nothing to configure.

**The payment queue's never-pay-twice guarantee no longer depends on running one relay.** An
outside security report, sent to the address in `docs/SECURITY.md`, showed that two relays sharing
one database could both send the same welcome bonus or reward. It took a slow chain: more than a
minute between the relay taking a payment and signing it. A standard site runs one relay per
database, so this could not happen on it. The queue now stays correct even with two.

**A payout held for review keeps the record of a payment that may already be on the chain.** When
the indexer finds database code Morphit never creates, it holds every unsent payout for you to
review. It used to write its reason over a payout's record of a signed payment, so
`morphit-ops failed-broadcasts` showed such a payout as "not sent" instead of "may have been sent",
and without its transaction id. Re-queuing it could have paid it twice. The record is now kept, and
the list shows the payout as "may have been sent", with the way to look it up first.

A relay that finds another relay has taken a payment it was about to sign now logs
`row_claim_lost` and leaves the payment to that relay. Nothing is counted against the payment.

## For developers

- **`apps/relay/src/queue/drainer.ts`:**
  - The claim compares the whole row as it was read (`broadcast_attempt_at` and `last_error`), and
    takes it only while `error_count` is below the retry limit. It returns the stamp it wrote.
  - `onSigned` records the signed transaction only while the row still carries that stamp and is
    not stopped. Otherwise nothing is sent, the drainer logs `row_claim_lost`, and the row is left
    as it is (no failure counted).
  - Why both: the drain query takes a row again once its stamp is older than the retry backoff
    (1 minute at first), and the head read before signing walks the nodes one after another
    (10 s each, 60 s over Tor or I2P). A second drainer could then claim with the first one's stamp
    and send; and one that read the row before the first recorded its transaction could still
    claim after it. Tying only `onSigned` to the claim would close the first case, not the second.
  - The file's header no longer says the claim alone keeps two drainers off one row.
- **`apps/indexer/src/indexer/foreignCodeHeal.ts`:** the hold keeps a `last_error` that starts
  with `outcome_unknown` or `in_flight trx_id=`, and writes its reason over every other one.
- **Tests:**
  - `drainer-no-double-pay-smoke` (real Postgres, two real drainers, each paused at the exact
    statement): a second drainer taking the row while the first reads the head; both drainers
    before signing; a second drainer that read the row before the first signed and claims after;
    a row stopped before the claim; a row stopped during the head read. All five failed before
    the fix (two payments, or a held row paid).
  - `foreign-code-heal-attempts.test.ts` (real Postgres): a signed record survives the hold, an
    unsigned row gets the reason, a sent row is not touched.
  - Every part, undone on its own, fails a test: 8 mutations.
- **Dependencies:** `@sveltejs/adapter-static` 3.0.10 → 3.0.11 (GHSA-jf9x-2fg2-hx4w: prerendered
  paths read as regular expressions in the route config it writes for Vercel). That config is
  written only when the build runs on Vercel (`VERCEL` set), which a Morphit build never does, so
  the built site is the same. `apps/web/package.json` now requires `^3.0.11`, and the lockfile
  changes only that package.
