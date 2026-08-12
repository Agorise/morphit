# Morphit v1.11.1

**Theme: quiet durability. A node self-heals operator registrations that a past bug wrongly rejected, the health disk figure watches the volume that actually fills, and an offline install stops looking like a failure. No new features, no breaking changes — just fewer sharp edges.**

## Added

**Nodes now self-heal operator registrations that were wrongly rejected.** If a past validator bug caused your indexer to reject a valid operator registration (for example, the regional-brand-name and Persian-name bugs fixed in earlier releases), that registration used to stay rejected forever — the only fix was to broadcast it again. On the next restart after upgrading, the indexer now automatically replays the registrations it had recorded as rejected and applies any that are valid under the current rules. It only ever re-applies registrations — never payments, orders, or feedback — so there's no risk of double-counting, and it does nothing at all when there's nothing to heal.

**The health "disk" figure now watches the volume that actually fills.** On a machine where your data lives on a separate drive from the operating system, the disk number in `morphit-ops health` and `/v1/health` used to report the system drive — which could look comfortable while your data volume was nearly full. It now measures the filesystem holding your data (the database and chain index). On a normal single-drive box nothing changes; if your data is on its own mount, point `MORPHIT_HEALTH_DISK_PATH` at it (the guided installer does this for you). See `docs/OPERATIONS.md`.

## Fixed

**An offline or air-gapped install no longer looks like it failed.** When you install with no internet on the box, the setup wizard can't reach Blurt to double-check your operator account name — which is completely expected. Instead of an alarming "Could not reach any Blurt RPC" warning, it now says plainly that there's no connection right now and that your node will verify the account by itself the first time it comes online. A genuine error still shows the specific problem.

## Notes

- **No database migrations. No breaking changes.** Nothing about the on-chain format changed.
- **The registration self-heal is automatic and safe to run.** It happens once, in the background, when the indexer starts; it's a no-op on a healthy node and never touches non-registration data.
- **Internal tidy-up.** The IPFS/IPNS seeding health decision now lives in one shared place instead of two, so the operator health view and the public health endpoint can't drift apart. No visible change.
