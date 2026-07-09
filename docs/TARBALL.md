
## cp445 — v1.3.0 (FULL tarball)

FULL, not delta: new files (`accountBinding.ts` + test, `keepActiveKey.ts`, `backupPending.ts`, `postingActive.test.ts`, three new smokes) and **deletions** (3 dead locale keys × 10, `unlock_active.retention_note` × 10). Delta tarballs cannot communicate deletions.

**Ships:** tt.txt #7 (chat header) · #11/#12 (Active-key unlock + "keep on this device") · Ken's final batch (header no-wrap, RPC copy, featured line, settings-broadcast bug) · deep-deep fixes (i18n gate hole + 3 dead keys, activeKeyUnlock refusal-path key leak, 2 stale seed claims).

**Verified:** 465 runners / 13,846 scenarios / 0 failures · svelte-check 0/0 · vitest 954 pass / 5 skip · indexer tsc 0 · release gate 19/19 + 16 + 80 + 12 + 3.
