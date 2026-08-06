# Morphit v1.8.6

## Your listings really do show up in the marketplace now

The last update promised that a fresh listing would appear in the marketplace the moment it was ready. It turned out that promise wasn't fully kept: a live listing could show correctly on your **My Orders** page yet still be missing from the main **Orderbook** — for you *and* for everyone browsing — with the page saying "No orders match your filters" even though nothing was being filtered.

We tracked it down to the real cause. The marketplace has two ways of delivering listings to your screen — a first quick load, and a live feed that keeps things fresh — and the live feed was leaving off one small label that the page uses to decide a listing is active. Without that label, the page quietly hid every listing the live feed sent. A fix a few versions ago added the label to the first quick load but missed the live feed; this release adds it there too, so both paths agree.

The upshot: post a listing, and it appears in the Orderbook and stays there — reliably, on desktop and phone. And we've added a guard so these two delivery paths can never drift apart on this again.

## A quiet security update

We refreshed one of the behind-the-scenes building blocks Morphit relies on to close a newly-reported weakness in it. Nothing about how you use Morphit changes — this is pure housekeeping to keep the foundations sound.

Your data, your keys, your trades — all untouched throughout.
