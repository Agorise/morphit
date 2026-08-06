# Morphit v1.4.7

## Your message says "Sent" the moment it goes out

A message you sent could sit on **"Sending…"** for close to a minute — not because it hadn't gone through, but because Morphit was waiting to see its own message come back around before it relaxed. Now, the instant your message is broadcast, the bubble shows a small **✓ Sent** and stops looking busy. It's on its way in a second or two, and you're no longer left staring at a spinner wondering if it worked.

## Chat notifications are on by default

If someone messages you about a trade, you should hear about it. Chat-message notifications are now switched **on by default** for everyone — including folks who set their preferences a while ago and had them off without realizing. You can still turn them off any time in **Settings → Notifications**, and if you already turned them off on purpose, we leave that exactly as you set it.

## Hiding someone now asks first

The little eye icon on an order card hides that person from your orderbook — but a single stray tap used to hide them instantly, and it also quietly hid your chats with them, which was easy to miss. Now it asks you to confirm first and tells you plainly that your chats get tucked away too. Un-hiding is still one tap, no questions asked.

## See all your featured orders in one place

If you've ever paid to feature an order, there's now a tidy **"View prior Featured orders"** link at the top of the *Feature this order* box. It opens a clean list of every order you've featured — newest first — each written in plain language ("I'm buying 40–70 AUD worth of XMR"), with what you paid and whether it's currently showing. The old cramped grey strip is gone.

## Prices in your own currency

When you're featuring an order, the cost preview now shows the fee in **the currency you picked in Settings**, not just US dollars — so "is this worth it?" is an easier question to answer. The little time buttons (6h / 24h / 72h) also give a gentle highlight when you point at them.

## Also in this release

- A new **Contact** link in the footer takes you to the instances page and gently flashes a highlight around the instance you're actually on, so you can find who runs it.
- Powering down your **whole** BLURT balance now works — the "Max" amount no longer rounds a hair *above* what you actually have and gets rejected.
- FAQ search now treats several words as "all of these must appear," so "hive engine" finds entries about *both*, not either.
- Removed a stale "chat with the operator on Matrix" card from the Support page that duplicated what's already on the instance page.

## For operators

- **The RPC-endpoints panel can now actively check your nodes.** The refresh button on *Settings → RPC endpoints* used to just re-show the last passive reading. It now asks the indexer to freshly ping every canonical node on demand. To keep this from becoming a way to hammer your server, the indexer pings the upstream nodes **at most once every 5 seconds** no matter how fast anyone clicks, and — as always — the pinging happens on the indexer, never from the visitor's browser, so a node operator never sees your users' addresses.
- No database changes ship in this release, and nothing here changes the on-chain release format — a build can be rolled back over it safely.
- Note: a small number of chat messages can still take longer than expected to *arrive* for the recipient when the live fast-path stream isn't connected. That path is unchanged in this release; if you're seeing it, check the fast-path status on your indexer's health endpoint.
