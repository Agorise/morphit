# Morphit v1.8.14

## Names and pictures, properly this time

The last release was supposed to stop order cards showing `@username` and a default icon before swapping to the real name and photo. It only half worked — the swap kept happening perhaps half the time, which was the clue: **three separate queries build order listings, and only one of them was fixed.**

The orderbook is live, so listings arrive by more than one route. Those coming through the live feed, and those in the Featured slot, still carried no identity and had to fetch it separately. All three now carry it, so a card is right the moment it appears no matter how it reached you.

## Paying the listing fee with a posting key now works

If you were signed in with your posting key only and chose to pay the fee in BLURT, the page told you it would ask for your Active key when you posted. It never did. You filled in the whole order, pressed **Pay and Post**, and got "The order didn't go through" — with no explanation you could act on.

The prompt existed and worked. An older check ran first and gave up before reaching it, written back when there was nothing to ask with. That check is gone; you're now asked for your Active key exactly as promised, with nothing broadcast and your order untouched behind the dialog. The key signs the fee and is never stored on your device.

**We also removed every claim that Morphit might ask for your Blurt master password.** It never will — there is no situation where Morphit wants it, and five different messages said otherwise.

On phones, that key dialog no longer zooms the page when you tap the field, and your keyboard can no longer capitalise or autocorrect a key into an invalid one.

## The star rating explains itself

Tap the green rating pill anywhere it appears and you get a plain-English explanation of why that number is lower than the plain average of the stars someone received — and what it protects you from.

The short version: it starts everyone near the middle and only lets them climb toward their true average as real trades accumulate. Otherwise two friends could exchange a handful of five-star reviews and instantly look as trustworthy as someone with two hundred genuine trades.

## "Load it now" appears once

The update prompt could show twice in a row on phones. Every previous attempt made the handover wait longer, which narrowed the window without closing it — slower devices simply kept losing the race.

Morphit now remembers that you accepted an update before it reloads, so the same build is never offered twice. A genuinely newer version still prompts as normal.

## For people running a node

**No database changes.** Frontend only — nothing to do beyond the usual upgrade.

Your data, your keys, your trades — all untouched throughout.
