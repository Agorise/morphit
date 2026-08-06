# Morphit merchant QR kit

A tiny, no-nonsense kit for shop owners and webmasters who want to put a
**Morphit-scannable QR code** on a storefront window, a receipt, a business
card, or a website.

Everything here is static: a QR code is just an image that encodes a short
piece of text. There is no tracking, no script to embed, and nothing phones
home. You generate the image once and host it yourself.

---

## Which QR do you want?

There are two useful kinds. Pick one, or print both.

### 1. Storefront QR — "find me on Morphit" (works with any phone camera)

Encodes your public Morphit page:

```
https://morphit.io/@YOUR-ACCOUNT
```

Anyone who points a normal phone camera at it lands on your Morphit page,
where they can see your live offers and start a trade or a chat. This is the
one to use if you're not sure — every phone can open a link.

Replace `morphit.io` with your own instance's domain if you run your own
Morphit node, and `YOUR-ACCOUNT` with your Blurt account name (no `@`).

### 2. Payment QR — "pay me in BLURT" (works with the Blurt wallet's scanner)

Encodes just your account name:

```
YOUR-ACCOUNT
```

The Blurt wallet's built-in QR scanner (and Morphit's own in-app scanner) read
this to pre-fill **you** as the payment recipient, so a customer can send you
BLURT without typing your name. The amount is never baked into the code — the
payer always sets and confirms it themselves, so a QR on a wall can't trick
anyone into overpaying.

> A bare name looks like plain text to a normal camera app, so only use this
> one where you know the customer will scan it *with a wallet*. For a
> general-purpose code, use the storefront QR above. Some wallets also accept
> the `blurt:YOUR-ACCOUNT` form — both resolve to the same account.

---

## Making the image

You only need the QR image once. Two ways, pick whichever is easier for you.

### Option A — any QR generator you already trust

Open your favourite offline/open-source QR tool and paste in the exact text
from the section above (the full `https://…` link for a storefront QR, or the
bare account name for a payment QR). Save it as SVG (sharpest — scales to any
size) or a high-resolution PNG. That's it.

### Option B — the included generator (needs Node.js)

`generate-qr.mjs` produces a clean SVG using the same QR library Morphit
itself uses. From a checkout of the Morphit repo (where dependencies are
already installed), or after a one-time `npm install qrcode`:

```sh
# Storefront QR → morphit-qr-alice.svg  (encodes https://morphit.io/@alice)
node generate-qr.mjs alice

# Own instance instead of morphit.io
node generate-qr.mjs alice example.org

# Payment QR → morphit-pay-alice.svg  (encodes the bare account "alice")
node generate-qr.mjs alice --pay
```

---

## Putting it on your site

`storefront-badge.html` is a self-contained, copy-paste block: a framed QR
with the Morphit mark and a "Scan to trade on Morphit" caption. It has no
external fonts, scripts, or trackers — just inline HTML and CSS you can drop
straight into a page or a page builder.

1. Generate your QR image (above) and put it next to the HTML, or update the
   `<img src="…">` to wherever you host it.
2. Change `alice` / `@alice` in the file to your own account.
3. Paste the block into your page.

Prefer to build your own layout? The only things that matter are:

- Keep the QR at least **2 cm / ~120 px** on screen, on a light background
  with clear quiet space around it, so cameras lock on quickly.
- Add a short caption so people know what it's for — e.g. *"Scan to trade on
  Morphit"* or *"Pay me in BLURT — scan with your Blurt wallet."*
- Link the whole thing to your Morphit page as a fallback for anyone reading
  on the same device they'd scan with.

## Files in this kit

- `README.md` — this guide.
- `generate-qr.mjs` — optional Node generator for the QR SVG.
- `storefront-badge.html` — a ready-to-paste, dependency-free QR badge.
- `morphit-mark.svg` — the Morphit logo mark, for the badge or your own layout.

## A note on brand + trust

Morphit is a federated, non-custodial, no-KYC marketplace. Anyone can run a
node, so a Morphit link points at whichever instance you choose to host it on.
Use your real account name and your real instance domain so customers can
verify they've reached the right place — the QR is only ever a shortcut to a
link they can also read and check by eye.
