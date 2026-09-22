# Figma design instructions — Layer 5

Target file: https://www.figma.com/design/w3GV6PfeP7XvuYxR0D6Oq4/Untitled?node-id=0-1

Update the existing Anphonic Agent Readiness dashboard with “Layer 5 — Competitive Position”. First inspect the target Figma file and read its existing design instructions. Keep the existing fonts, font sizes and weights, colours, icons, logo, component styles, spacing, borders and radii. Reuse the file's existing text styles, colour variables and component instances wherever available. Do not introduce a new icon set, redraw the logo, substitute a font or redesign Layers 1–4. The Figma file and its instructions are the source of truth; local SVG drafts illustrate content and placement only and must not override those styles. If the file cannot be inspected, do not claim its styling has been matched.

Use the existing store URL scan flow. Automatically match the scanned brand to
these five competitor sets in the background. Do not add a client selector,
saved-competitor selector, or separate benchmark button to the landing page:
- superyou.in → fitfeast.in, beastlife.in
- twobrothersindiashop.com → anveshan.farm, girorganic.com
- baccabucci.com → wearcomet.com, gullylabs.com, neemans.com
- kalkifashion.com → koskii.com, houseofmasaba.com
- dashanddot.com → seventen.in, farak.co, andamen.com

Place Layer 5 inside the paid report / Full audit preview, immediately after Layer 4. Show it only when the scanned brand has configured competitors. Keep competitor scores, tables and the combined audit score out of the free report and landing page. Header: “Layer 5 — Competitive Position”, “15% weight” badge, and a Complete / Provisional / Unavailable status badge. Subtitle: “How your storefront compares with your named competitors on the same checklist.”

Show four summary metrics: relative position /100; comparable competitors out of named competitors; Layer 5 contribution /15; combined audit score /100. Keep the existing Layers 1–4 readiness score separately labelled. For provisional or unavailable comparisons show an em dash for contribution and combined score. Never show missing measurements as zero.

Use these real scan results from September 18, 2026 as the initial snapshot, not permanent scores:

| Client | Readiness /100 | Layer 5 /100 | Comparable | State | Contribution /15 | Combined /100 |
|---|---:|---:|---|---|---:|---:|
| SuperYou | 69 | 56.4 | 2/2 | Provisional | — | — |
| Two Brothers | 52 | 37.8 | 2/2 | Provisional | — | — |
| Bacca Bucci | 67 | 63.8 | 3/3 | Complete | 9.6 | 66.6 |
| Kalki Fashion | 50 | 42.5 | 1/2 | Provisional | — | — |
| Dash and Dot | 72 | 66.5 | 3/3 | Complete | 10.0 | 71.0 |

Include a competitor coverage table showing domain, scan status/reason, sampled product count, and scan timestamp. Koskii returned NO_CATALOG: display “Product catalogue unavailable”, not a zero score or “not on Shopify”. The other competitors returned usable 20-product samples in this run. Three clients were supplied only two competitors; Kalki currently has just one usable competitor. Require at least three comparable competitor scans before the 15% contributes.

Add a horizontally scrollable comparison matrix: scored check, client score, one column per named competitor, competitor median, and gap in points. Group checks by Layers 1, 2 and 4. Label values “Checklist scores /100”; not every score represents product coverage. Use textual Ahead / At parity / Behind labels with the existing design's corresponding status colours and icons. Unavailable competitor cells display an em dash and their reason.

Below the matrix show up to three expandable priority gaps with the measured difference, affected product links, and store-specific fixes from the report data. Show a useful empty state if no measured checks fall below the median. Add a collapsed “Checkout detection — informational” panel showing detected apps and UCP declaration evidence for client and competitors. State that no purchase was attempted and no detected app does not confirm native checkout.

Add “How this is scored”: there is one Layer 5 check, “Score vs. 3–5 named competitors”, worth 100% of this layer. Reuse scored checks from Layers 1, 2 and 4 with their existing check weights and layer weights normalized in the ratio 20:25:15. For each check, a competitor beaten earns 1, a tie 0.5, and a loss 0; average over comparable competitors and convert to 100. Combine with those fixed weights. All ties = 50. Layer 3 stays informational. Combined audit score = 0.20×L1 + 0.25×L2 + 0.25×L3 + 0.15×L4 + 0.15×L5, available only when at least three competitors are comparable. Readiness alone is the weighted Layers 1–4 total divided by 0.85. Do not calculate the combined score from an already rounded readiness score.

Include limitations in the methodology drawer: up to 20 sampled product pages per store; same engine version and content method; scans within 24 hours; existing checklist heuristics; incomplete scans excluded; relative position does not measure AI recommendations or actual purchase success. Show timestamp and engine version discreetly.

Support loading, complete, provisional and unavailable states inside the paid report. Omit the Layer 5 section for brands without configured competitors. Switching back to the free report must hide the section again. Preserve keyboard access and visible focus indicators. On mobile use a two-column metric grid and scrollable tables; never shrink columns until text becomes unreadable.

If connecting to the running Node app, use the existing POST /api/scan {"url":"..."}, which automatically scans configured competitors; poll GET /api/scan/{id} for the completed result. In the paid report, conditionally render Layer 5 when the result contains layer5Report. Bind to its fields: status, score, comparedCount, namedCount, contribution, combinedScore, readinessScore, competitors, rows, gaps, checkout, methodology, limitations. Do not expose saved-report APIs as a front-page navigation flow. In a design-only prototype, use the snapshot above and label it with its scan date. Do not invent per-check competitor values; import the generated report JSON for the matrix. The current app uses a Full audit preview; payment processing is not connected.
