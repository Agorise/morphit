# Comparison image build script

Builds the Morphit vs. competitors comparison image at 2400 × 9219 px.

## Run

```bash
pip install cairosvg --break-system-packages
python3 scripts/comparison-image/build_comparison.py
```

Output goes to `/mnt/user-data/outputs/morphit-comparison.png`.

## Sources

- 129 rows across 8 themed sections (Privacy, Custody, Audits, Speed-UX,
  Access, Assets, Federation, Community).
- Inline SVG icons for the 2FA padlock (lock) and YubiKey hardware-key
  (key) rows.
- Per-platform counts auto-computed and rendered in the footer.

## Updating

When adding a new tradable asset, security feature, or audit milestone:

1. Edit the `SECTIONS` list at the top of `build_comparison.py`.
2. Add a row tuple `(feature_text, [m, b, h, o, s], optional_icon_id)`.
3. Verify each cell against `MORPHIT-BRAG-LIST.md` AND the competitor's
   public docs / recent independent reviews.
4. Re-run the script.
5. Per memory rule: every claim row must be backed by code/docs/web evidence;
   never invent.
