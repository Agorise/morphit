# Morphit v1.15.7

**Fixes a crash that silently froze every instance's directory listing: the federation probe was reading a database column that didn't exist, so no node was ever re-probed and directory names/taglines went stale.**

## Fixed

**The federation probe no longer crashes on a missing column.** The clearnet-blocked detection added in v1.15.3 ("Fix B") queried `operators.last_action_block_num`, but that column was never added to the `operators` table. Against a live database the probe scan threw `column o.last_action_block_num does not exist` on **every** cycle — so no instance was ever re-probed, and each instance's cached name/tagline in the `/instances` directory stayed frozen at whatever was there before (a renamed instance kept showing its old name even though its on-chain registration was correct). This release adds the column (migration v58, additive/nullable, backfilled to `registered_in_block`) and advances it on each operator registration, so the probe runs again and the directory refreshes. The unit smoke that covers the probe mocks the database, so it never ran the real SQL — a new **query↔schema parity smoke** now reconciles every `operators`-aliased column the probe selects against the actual schema (CREATE TABLE + migrations), which would have caught this before it shipped.

**Re-registration now broadcasts a legacy-stored I2P b32 address.** An instance whose `.b32.i2p` address is held in the older single `MORPHIT_INSTANCE_I2P_ADDRESS` variable (rather than the split `MORPHIT_INSTANCE_I2P_B32_ADDRESS`) had its b32 shown in the edit wizard but dropped from the on-chain register op — the wizard applied the legacy fallback and the register command did not. `register` now applies the same fallback, so the b32 is published like the other addresses.

## Notes

- **Operators upgrading from an affected version should re-run `morphit-ops` → option 2 (upgrade); migration v58 adds and backfills the column automatically.** No manual step. (If you already added the column by hand as a hotfix, the migration is idempotent — `ADD COLUMN IF NOT EXISTS` — and leaves your data alone.)
- Includes v1.15.6 (sealed-credential auto-unlock + paste-hardened prompt), v1.15.5 (contact-URL re-register + disambiguated prompt), and v1.15.4 (noble-only installer gating).
- Known limitation: `last_action_block_num` advances on registration; richer per-op aliveness tracking (so a long-running censored node stays classified `clearnet_blocked` between registrations) is a follow-up. Until then a censored node that hasn't re-registered within the window classifies as `unreachable` — the safe default.
