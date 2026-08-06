# Morphit v1.5.6

## Your trade count now actually shows up on the orderbook

v1.5.5 introduced real trade counts — a completed trade counts as a trade, both people get credit, and your card reads **"1 trade · ★5.00 (34)"**. That worked on your own **My orders** page and on a trader's profile.

It did not work on the two places most people actually look: the **orderbook** and the **featured orders** on the front page. Those cards showed no trade count at all.

The orderbook was the stranger case. It fetched your card *correctly*, drew it, and then — a moment later, when the live-updating connection kicked in — replaced it with a version that had no trade count. So the number was right for a fraction of a second and then quietly vanished. Every card, every time.

Both are fixed. Trade counts now appear everywhere an order card appears, and they stay.

## The 🌱 new trader sprout was pointing the wrong way

On those same two surfaces, the sprout was still working off your **review** count instead of your **trade** count — the very thing v1.5.5 set out to separate. In practice that meant it was **backwards**:

- Someone with **5 completed trades and no reviews** got labelled **🌱 new trader**.
- Someone with **no completed trades and 9 reviews** did **not**.

On the orderbook you'd even watch it flip: no sprout on load, then a sprout a second later when the live connection replaced the card.

The sprout now means what it says — fewer than 4 **completed trades** — on every card, everywhere, consistently.

## The "minimum trades" filter agrees with the card again

Filtering the orderbook by minimum trades was matching on **reviews**, not trades. So the same filter could show you a different set of traders depending on the exact moment you looked — and could hide a trader whose card said "5 trades" because they only had 2 reviews.

It now filters on real completed trades, matching the number printed on the card.

## Why you may have seen none of this

Nothing here was broken in a way that produces an error message. A missing trade count doesn't fail — it just renders as though the trader had never traded. That's precisely why it survived a release: everything looked fine, it was simply telling you the wrong thing.

## For operators

- **No database migration.** No schema change, no on-chain format change — v1.5.6 is backward-compatible in both directions, and a federated instance still on v1.5.5 keeps working (its cards simply show no trade count, as they do today).
- **The front page got a little cheaper, not dearer.** The featured-orders endpoint is polled by every visitor, so its new trade-count lookup is scoped to just the handful of accounts holding featured slots rather than tallying every completed trade on the instance.
- **One wasted query removed.** `/v1/orders/:account` was still computing a full sock-puppet-filtered review tally on every request and then discarding it — a leftover from v1.5.5. It's gone.
