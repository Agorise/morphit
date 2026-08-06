# Morphit v1.9.1

## Every Morphit site now helps host Morphit itself

Morphit's whole point is that no single company can switch it off. This release takes that one step further: every Morphit instance now pins the exact, GPG-signed release to **IPFS** — the peer-to-peer file network — so the app's own download stays reachable even if the main site is ever blocked or goes offline. Operators keep 90% of the listing fees, so it's only fair they help carry the app, and it's on by default (with a one-line opt-out for anyone who'd rather not). The bytes are pinned *by content address*, so every instance serves the identical, verifiable copy — and you can check any download against the hash and IPFS address that Morphit itself published on the blockchain. It's the same idea as the mirrors, made trustless.

## A clearer "expires in" on every order

The little countdown on each order used to read something like "Expires in 87d 7h" — and because every listing's deadline is deliberately rounded to the end of a day (so it can't leak the exact minute you posted), that extra "7h" was really just "time until midnight" and looked identical on every card. It now simply reads **"Expires in 88d"**, matching the date you already see when you hover, and a fresh 90-day listing reads "90d" like you'd expect. In the final day it still counts down in hours, minutes, and seconds so a closing deadline feels alive.

## Name your barter in your own words — now with spaces

When you post a barter order and type what you're offering, you can now use more than one word: **banana trees**, *garden help*, *homemade bread* all work, not just single words. And the wording lines up everywhere — the summary, your order's page, and the blog announcement all now read the same natural way, for example **"I want to sell banana trees for Monero"** or **"I want to buy up to 30 MXN of banana trees"** — matching the "I want to buy / I want to sell" you picked at the start. The inline field also sits properly on the line now, and its underline is a quiet neutral instead of a bright green while you type.

## Operators and instances now point to each other

The **Operators** page and the **Instances** page are two sides of the same story — who runs Morphit, and where you can reach it — so each now links straight to the other right in its opening line. One tap to go from "who's running these" to "here's the live list," and back.

## Smaller touches

- **Refreshed link preview.** The image that appears when you share a Morphit link in a chat app or on social media has been redrawn at the proper size, so the preview looks crisp everywhere.
