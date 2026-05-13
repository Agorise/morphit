-- Morphit schema v10
--
-- Adds `invalid_reason` to the releases table. When a release op
-- is recorded with valid=false, we now preserve the specific
-- reason it was rejected. Enables operators investigating a
-- potential key compromise to distinguish:
--
--   - 'signer_not_official_account' (phishing / impersonation; no
--     real key compromise — someone broadcast from an account
--     that claims to be @morphit but isn't)
--
--   - 'signer_no_single_posting_key' (on-chain posting authority
--     has multi-key or account-auth setup — unusual but not
--     necessarily malicious)
--
--   - 'pubkey_mismatch' (signer account matches, but the on-chain
--     posting pubkey doesn't match the pinned value — this is
--     the signal that the pinned key should be rotated
--     immediately, since it means somebody valid-signed a release
--     from the right account with the wrong key)
--
-- Backward-compat: column is nullable. Historical rows from v1-v9
-- keep `invalid_reason IS NULL` and their valid/invalid status is
-- unchanged.
--
-- Ref: Finding J in docs/REVISIT-LIST.md §F.

ALTER TABLE releases
	ADD COLUMN IF NOT EXISTS invalid_reason TEXT;

COMMENT ON COLUMN releases.invalid_reason IS
	'When valid=false: the specific rejection reason '
	'(signer_not_official_account / signer_no_single_posting_key '
	'/ pubkey_mismatch). NULL when valid=true.';
