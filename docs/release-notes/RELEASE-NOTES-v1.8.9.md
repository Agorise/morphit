# Morphit v1.8.9

## No more pop-ups from the person you're already talking to

This is the third release in a row that has claimed to fix this, so here is what was actually wrong.

The code that stops a notification firing while you have that conversation open lives in the service worker — the small background program your browser keeps for Morphit. A service worker is the one part of a website that does **not** update when you reload the page: a new one installs and then waits, while the old one keeps running. Both previous fixes were correct and neither was ever running.

So the page itself now takes down any notification for the conversation you're looking at. Page code is fresh every time you load it, so this works no matter how old the background worker is. Messages from anyone else still notify exactly as before.

## The subject line appears with the message

A new conversation used to arrive in your inbox within seconds, but its subject sat as a placeholder for about a minute. Morphit now looks up the listing straight away, so the card arrives complete. Conversations that aren't about a listing no longer show a placeholder that was never going to fill in.

## Clearer order titles

An order with no minimum or maximum used to be titled just "I'm buying BLURT" — the vaguest listing got the least helpful title, exactly when a reader most needs to know what you'd pay with. Titles now always say what you're trading and in which currency:

- **I'm buying any amount of BLURT with MXN**
- **I'm buying at least 40 MXN of BLURT**
- **I'm buying up to 70 MXN worth of BLURT**
- **I'm buying 40–60 MXN worth of BLURT**
- **I'm buying exactly 50 MXN worth of BLURT**

The blog announcement is now built from that same title, so the two can never disagree again.

## Smaller touches

- **A clear button in the payment-method search.** Once you've typed a couple of characters, a small ✕ appears in the field to empty it.
- **Your settings link cards now carry their own artwork** — a large globe, play or Nostr mark in the corner.
- **A stray background colour is gone.** Firefox tints saved-login fields its own colour; Morphit had a fix for this that only ever worked in Chrome. It works everywhere now.
- **Tidier profile page.** The website, streaming and Nostr links beside your avatar now sit in a consistent order, closer together, and line up with the bottom of your picture. The streaming mark is now a rounded badge rather than a bare triangle.
- **Wording.** The syndication card on the last step of posting is retitled, and the amount hint in the Pay window no longer says "Orders minimum".

## For people running a node

**Your daily backup may never have run.** The built-in backup shipped in v1.8.4 used a shell option that the default shell on Debian and Ubuntu rejects, and the failure was being swallowed — so it exited silently before reaching your database, every night, while the timer reported nothing wrong. This release fixes it and adds a check that runs the script for real rather than only reading it.

Tracing that turned up several more problems on the setup path: the automated playbook installed the backup script where the service didn't look for it and never granted database access on containerised setups, the setup wizard printed a config permission the service couldn't read, and the hardening menu printed a shorter list of commands than the job needs. All corrected, with a new check keeping those files in agreement.

**`morphit-ops health` now reports on backups.** It shows the newest dump with its size and age, and turns red if the timer has been firing without producing anything — which is precisely the failure above. If it says a permission problem, it says so rather than claiming you have no backups.

**Moderation works again, and flags can now be undone.** On any long-lived instance the Moderation screen crashed outright — a column existed for new installs but no upgrade ever added it. Beyond fixing that, a self-trade flag can now be cleared: honest activity can trip the detectors (two accounts set up on the same machine reviewing each other looks identical to the real thing), and the account was left with a hidden reputation card and subdued reviews. Clearing restores it immediately and permanently. The related-accounts flag clears for good, since it rests on facts that cannot change; the mutual-review flag forgives what happened so far but keeps watching, so a genuine pattern still gets caught.

Your data, your keys, your trades — all untouched throughout.
