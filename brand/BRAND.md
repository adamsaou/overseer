# Overseer brand

Overseer is an instrument, and it should look and sound like one. Everything it shows measures something: the site is a photographic plate, the mark is the auditor's aperture, and the only warm colour anywhere is measured hidden intent.

## The mark: the aperture

A nine-blade iris, the auditor, painted by hand: each blade a brushed petal, the seams the gaps the brush left. Its opening glows warm, brushed upright and hottest in the middle: the hidden objective, seen through the auditor's iris. The site's hero draws the same iris over the same light. The paint is the human half of the brand and the type is the measuring half.

| File | Use |
|---|---|
| `mark.png` | The mark alone, 2048 px, transparent: on dark backgrounds |
| `icon-1024.png`, `icon-512.png` | The mark on its plate tile: avatars, the Claude Code plugin, anywhere that isn't dark |
| `favicon-64.png`, `favicon-32.png`, `favicon-16.png`, `apple-touch-icon.png` | Browser tabs and home screens |
| `lockup.png`, `lockup-on-light.png` | The tile with the wordmark |
| `readme-header.png` | The top of the README |
| `social-preview.png` | GitHub's social preview, 1280 × 640 |

Keep clear space of half the mark's width on every side. Don't recolour it, rotate or skew it, add shadows or outer glows, or let the warm light spill past the blades.

## The wordmark

**OVERSEER** in Azeret Mono SemiBold, all caps, tracked 0.22 em: `wordmark.svg` for dark backgrounds, `wordmark-on-light.svg` for light ones. In running text the name is Overseer. In the lockups the wordmark's cap height is a third of the tile's height. Don't set the wordmark in another typeface.

## Colour

Colour is a measurement, never decoration. Warm appears only where hidden intent is measured, cool only where the clean reference is involved, and every other state uses lightness.

| Token | Hex | Role |
|---|---|---|
| Plate | `#070908` | Background |
| Raised | `#0D100F` | Panels, code, tables |
| Ink | `#E8EAE6` | Text, the painted blades, the wordmark |
| Muted | `#A3AAA6` | Body copy |
| Faint | `#858D89` | Captions, footnotes |
| Halation | `#FF5A2B` | Hidden intent only: the mark's light, the leak, divergence, the seal |
| Comparison | `#9CC8D2` | The clean reference only |
| Scale | `#6A7470` | Axes and ticks |
| Hairline | `#1E2422` | Frames and rules |

No gradients other than the leak's halation, no purple, no cream, no glass.

## Type

- **Source Serif 4** for words: Light at display sizes for headlines, Regular for text.
- **Azeret Mono** for data, labels and the wordmark. Numbers lead; labels are capitals tracked 0.14 em.

Both are under the SIL Open Font License. The site self-hosts subsets with their licences in `site/fonts/`.

## Voice

Plain and exact. Lead with the measurement, give n, and call a pilot a pilot. Say what was measured and what wasn't.

- **The hook:** Can a weaker AI catch a stronger one that's hiding something?
- **The descriptor:** Black-box audits for hidden objectives in language models.
- **The paragraph:** Overseer measures whether one AI model can catch another that has been given a hidden objective. An auditor model questions the target and keeps an evidence board, and semantic-entropy scans compare the target's answers with those of a clean copy of the same model, so hidden intent can show up as divergence. It runs as a command-line tool (`npx @adamsaou/overseer`), as a Claude Code plugin in which Claude Code itself is the auditor, and as a GitHub Action that checks a system prompt for a covert agenda on every pull request. Built at the Claude Community × Sojori Casablanca Build Day, October 2026.

Avoid hype ("revolutionary", "cutting-edge", "unlock", "seamless", "AI-powered"), claims the data doesn't support, and other companies' logos.

## Regenerating

```bash
uvx --with numpy --with pillow --with fonttools --with brotli python brand/make_brand.py
```

`paint_mark.py` paints the mark with simulated brush strokes from a fixed seed, so it comes out the same every time. The type is outlined from the site's fonts in `site/fonts/`, so nothing depends on installed fonts. The README header and the social preview need `rsvg-convert` (librsvg).
