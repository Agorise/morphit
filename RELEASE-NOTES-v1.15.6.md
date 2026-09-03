# Morphit v1.15.6

**Re-registering on-chain no longer asks for a passphrase you'd have to re-type — it unlocks from the relay's own sealed credential — and if a prompt is ever needed, a pasted passphrase now works.**

## Fixed

**Interactive `register` unlocks from the relay's sealed credential automatically.** Re-publishing your on-chain registration (`morphit-ops` → *Re-publish my registration*, or after an origin/name/contact edit) signs with the relay's active key, which is stored encrypted. It used to prompt for the unlock passphrase every time — and a correct passphrase could still be rejected (see below). Now, when the relay's host-bound sealed credential is present (the same one the relay service auto-unlocks with at boot, `/etc/morphit/relay_passphrase.cred`), `register` decrypts it and unlocks the key with no prompt at all. An operator running this on the box never has to re-supply a passphrase the relay already holds. The decrypted secret lives only in a `/run` (RAM) file that's scrubbed immediately, and because the credential is bound to the machine it can't be decrypted off a stolen disk. If the credential is absent or doesn't match the keystore, `register` falls back to asking, exactly as before.

**A pasted passphrase now works at the masked prompt.** When a prompt *is* shown, the masked reader ran the terminal in raw mode without disabling bracketed-paste — so pasting a passphrase wrapped it in the terminal's `ESC[200~ … ESC[201~` markers and the bracket characters were captured as part of the passphrase, silently corrupting it and rejecting a correct value. The reader now disables bracketed-paste while reading and strips any stray control sequences, so a pasted passphrase is accepted verbatim (typing already worked).

## Notes

- Includes v1.15.5 (contact-URL re-register + the disambiguated unlock prompt) and v1.15.4 (noble-only installer gating).
- No schema change, no on-chain format change. Upgrade in place.
- Pinned by smoke: the paste-stripping is unit-tested (`ESC[200~pass ESC[201~` → `pass`), and static checks assert `register` tries the sealed credential (via `systemd-creds`, scrubbing its `/run` temp) before falling back to the prompt.
