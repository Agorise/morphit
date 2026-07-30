# Morphit v1.7.7

## "I archived it. It came back."

You archived a chat. You refreshed. It was sitting in your inbox again.

The cause turned out to be your computer's clock. Morphit stamped "I filed this at *X*" using your device's clock, then compared that stamp against the message's timestamp from the blockchain — two different clocks, and only one of them is right. If your PC ran even ninety seconds slow, Morphit read your archive as *older* than the message already in the thread, decided something new had arrived, and pulled it back out.

That's why it happened on one machine and not another, on identical code. It was never the browser.

Every one of those comparisons now uses blockchain time on both sides. Your clock can be wrong; your inbox will not be.

## "I clicked archive on twenty threads. Did they all stick?"

Yes — and thank you to whoever asked, because the answer used to be no.

The same clock problem had a nastier version hiding in it. Morphit waits a moment before writing your filing to the chain, so twenty rapid clicks become one write instead of twenty. But while those clicks were waiting, a background sync could look at the chain, see an older state, believe *that* was the newer one — again, because it was comparing two different clocks — and quietly undo the lot.

Fixed. File as fast as you can click; every change lands.

**And if you refresh the tab mid-spree, nothing is lost.** Each click is saved to your device the instant you make it, and the pending write is re-armed when the page comes back.

## "I can't reach the Send button"

On a phone, the **Send BLURT** window was taller than the screen — with no way to scroll to the button at the bottom. You could fill the whole form in and not be able to send it.

It's fixed — and so are the seven other windows that had the same flaw, including **Pay with BLURT** and the warning that appears before you paste a private key. Five more could already scroll but measured the screen in a way that ignores the space behind your phone's address bar, so they could still hide their own bottom edge; those are corrected too.

Every dialog in Morphit now fits your screen and scrolls if it needs to, and there's a check that fails the build if a new one doesn't.

## Chat threads now move where you can see them

Archive a thread, restore one, star one, and the card slides out or in instead of vanishing between blinks. If you've asked your device for reduced motion, it still snaps instantly — Morphit checks.

## Review cards on a phone

Long display names ran off the edge of the card. The `(@username)` in brackets repeated something the card already told you better — your public key is right underneath it, and the name links to your profile — while eating half the width on a narrow screen. It's gone, the name truncates, and the cards are readable again.

## The push notification privacy setting was telling you something untrue

There was a **"Self-hosted only"** option in notification settings, and an FAQ entry promising that with it enabled, "no Google, no Mozilla, no third parties ever see that you received a ping."

That was not true, and could not have been. Web Push endpoints are minted by your browser — Firefox's go to Mozilla, Chrome's go to Google, and no setting in any web app can redirect them. The option was stored and never read by anything.

The setting is gone and the FAQ now describes what actually happens: the push service sees that *an encrypted blob* arrived for an anonymous endpoint. It cannot read it, and Morphit never puts your account name, your counterparty, or your message in one. That was always true — it just wasn't what we'd written down.

If you want push notifications routed through a server you choose, that needs UnifiedPush, which is a real feature and not a checkbox. Ask, and it gets built.

## BasicSwap comparison, updated and trimmed

The FAQ entry comparing Morphit to BasicSwap was long-winded and out of date. It's about 20% shorter and now mentions the exploit BasicSwap suffered on 14 July 2026 — over 0.66 BTC, roughly $42,000, confirmed by the project's own developer and by Orangefren.

We mention it because someone choosing between two ways to trade should know it happened, not to score a point. Atomic swaps remain a beautiful piece of engineering. Morphit has no room to gloat either: we're software, we have bugs. The difference is architectural, not moral — Morphit never holds your coins, so there's no pot to drain — but a bug in our code could still cost you a trade, and we'd rather say so.

## For people who run Blurt RPC nodes

Morphit's indexer now identifies itself:

```
User-Agent: Morphit/1.7.7 (+https://git.agorise.net/agorise/morphit)
```

It used to send `node` — the same string as every anonymous script on the internet, which is exactly what bot-traps are written to catch, and which left you nobody to contact. If our traffic is causing you grief, that URL is where to say so.

## Smaller things

- Long display names now truncate everywhere instead of colliding with the buttons beside them.
- The RPC pool note in Settings said nothing the page didn't already say. Removed.
- Region labels on the post and orderbook pages say what they filter.
- Three documentation errors that would have quietly wasted an operator's afternoon: two environment variables that didn't exist under the names we'd published, and a file path pointing at the wrong directory.

## Under the hood

- A federated instance's server tells your browser when a chat last had a message. Morphit now checks that timestamp is plausible before trusting it. A dishonest operator could previously have used it to make your own messages look already-read — so you'd never see a counterparty's payment arrive.
- Chat filing writes to the chain one at a time now, so a slow write can't overwrite a newer one.
