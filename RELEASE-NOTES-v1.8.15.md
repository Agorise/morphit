# Morphit v1.8.15

## Filter the orderbook

The list of offers can get long. You can now narrow it down — by what's being traded, how much, the price, and how people want to pay — so you see only the offers that match what you're actually looking for.

## See who you're dealing with, right on the offer

Open any offer and there's now a clear card showing **who posted it**: their name and photo, their trust rating, and — in plain terms — what they'll pay you with and what they'll accept in return. No more opening a chat just to find out whether an offer is even relevant to you.

## No false alarm when you chat with a Blurt witness

If you started a chat with certain very active accounts — Blurt's block producers among them — Morphit could wrongly warn that the person's identity might have been tampered with. It was a false alarm caused by how their identity was being looked up, not a real problem, but it was alarming for exactly the wrong reason on a marketplace. It's fixed: the check is now instant and reliable, and the warning only appears if something is genuinely wrong.

## Your Active key, asked for the same friendly way everywhere

Some actions on Blurt need your Active key rather than your posting key. Paying a listing fee already asked for it in one tidy dialog — your key plus, if you want, your Morphit password, with a choice to use it just this once or keep it encrypted on your device.

Now **powering BLURT up or down, and boosting a listing to the top, ask in that exact same way.** Before, if you were signed in with your posting key only, those two actions could quietly dead-end — you'd try, and nothing would happen with no way forward. That's gone; you're asked for your Active key properly, and it's wiped from memory the moment it's used.

## Smaller touches

- Opening a long conversation now shows your most recent messages first, instead of loading a big stretch of old ones you have to scroll past.
- After you set your display name or photo in settings, they appear **immediately** — no refresh needed.
- The green trust-rating pill is now reliably tappable to open its explanation; a card behind it could previously swallow the tap.

## Verify your download — now against the blockchain

Morphit's source code is public and mirrored across independent hosts — our own server, plus **GitHub and Codeberg** — so it stays reachable even if one host is blocked. Every release is signed, and now its fingerprint is also **anchored on the Blurt blockchain**.

That means you can prove a copy you downloaded is the genuine, unmodified release without trusting the site you got it from — the answer comes from the chain. If you cloned the code, `git verify-tag` checks the signature; if you downloaded the release bundle, a small bundled tool cross-checks it against the on-chain record. There's a step-by-step guide in **VERIFY-YOUR-DOWNLOAD.md**.

## For people running a node

**No database changes.** Upgrade as usual — your data, your keys, your trades stay untouched throughout.

The new verify-your-download story applies to the source and the release bundle you deploy; the signing + on-chain anchoring steps are built into the release process, and there's nothing extra you need to run to benefit from them.
