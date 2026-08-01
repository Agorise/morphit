# Morphit v1.9.11

**Theme: the warrant canary keeps working across upgrades, and right-to-left order cards lay out correctly.**

This release closes the loop on two things from v1.9.10: it makes the warrant
canary genuinely hands-off across upgrades, and it fixes how order cards lay out
in Persian and other right-to-left languages.

## What's new

**Your warrant canary keeps working across upgrades — no permission fiddling.**
Each week the canary refresh uploads two files into the folder your site serves:
the signed `canary.txt` and your public key `pgp_keys.asc` (so readers can verify
the signature). Upgrading Morphit rebuilds that folder, and the rebuild used to
leave it owned by `root` — so the next canary upload was refused with a
"permission denied" until you fixed the ownership by hand. From this release on,
the upgrade restores the served folder to whoever owns your canary uploads, so the
refresh just works after every upgrade. Nothing to remember, nothing to re-chown.

**Right-to-left order cards now lay out correctly.** v1.9.10 fixed right-to-left
*text*; this release fixes the *layout*. In Persian, an order card's Message
button and expiry chip sat on top of the poster's name and handle, because the
card's own positioned pieces didn't mirror along with the rest of the page. Now
the whole card mirrors properly in right-to-left languages — the actions move to
the other side, clear of the identity — so nothing overlaps. Left-to-right
languages are unchanged.

**Order titles use a touch more width.** The one-line order title on desktop now
extends a little further before it trims, so short and medium titles show one or
two more words. The expiry chip and Message button still have the room they need,
in every language.

## Notes

- No database migrations. No breaking changes.
- The canary's signing model is unchanged: signed off the served box with your own
  PGP key, so it goes stale exactly when it should.
- Operators setting up a canary for the first time: `scripts/canary/setup.sh` is
  the one guided command (see `docs/RUN-A-MORPHIT-NODE.md`); after that, the
  weekly refresh and post-upgrade re-run are handled for you.
