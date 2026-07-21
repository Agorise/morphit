# Morphit v1.8.7

## New messages show up in your inbox right away

When someone started a new conversation with you, the alert was instant — the notification and the little green badges lit up within a few seconds — but the message card itself could take about a minute to actually appear in your **Chat** inbox. You'd go looking for the message and find nothing there yet.

This release closes that gap. The moment the alert arrives, the conversation now appears in your inbox too, on the same few-second timescale — no waiting, no refreshing. Behind the scenes, the inbox was preparing an instant placeholder card for exactly this, but a tiny mismatch meant it always came up empty; that's now fixed, and pinned with a test so it can't quietly break again.

## No more repeated pop-ups while you're chatting

Once two people are actively in the same chatroom, every new message was still triggering a system notification — a little pop-up for a message you're already looking at. Annoying, and pointless.

Now, while you're both viewing the same conversation, those redundant pop-ups stay quiet. You'll still get notified about messages from *other* people, and about everything else — this only silences the buzz for the chat that's already open on your screen.

## The "Leave feedback" line tells the truth instantly

After a trade wrapped up and you left your trading partner a rating in the chatroom, going back to your inbox could still show that conversation's third line as the green **Leave feedback** prompt — as if you hadn't. The stars only appeared a while later.

Now the line updates the instant your rating is on-chain: no refresh, and no matter how fast you click back to the inbox, it shows the green stars you just left.

## The scary red banner stops flashing during updates

Some phones and computers were seeing an alarming red **"Build integrity check failed"** banner during a routine update — and it could appear *before* the friendly "Load it now" prompt that lets you pick up the latest version. That warning is meant only for a genuinely tampered page, not for the brief moment while a new version is landing.

This release holds that banner back while an update is on its way and gives the friendly prompt time to lead, so a normal upgrade no longer sets off the alarm. The real tamper protection is unchanged — it still speaks up if a settled page ever truly doesn't match what was published.

## A small wording fix

The green hint under the amount field in the **Pay now** window read "Orders minimum is …" — it now correctly reads "Order minimum is …".

Your data, your keys, your trades — all untouched throughout.
