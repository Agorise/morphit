# Morphit v1.21.16

**The chat's buttons say what they do, and name the coin.** The button at the bottom of a trade chat used to
read "Pay now" or "Share crypto address" whatever the trade was. Now it names the coin the order is about:

- If you are the one who sends the coin, it reads **Send BLURT**, **Send XMR**, **Send BTC** and so on.
- If you are the one who receives it, it reads **Share your XMR address** (or BTC, LTC…), and for BLURT, which
  arrives at an account rather than an address, **Share your Blurt account**.
- A goods-and-services order that accepts one coin names that coin too, and when that coin is BLURT, "Send BLURT"
  sends it from the app like on a BLURT order (before, it asked you to paste a transaction id). One that accepts
  several coins keeps "Pay now" and "Share crypto address", since the coin is chosen in the next step.

The "Share your … address" window now offers only the order's coin, so you cannot share an address for a
different coin by mistake. The BLURT button on a shared Blurt account in the conversation reads "Send BLURT" as
well.

**The chat's subject line reads from your side.** Both people used to see the same "RE: I'm buying …" at the top of
the chat, which on the other side read as if they were the buyer. Now the person who posted the order sees
"Regarding my order: I'm buying at least 25 BRL of BLURT with XMR or BTC", and the other person sees "Regarding
@alice's order: Buying at least 25 BRL of BLURT with XMR or BTC". The inbox shows each order the same way:
yours as "I'm buying …", the other person's as "Buying …". A chat saved as a PDF heads the order's messages with
the same line.

**The buttons fit a phone.** On a phone the buttons at the bottom of a chat are full width, one under the other,
and tall enough to tap comfortably; the order's title gets its own line under "Regarding …". On a wider screen
they sit side by side as before.

The help pages and their translations use the new button names.

**For node operators: stopping a snapshot download always says so.** When a snapshot download (fast-sync) was
stopped with Ctrl+C, a closed terminal or `kill` on the whole process, it could, depending on timing, report "every
source failed" and try the next source instead of stopping with "Nothing was changed". It now always stops.
