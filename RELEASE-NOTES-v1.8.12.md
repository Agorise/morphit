# Morphit v1.8.12

## Names and pictures show up when they should

Display names and avatars were sometimes missing — a row would show the default heart icon instead of someone's photo, and refreshing the page fixed it. That shouldn't have been necessary, and now it isn't.

When Morphit asks the server who someone is, two different answers can come back empty: *"this person has no picture"* and *"the request failed."* Morphit already told those apart, and deliberately remembered a failure for only a few seconds so it could try again shortly. The catch was that nothing ever did try again — pages only ask once when they load. So the short memory expired into silence and the row kept its placeholder until you navigated away.

Pages now ask again after a failed attempt, and only after a failed one. Someone who genuinely has no picture still settles on their icon straight away, without pointless retries.

## A trader's reputation can be restored again

If Morphit's self-dealing checks flag two accounts, their reviews stop counting toward each other's score. That's deliberate. But of the four checks that can do this, only two were ever shown to the person running the node — and only those two could be undone.

The other two were invisible *and* permanent. A false positive suppressed a reputation forever: you couldn't see which check had fired, deleting the record by hand didn't help because the detector simply recreated it, and the database itself refused to record the decision. Every part of the system agreed on the same blind spot.

All four checks are now visible, clearable, and stay cleared. As with the existing behaviour-based check, clearing forgives what's already happened without going blind to what happens next — if the pattern genuinely resumes, it's caught again.

## Reviews that don't count now say so

A profile could show reviews that quietly contributed nothing to the score, with nothing on screen explaining why. Two causes: reviews from an account flagged by one particular check weren't marked, and reviews not linked to any order weren't either.

Keeping both out of the score is correct — a review tied to no trade can't be checked against anything, and counting it would let anyone inflate their own reputation. The problem was the silence. Such reviews are now marked, so what you see and what the score says finally agree.

## Contacting a trader

The **Message** button was hidden from anyone not signed in — so a visitor browsing the orderbook saw plenty of offers and no way to start. Clicking it now takes you to sign-in and returns you straight to that conversation. It's still hidden on your own orders, since you can't message yourself.

## More of your post reward arrives as liquid BLURT

When Morphit publishes on your behalf, it now asks the blockchain to pay your share as liquid BLURT rather than the default mix of liquid and Blurt Power. The request is sent separately from the post itself, so if the chain ever declines it your post is completely unaffected — it simply pays out the usual way.

Nothing goes to the Morphit community from these posts. It never did, and that hasn't changed.

## Fixes

- **Importing an old key** now confirms which account it recognised. If Morphit works out your account from the key alone, it says so instead of leaving the screen looking stalled with no username field and no explanation.
- **Two settings cards** had their heading and privacy label overlapping into unreadable text.
- **A profile's headline number** is now labelled when it's showing a plain average rather than the full score, so two profiles are never quietly measuring different things.

## For people running a node

**One database change**, applied automatically on upgrade: the table recording moderation decisions now accepts all four self-dealing checks rather than two. Fresh installations get the same thing.

If you've been unable to restore someone's reputation despite clearing their flags, this is why — and `morphit-ops moderation` will now show you what was previously hidden. It also warns when flags exist outside the window you're looking at, since suppression itself has no time limit.

Your data, your keys, your trades — all untouched throughout.
