# Morphit v1.12.19

**Theme: renaming your instance is now a one-step, in-menu action.**

## Changed

**`morphit-ops edit` now offers to publish a title change to the chain, right there.** Previously the "re-publish to the federation" reminder only fired when you changed your origin or operator tag — a change to your **instance title (display name) triggered nothing at all**, so it was easy to edit the title, restart, and never realize the on-chain record still said the old thing. Now a title change is treated like any other on-chain-relevant edit: the menu tells you it needs publishing and **asks to broadcast it for you on the spot** (using the same env and key the edit just read — no commands to remember, no env-sourcing). Decline, and it names the command for later.

## Fixed

**Clearer guidance when `morphit-ops register` is missing its environment.** On a default install the config and Active key live in a root-owned `/opt/morphit`, so the old "run `set -a; . ./morphit.env`" hint failed with a permission error and sent operators in circles. The message now shows the working one-shot root form (`sudo bash -c 'set -a; . /opt/morphit/… ; morphit-ops register'`) and keeps the plain form for operators running from their own checkout.

## Notes

- No database migration in this release.
- Everything from v1.12.18 and earlier is included — the optional operator names on `/v1/rpc-endpoints` (latency-sorted), the stats-card false-"unreachable" fix, and the live on-chain hidden-RPC directory.
- Reminder for renaming an instance: the federation directory shows each instance's **self-reported** name, so after changing your title, restart your indexer so it serves the new name — other instances refresh it on their next probe.
