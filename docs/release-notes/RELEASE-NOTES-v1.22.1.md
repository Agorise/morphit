# Morphit v1.22.1

A fix release for servers: the two problems left open in v1.22.0, and chain replies that were
downloaded several times. Nothing changes for people using the site, and nothing about fees,
prices or trades changes.

## For operators

**The fee re-check now judges every fee as the indexer judged it when it came in.** Since
v1.20.0 an indexer checks some BLURT fees a second time, from the chain: orders it stored as
underpaid and first-contact (stranger) fees it rejected, when they were paid through another
instance. It does this so that an instance that judged them before it knew the other
instance's fees account still ends up agreeing with everyone else. That second check read the
user's other orders and fees as they are NOW, not as they were at the fee's place in the
chain:

- an order the user ended in the same block as a new one did not count toward the new
  order's listing tier, though it counted when the order came in: the tier came out one too
  low, and an order that paid too little could be shown;
- an order ended before the new one but changed later (for example, its trade partner named
  afterwards) counted as if still open: the tier came out one too high, and an order that
  paid in full could stay hidden;
- a first-contact fee that paid too little was marked as paid when the user paid for the
  same person later;
- a first-contact fee paid later in the same block raised the price of an earlier one, and
  fees were re-checked newest first, so a fee could be priced without an earlier one that
  was still waiting for its own check;
- when the check found a first-contact fee paid after all, and the same person had been paid
  for again later, the record of the payment stayed with the later fee, so the fees in
  between were priced as if the earlier one had not been paid;
- first-contact fees older than 30 days were never checked, so whether one was depended on
  when an instance upgraded.

The result also depended on when an instance happened to run its check, so two instances
could disagree. Now every fee is judged as of its own place in the chain, with the same
counting the upgrade replay uses since v1.22.0. First-contact fees are re-checked in chain
order, at any age, and a sender's later fee waits while an earlier one cannot be checked
yet; the record of a payment moves to the earliest fee that paid it. A fee whose check keeps
failing no longer holds up other people's fees.

After the upgrade, results of the old check that the new one can correct are checked again,
once: an order it left hidden, a first-contact fee it left rejected, and a first-contact fee
it marked as paid only because of a later payment (that one goes back to rejected; the
person stays reachable through the later payment). The last kind is found from the chain
data itself, so an instance restored from another one's snapshot finds it too. Two things
the old check did cannot be taken back: an order it wrongly showed stays shown (the payer's
loyalty credit, and any payout it led to, followed at once), and a first-contact fee it
wrongly accepted stays accepted (the person has been reachable since). Both need unusual
timing (an order ended in the same block as a new one paid at the lower tier; two
first-contact fees within five minutes, re-checked in the wrong order), so they are rare.

The new rule applies at once, with no switch-over date. An instance that has not upgraded
keeps the old check for fees re-checked meanwhile, and corrects what it can once it upgrades.

**A lost database connection no longer stops the indexer or the relay.** When PostgreSQL
restarted, or the connection dropped, while the indexer or the relay was between two steps
of a transaction (waiting on the chain, for example), Node stopped the whole process. Nothing
was lost: nothing had been committed and systemd started it again. Now only that transaction
fails, the usual retry follows, and the broken connection is closed instead of being reused.
This includes a connection that dies the moment it is handed out. The error the transaction
fails with now carries the connection's own error as its cause, and the journal shows
`checked_out_client_error`. `morphit-ops upgrade` no longer stops either when its check of
the database role loses its connection (a reset, or a backend killed): the check reports the
failure.

**A chain reply is downloaded once.** The library the indexer and the relay read the chain with
gives each try 500 ms, then 1 s, then 1.5 s and so on, to get a first answer from the node, and
asks again when the time runs out. Since every reply has been checked for its size before it is
used, that time limit also ran over the download of the whole reply: a reply that took longer
than half a second to arrive was cut off and asked for again, and one that took a few seconds
(a long account history, a 100-account batch from a distant or busy node) was downloaded
several times and could fail at the end. Now the limit stops once the node has started to
answer, as the library meant, and every reply is downloaded once; its size limit still applies.
This is also what turned the CI smoke suite red: `rpc-reply-budget-smoke` counted the extra
requests.

Upgrade as usual.

## For developers

- `blurtFeeReverify.ts`: the Sybil tier comes from `countForSybilTierAtPosition` (shared with
  the upgrade replay); `countForSybilTierAsOf` is gone. Stranger fees are re-run with
  `judgedOutOfOrder: true`, so the handler's "pair already paid" check and the escalating
  price (`getStrangerFeeQuote(…, before)`, `strangerFeeRowBefore`) see only fees whose op came
  before. Candidates in chain order. Outcomes in `fee_reverify_done` have new spellings
  (`underpaid_as_of_position`, `applied_as_of_position`, `rejected_as_of_position:…`,
  `unapplied_as_of_position:…`); the old rule's `still_underpaid` and `still_rejected:…` are
  re-judged once (the row is updated in place). A stranger fee that is applied with no
  `stranger_fees` row of its own or from before it is a candidate whatever the bookkeeping
  says. When a fee judged out of order is valid and the pair's row is a later fee's, the
  handler moves the row to it. No 30-day window for stranger fees; a sender's fees wait
  behind an earlier one that could not be judged; ops given up on are left out of the
  selection; a throw while judging counts as a failure of that op. No schema change.
- `db/pool.ts` (indexer and relay): the listener is attached in pg-pool's `connect`
  callback, so no 'error' can fall between the hand-out and the listener; a checked-out
  client keeps it until released, a client that reported an error is released with it (so
  the pool drops it), and `withTx` sets that error as the `cause` of the one it rethrows.
  The relay's `connect()` does the same through the client's `release`. ops-cli
  `pgRoleHeal.ts`: its `pg.Client` has an `'error'` listener.
- `@morphit/hidden-transport/rpc-fetch`: `guardedRpcFetch(base, max, { signalUntilHeaders })`.
  The global wrapper behind `guardDblurtClient` sets it: dblurt's per-attempt `AbortSignal`
  (500 ms × (attempt + 1)) can abort a request only until its headers arrive, as it did before
  the guard read the body inside `fetch`. Direct callers that pass their own deadline keep it
  over the whole reply. `rpc-reply-budget-smoke` now serialises its replies before they are
  asked for, checks that every reply is requested once, and adds a node whose body arrives
  after 2 s (asked five times before) and two checks of the signal's scope.
- New tests: `test/integration/blurt-fee-reverify-as-of-position.test.ts` (20),
  `db-pools.test.ts` (+3), relay `test/dbPoolLostConnection.test.ts` (4), ops-cli
  `test/pgRoleHealLostConnection.test.ts` (2). They wait on the connection's own events
  (`'end'`, the socket's `'close'`), not on timers.
- ops-cli test network guard (`test/setup/noInternet.ts`): a test's `net.connect(port, name)`
  to a name (CI's `postgres`) failed with `ERR_MISSING_ARGS`, because the guard's copy of
  net's already normalised arguments lost their mark. The copy keeps it now
  (`noInternetGuard.test.ts`, +1). The drop test also checks that the statement reached the
  proxy, so a proxy that cannot reach Postgres fails the test instead of passing it.
