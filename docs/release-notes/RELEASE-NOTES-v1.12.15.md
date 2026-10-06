# Morphit v1.12.15

**Theme: instances that share a brand — a public identity account and a separate relay account — now display correctly across the federation.**

## Fixed

**A federated instance is no longer flagged as a spoof for using a separate relay account.** The federation directory verifies that the account a peer advertises as its relay matches the account that registered its origin on-chain — a guard against one instance claiming another's identity. That guard required the two to be the *same* account, which flagged a legitimate and secure setup: registering under a public brand account (which holds the reserved brand tag) while doing operational signing from a separate relay account. The probe now accepts this pairing when **both accounts are reserved brand names** — reserved names can only ever be registered by their rightful owner, so two reserved accounts are provably controlled by the same operator. This does not weaken the guard: reserved names cannot be registered by anyone else in the first place, and an instance advertising a relay account that is *not* reserved and does not match its operator is still flagged. No on-chain re-registration is required.

**A signup invite can no longer be used twice by two simultaneous requests.** A single-use invite is verified up front but only marked spent once the account actually lands on-chain, so a failed broadcast doesn't burn a legitimate user's invite. Under a precisely-timed pair of concurrent requests, both could pass verification before either marked the invite spent — creating two accounts from one invite, and since each account creation spends real BLURT from the relay wallet, draining more than intended. The invite is now claimed atomically at the moment of broadcast: a second concurrent request presenting the same invite is rejected, and the claim is released on a failed broadcast so retries still work.

## Hardened

**The relay's decrypted key can no longer be paged to disk.** The relay systemd unit now disables swap for the process (core dumps were already disabled), so the active-key material held in memory during signing cannot be written to disk by the kernel.

**A shared-relay-account misconfiguration is now detected.** If two instances were accidentally pointed at the *same* relay account, each would credit the same signup's welcome bonus from its own independent database. The federation probe now detects when another instance advertises this instance's relay account and alerts the operator, converting a documented footgun into an enforced check.

**A supply-chain gate now guards dependencies.** CI fails on any new high- or critical-severity dependency advisory that isn't in a triaged baseline, so a newly-vulnerable dependency can't enter the tree unnoticed. This release also completed a full security review of the relay, indexer, web/edge, and dependency surfaces.

## Changed

**The block explorer labels three more op types specifically** instead of the generic "Other app": blockchain snapshots ("Blockchain snapshot"), the hidden RPC node directory ("Hidden RPC nodes"), and notifications ("Notification"). Translated across all supported locales.

## Notes

- No database migration in this release.
- Everything from v1.12.14 and earlier (the relay-health fix, auto-detect hardening, instances-page copy) is included.
