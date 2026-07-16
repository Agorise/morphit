# Morphit v1.7.0

## "I just paid, and my order doesn't exist."

If you posted an order and clicked **View my order**, Morphit told you your order wasn't there.

Not sometimes. Every time.

Here's what was happening. Your order went onto the blockchain in about three seconds, exactly as it should. But the part of Morphit that reads the blockchain deliberately waits until a block can never be undone before trusting it — and on Blurt that takes about a minute. So for that minute, the order was real, it was paid for, it was on the chain — and Morphit's own database hadn't heard of it yet.

The page waited 24 seconds and then gave up and said **"Order not found."**

That's fixed, and not by waiting longer. Waiting longer would only have swapped a scary message for a minute and a half of spinner. Your browser already *knows* about the order — it's the thing that signed it and sent it. So now it just shows you. Instantly. There's nothing to wait for.

## Everything you do now shows up immediately

The same fix applies across the app. When you do something, you see it:

- **Post an order** — it's there, right away.
- **Cancel or complete an order** — the card and the tab counts update on the spot.
- **Edit your profile** — see below; this one was its own bug.
- **Reply to someone's review** — your reply appears where it belongs.
- **Watch an order someone else posted** — if they cancel or complete it while you're reading, the page tells you within a few seconds instead of leaving you looking at a listing that's already gone.

Chat and notifications were already fast. They stay fast.

## "I saved it, and it reverted"

If you changed your display name or avatar in Settings, it worked — and then about twelve seconds later it changed back to the old one.

Morphit was protecting your edit from being overwritten while the blockchain caught up. That protection lasted twelve seconds. Catching up takes about a minute. So the shield dropped roughly forty seconds too early, and the stale copy won.

Your edit sticks now.

## When something says "confirming", we mean it

There's a line we're not going to cross to make things feel fast.

Your **trade count** and your **review score** still wait for the blockchain to make it permanent. So do listing fees. Those are the numbers people decide whether to trust you on, and a number that might quietly change its mind an hour later is worse than a number that took a minute to arrive.

So Morphit tells you which one you're looking at. A brand-new order of yours shows a **"Confirming on the blockchain"** tag until it's settled. An order that just disappeared from the listings says **"No longer available — confirming"** — and notably it does *not* guess whether it was cancelled or completed, because at that moment we honestly don't know yet.

You get feedback in seconds. You get finality when the chain says so. You're always told which.

## Your order still isn't public until the fee is paid

Worth being plain about this, because it's the one thing that *didn't* get faster and shouldn't.

Your own order appears to you instantly. Strangers browsing the orderbook still don't see it until the block is permanent and your listing fee has been verified — about a minute.

We could have made new orders show up in everyone's orderbook in seconds. We're not going to. It would mean anyone could fill the orderbook with orders they never paid for, over and over, a minute at a time. We'd rather show a stranger nothing than show them a listing that isn't paid for and might vanish.

## The block explorer was already fast

We checked. The explorer reads the blockchain directly rather than going through Morphit's database, so it was never affected by any of this.

## Small print

The honest bit: four separate parts of Morphit had each been built around the same wrong number. Somebody reasoned that the database would catch up in "one or two blocks" — about three to six seconds — and wrote that assumption into a timeout. It's actually forty-five to sixty-three seconds. Every one of those timeouts expired before the answer could possibly have arrived, and each one then produced the exact problem it had been written to prevent.

The parts of the code that had *measured* the delay instead of reasoning about it got it right, and had been right all along.

We also found that our own brag list claimed new orders show up in the orderbook in three seconds. They don't and never did. It's fixed.
