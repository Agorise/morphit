# Morphit v1.8.8

## No more pop-ups from the person you're already talking to

We thought we'd fixed this last release. We hadn't — not fully. If you and someone else were chatting back and forth, every single reply was still raising a system notification, for a message you were sitting there watching arrive.

The remaining cause was a check that only counted you as "looking at the conversation" if that exact window was the one in front. Open the chat in a second window or read it on your phone, and the check decided you weren't looking — and buzzed you.

Now, if you have that conversation open, that person's messages don't raise a notification on that device. Everyone *else* still notifies exactly as before, as do order updates and feedback. One thing worth knowing: if you leave a conversation open and walk away, that device stays quiet for that person — your unread badge and inbox still update, and your other devices still notify normally.

## The subject line appears with the message

When a new conversation arrived, the message card showed up in your inbox within a few seconds — but its subject line sat as a placeholder for about a minute before filling in with the actual listing.

The alert only tells your browser *who* messaged and *which* listing, not what the listing says. Morphit now looks that up straight away, so the card arrives complete: name, subject, and status together. Conversations that aren't about a listing no longer show a placeholder that was never going to fill in.

## Tidier wallet card

Two small things on your wallet were sitting a touch low against the numbers beside them: the local-currency value next to your BLURT balance, and the little info dot next to your BP. Both now line up properly.

## For people running a node

The built-in daily database backup could fail without saying why. The script is written for a shell that doesn't support one of the options it used, and the failure was being swallowed — so the backup exited silently before it ever reached your database. If you set up automatic backups on a Debian or Ubuntu server, they were not running. This release fixes that and, more importantly, adds a check that runs the script for real rather than just reading it.

While tracing that, we found and fixed several more problems on the setup path: the automated playbook installed the backup script somewhere the system service didn't look for it, and never granted database access on containerised setups; the setup wizard printed a config-file permission that the backup service couldn't read; and the hardening menu printed a shorter list of commands than the job actually needs. The docs have been corrected to match, and a new check keeps all of these files in agreement so they can't quietly drift apart again.

If you run a node, it's worth confirming you've actually seen a backup file appear — a backup you've never watched succeed isn't yet a backup.

Your data, your keys, your trades — all untouched throughout.
