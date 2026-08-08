# Morphit v1.10.5

**Theme: guided (ansible) installs now advertise the correct relay account, so a new instance is accepted by its peers on the first probe instead of being rejected.**

This is a maintenance release. There are no database migrations and no breaking changes.

## Fixed

**Ansible-installed instances now report their own relay account.** Every instance publishes a relay account in `/v1/instance`, and peers refuse to trust an instance whose published relay account doesn't match the account that signed its on-chain registration (an anti-impersonation check). The guided ansible installer set the operator tag and account name but never wrote the *indexer's* relay-account setting, so it silently fell back to the canonical default — meaning a fresh ansible instance advertised the wrong account and every other node rejected its health probe with a "relay account mismatch." The installer now writes the correct value (the same account the relay signs with), matching what the manual `morphit-ops` wizard already did. A guard was added so no install writer can omit it again.

## Notes

- No database migrations. No breaking changes.
- Only the guided (ansible) install path was affected; manual `morphit-ops` installs already set this correctly.
- An existing ansible instance can fix this without upgrading by setting `MORPHIT_INDEXER_RELAY_ACCOUNT` to its own account and restarting the indexer.
