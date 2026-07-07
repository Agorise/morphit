# Blurt chain model — how transactions are paid for

> **Read this before touching anything in `apps/web/src/lib/blurt/` or writing
> any doc/comment about transaction costs.** Blurt is a Steem/Hive *fork*, but
> it deliberately changed the economics. Conflating Blurt with Hive/Steem here
> has caused repeated wrong diagnoses (e.g. blaming "insufficient mana" for a
> failed transfer). This document is the single source of truth.

## The one thing to remember

**Blurt does NOT gate on-chain operations on RC / mana / bandwidth.**
Blurt charges a small **per-operation fee, paid from your LIQUID BLURT
balance.** That's it.

| | Hive / Steem | **Blurt** |
|---|---|---|
| What lets you transact | Resource Credits (RC), derived from staked HP/SP; regenerate over ~5 days; run out → tx **rejected** | A small **BLURT fee** per operation, taken from your liquid balance |
| Role of "mana" | Gates BOTH voting AND (via RC) all transactions | **Voting only** — a vote "energy bar" that recharges ~20%/day. Never blocks a transfer/power-up. |
| Fee on a normal transfer | none (RC only) | a small BLURT fee (visible before you sign) |

Source: the Blurt wallet FAQ (blurtwallet.com/faq) — "some BLURT is always
necessary to pay the small transaction fees"; "Voting mana … Every time you
**vote**, you will use a small amount of your voting mana." And the Blurt
whitepaper/repo: "While many Graphene-based chains offer 'free' transactions
via resource credits, Blurt implemented a nominal fee for operations."

## How the fee is computed and applied

The fee is a **chain-level deduction**, not a field in the operation body.
The Blurt `transfer` / `transfer_to_vesting` op bodies are exactly
`{from, to, amount, memo}` / `{from, to, amount}` — there is **no fee field to
set** (confirmed in `@beblurt/dblurt`'s `TransferOperation` /
`TransferToVestingOperation` types). When the chain applies the op, it deducts
a fee derived from two witness-set chain properties:

- `operation_flat_fee` — a flat BLURT charge per operation, and
- `bandwidth_kbytes_fee` — a BLURT charge scaled by the serialized tx size.

Both are readable from the chain properties (`@beblurt/dblurt` `misc.d.ts`).
The payer just needs enough **liquid BLURT** to cover `amount + fee`. Account
creation is likewise a **fee** (`account_creation_fee`, ~100 BLURT), not an RC
cost.

## What this means for diagnosing a failed transfer / power-up

If a `transfer` or `transfer_to_vesting` (power-up) fails on Blurt, the cause
is **never** "insufficient mana." A wallet with ample liquid BLURT can always
pay the tiny op fee. Look instead at the **real chain assertion**, which
Morphit surfaces via `ChainRejectedError` (`broadcastTransport.ts`) and the
`profile.wallet.error_chain_rejected` message:

- missing/incorrect **active authority** (wrong key, or a posting-only session
  trying an active-level op),
- **expired transaction** (the 60 s expiration window elapsed before broadcast),
- **malformed operation** (bad amount string, self-transfer where disallowed),
- **insufficient liquid balance** for `amount + fee` (only near a full-balance
  send/power-up, since the fee is on top of the amount),
- a node/RPC problem (surfaced as `BroadcastUnavailableError`).

So the fix for a confusing failure is to **show the chain's real reason** and
read it — not to assume a resource limit. Powering up more BLURT does **not**
"unlock" the ability to transact on Blurt (it only increases voting power +
APR); a low-BP account with liquid BLURT transacts fine.

## Where mana *does* matter on Blurt

Only for **voting weight**. A vote cast at 50% voting mana counts half as much
as one at 100%; mana recharges ~20%/day. This is the *only* place a Morphit
feature would ever need to reason about Blurt mana, and Morphit does not cast
votes, so it effectively never does.

## If you find RC/mana language elsewhere in the repo

Older docs (some `docs/PHASE-3a-*`, audit notes, an OPERATIONS troubleshooting
line) were written with the Hive/Steem RC model in mind and are **wrong** for
Blurt on this point. Correct them toward this document when you touch them; do
not propagate "Blurt RC cost" / "low on mana → tx fails" phrasings.
