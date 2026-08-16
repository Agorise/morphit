# Morphit v1.12.3

**Theme: the offline-appliance path finishes itself, completely. A node installed with no internet now — the moment it first connects — brings up its Tor/I2P transports, publishes its warrant canary, and registers itself on-chain, all unattended and with the active key kept encrypted the whole time. Plus honest health reporting and safer key defaults.**

## Fixed

**On-chain registration now completes automatically on an offline install — without ever storing your passphrase in plaintext.** When you opt into "list my instance" during setup, first-online now unlocks your encrypted active key the same way the relay does — from the host-bound sealed credential (decrypted only in RAM, for the one registration call) — and publishes the registration the moment the box is online. Previously this silently failed for encrypted keys, leaving you to register by hand.

**The warrant canary now actually publishes on first-online.** The publish step was invoking the refresh script with the wrong shell, so it exited before doing anything. It now runs correctly, so a fresh install signs and serves its canary on its own once it can fetch the freshness proofs.

**Tor and i2pd reseed/bootstrap on first connection.** A node installed offline starts these daemons with no network; first-online now restarts them when connectivity appears, so i2pd actually reseeds instead of sitting with an empty database, and the hidden nodes come up on their own.

**Health: the reachable-node count and the "catching up from N nodes" line both match the list shown.** No more "9/10" or "9 nodes" when all ten are green — both are counted from the same per-node list.

## Changed

**The relay active key is always stored encrypted.** The setup wizard and the key-rotation command no longer offer a plaintext option. Since the relay unlocks an encrypted key automatically at boot (from a host-bound sealed credential, with no prompt to hang on and no way for a stolen disk to decrypt it), plaintext storage carried real risk for no operational benefit. Encrypted is now simply the way keys are stored.

**Clearer, accurate wording throughout the key-setup flow and operator docs.** Corrected stale text that claimed the relay "prompts for the passphrase at startup" (it unlocks automatically), including an operations-guide warning that wrongly said a reboot could leave the relay waiting for a passphrase indefinitely.

**Small wording:** a fresh install's i2pd warm-up note now says "~10 minutes," and the registration-permanence prompt reads "only superseded by a fresh register op."

## Notes

- No database migration in this release.
- Existing installs are unaffected; the automation and key-default changes apply to fresh and re-run setups.
- Nothing here touches trading, fees, or on-chain formats.
