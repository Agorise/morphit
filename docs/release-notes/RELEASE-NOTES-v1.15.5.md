# Morphit v1.15.5

**Two operator-facing clarity fixes: editing your contact URL now offers to re-broadcast it on-chain, and every "unlock passphrase" prompt now says exactly which key it wants.**

## Fixed

**Editing the contact URL now prompts you to re-register on-chain.** Your origin, operator tag, display name, and contact URL all ride in the on-chain operator-register record that other instances read to list you. The edit wizard offered the "broadcast this to the chain" step after an origin/tag/display-name change, but *not* after a contact-URL change — so editing only your contact link updated your local footer while silently leaving the federation's copy stale. Contact URL is now part of that check, and the reminder names it explicitly.

**The relay key-unlock prompt says what it wants.** The prompt that unlocks the relay's Blurt active key (when you re-register, show your public key, or add a payment method) simply read `Unlock passphrase`, with no hint which of an operator's several secrets it meant. An operator reasonably wondered whether it wanted a Blurt key, an SSH key, a GPG key, or a system password. All three call sites now use one shared, unambiguous prompt: it names the relay's Blurt active key and states what it is *not* (your SSH, GPG, or system password). If you forget it, it's the passphrase you chose at install — the same one the relay auto-unlocks with at boot, recoverable on the box with `sudo systemd-creds decrypt --name=relay_passphrase /etc/morphit/relay_passphrase.cred -`.

## Notes

- Includes everything in v1.15.4: the one-command installer now gates on the Ubuntu 24.04 "noble" base up front (before writing secrets or running Ansible) and maps the playbook's OS-gate to clear 24.04 guidance instead of a support dead-end.
- No new on-chain fields and no schema change — the register op already carried the contact URL; this only fixes when the wizard offers to re-broadcast it. Upgrade in place.
- Pinned by smoke: the re-register reminder now gates on origin/tag/name/**contact**, and every relay-key decrypt site uses the shared disambiguated prompt (no bare `Unlock passphrase` label remains).
