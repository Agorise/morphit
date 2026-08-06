# Morphit v1.7.5

## "A message came in and nothing lit up"

Someone messaged you. The badge stayed dark for a minute. Then the message turned up in **Archived** instead of your inbox.

Both symptoms, one cause, and it was a good one. Morphit has a fast path that lights the badge the instant a message lands — and it had been dead code in production the whole time. The notification your browser received was labelled one way and read another way, so every message fell into the gap and quietly waited for the slow, once-a-minute check to notice it.

It's fixed. Badges light within a couple of seconds now, the way they were always supposed to.

If you had the tab closed when the message arrived, you'll see the badge as soon as you open it — Morphit now replays the last few minutes of activity on connect, using the message's real arrival time, so a message you already read doesn't come back pretending to be new.

## "I answered them on my laptop. My phone still says unread."

Because it genuinely didn't know. Morphit tracked what *this device* had seen, but not *who spoke last* — so your own reply, sent from your laptop, looked exactly like an unread message when your phone looked at it.

Your phone now knows the last word was yours, and stays quiet.

## Chat cards on a phone

Four lines of wrapped name, squeezed into a card with barely room for anything else. The name now truncates properly and the spacing is tuned for a narrow screen — the same cards are about 40% taller on a 360px phone, with the same information in them. Nothing changes on desktop.

## Order cards

- The **rating** now comes first, with the trade count next to it in smaller text.
- The rating chip is as bright as everything else on the card. One thing genuinely was dimmed; it isn't now.
- **"1 trade"** instead of "1 trades". Languages with more than two plural forms — Polish and Russian — get all of theirs, properly.
- Hovering **Expires** used to say when the order was last *touched*, which could be hours after you posted it. It now says when it was **posted**, because that's what it looked like it was saying.

## Chat header

The star next to someone's name was hand-drawn in two places instead of using the component every other card uses — which is exactly why it was gold when it should have been green, and why it showed a score with no idea how many people it came from. It now uses the same component as everywhere else, so it looks the same and says the same thing. The avatar sits properly centred.

## We're easier on the volunteers who run Blurt

The public Blurt nodes are run by people, for free, and Morphit leans on them. One of them asked us for four things. This release finishes the list.

When a Morphit node has been offline and needs to catch up, it used to ask for blocks one HTTP request at a time — thousands of them, as fast as it could, from every Morphit instance at once. That's what earned us a rate-limit. It now asks for twenty blocks per request. A five-thousand-block backlog went from 5,000 requests to 250.

Nodes that don't support batching aren't asked twice, and aren't penalised for it — they just get the old path, at the old polite pace.

You don't configure any of this. It's listed here so you know what your node does on your behalf.

## Your IP address, honestly

Morphit never sees or logs your IP. No cookies, no analytics, no trackers, no telemetry.

There is exactly one exception, and we chose it on purpose: once per session your browser asks a network node directly for the signed record that says which version of Morphit is current. That's how your browser can tell you if the operator serving you this page has quietly given you a stale or tampered build — a check that's worthless if we route it through the operator we're checking.

We'd already written this down in three places on the site, and in all three we'd written it down **wrong** — including on the very page that lists those nodes, which told you your browser never talks to them. It does. All three are corrected, and there's now a FAQ entry that explains exactly what happens, why we chose it, what that node learns (an IP, and nothing that identifies you), and what to do about it.

Short version: use Tor or a VPN. If you're here for Monero you almost certainly already do, and if so this is already closed for you.

## Settings

- The display-name card lost a paragraph explaining the two Save buttons. The buttons say what they do.
- The two **Clear** buttons on **Display name** and **Short bio** are gone. Delete the text and Save — same result, one less button.

## Smaller things

- Monero's description now mentions that it hides **balances** too, not just amounts, senders and recipients.
- One outbound link on the instance page was leaking a referrer. It isn't now.

---

## For operators

**Upgrading is one command and there is no database migration in this release.**

The Ansible playbook now ends with a loud warning if your node has no alerting configured. It's off by default because it needs a Matrix access token we can't generate for you — but a green Ansible run is exactly when people stop reading, so if your node is silent, that's the last thing you'll see, along with the six steps to fix it.

Being unmonitored should be a choice you made, not one you defaulted into.

Block catch-up is batched (see above). Nothing to configure. If you want to confirm it's working, watch the request rate against a node during a catch-up — batching is doing its job if it's roughly a twentieth of the block rate.

`docs/OPERATIONS.md` and `docs/RUN-A-MORPHIT-NODE.md` both cover the new behaviour.
