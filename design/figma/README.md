# Layer 5 — Figma import layouts

Target file: https://www.figma.com/design/w3GV6PfeP7XvuYxR0D6Oq4/Untitled?node-id=0-1

These layouts are based on the existing local Anphonic dashboard and the saved
18 September 2026 scan results. The target Figma file has not been inspected or
modified. Figma is now confirmed installed, but its tools are not available in
the current IDE chat.

The user requires preserving the target file's existing instructions, fonts,
colours, icons and styling. Inspect those before making changes in Figma. These
SVGs are content/placement drafts, not verified matches to the target file.
Reuse the target's components and styles instead of replacing them with these
drafts. The full instructions are in `../../FIGMA-LAYER5-PROMPT.md`.

Import `Layer-5-paid-reports.svg` into Figma Design for all five brand layouts,
or import an individual domain SVG. The zip contains the same SVG files.
The source uses vector shapes and SVG text with Rethink Sans (font assets are
in `public/assets`); text handling on import depends on Figma and installed fonts.
These are static design layouts, not a wired prototype or a payment system.

Each layout shows the paid report with Layer 5 immediately after Layer 4.
There is no front-page competitor selector. Actual scan results determine
Complete or Provisional status and whether the 15% contribution is shown.
The app already handles conditional visibility for configured brands.

To regenerate after refreshing reports, run from the project root:

    node design/figma/build-layer5.mjs

This regenerates SVGs only; the zip and PNG previews are export snapshots.
