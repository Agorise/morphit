# Morphit v1.8.1

## The stray text at the top of the page

For a short while, some pages showed a line of raw developer notes stuck across the very top — something about link previews and JavaScript hydration that was never meant for human eyes. If you saw it, thank you for the double-take; it was as wrong as it looked.

Here is what happened. There is an internal note inside the site's HTML explaining how Morphit builds link-preview cards. That note mentioned the *name* of a SvelteKit placeholder — and SvelteKit, doing exactly what it is designed to do, found that name inside the note and swapped in the live page's head content. Modern Svelte wraps that content in tiny hydration markers, and one of them happened to end the comment early — so the second half of the note spilled out onto the page.

The note now describes the placeholder in plain words instead of naming it, so there is nothing left for SvelteKit to swap. And there is a new build check that fails immediately if anyone ever writes one of those placeholder names inside a comment again, so this exact mistake cannot come back.

## The "Build integrity check failed" banner during updates

A scary red banner sometimes flashed at the bottom of the screen while an instance was being updated. It was a real safety check — it watches whether the code your browser is running matches what the operator published on-chain — but it was firing at the wrong moment. During an update the server briefly serves the new build before the on-chain record catches up, so for a few seconds the two legitimately disagree, and the check cried wolf. It now stays quiet whenever the served version and the published version differ (an update in progress), and only speaks up for a genuine mismatch at the same version. Real tamper detection is untouched; the false alarm on every update is gone.

## Messages and orders that lagged behind

Some instances could fall behind the blockchain — new messages and orders taking a long time to appear, or not appearing until later. The cause was outside Morphit: several public Blurt RPC nodes run firewalls that reject the efficient "batched" way Morphit asks for many blocks at once, while happily answering one block at a time. Morphit now detects that rejection and automatically falls back to one-at-a-time requests on those nodes, so a single strict node can no longer stall an instance. Operators get the full node list working again with no manual node-picking.

Your data, your keys, your trades — all untouched throughout.

