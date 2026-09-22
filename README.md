# Agent Readiness — scanner and dashboard

Scores any Shopify store 0–100 on how ready its catalogue is for AI shopping
agents, and shows what an agent can't read.

## Run it

```
node server.js
```

Then open http://localhost:3100 and enter a store URL.

Node 18 or higher. No dependencies, no install step, no API keys.

**Terminal only, no browser:**

```
node engine.js https://superyou.in
node engine.js https://superyou.in --json > result.json
```

## Files

| File | What it does |
|---|---|
| `engine.js` | Storefront scanning and Layers 1–4 scoring. |
| `competitive.js` | Layer 5 comparisons, eligibility and combined score. |
| `competitors.json` | The five client-to-competitor mappings. |
| `scripts/benchmark.js` | Batch scans and saved JSON/Markdown reports. |
| `FIGMA-LAYER5-PROMPT.md` | Copyable Figma Make design prompt with the initial scan snapshot. |
| `server.js` | API and static host. Runs scans as background jobs so slow stores don't time out. |
| `public/index.html` | The dashboard, styled by `public/design.css`. |

## Layer 5 — Competitive Position

```sh
npm run benchmark                       # Refresh all five comparisons (17 storefronts)
npm run benchmark -- superyou.in         # Refresh one configured comparison
npm start                               # Open http://localhost:3100
npm test                                # Scoring and rendering checks
```

The batch command scans at most two stores concurrently and uses the same deterministic
content grading method for every store. It saves scored scan evidence under
`reports/layer5/scans/`, full client reports under `reports/layer5/<domain>.json`,
and summaries in `reports/layer5/summary.md` and `summary.json`. A single-client run
updates that client's files and writes a summary of that run; other saved client
reports remain unchanged. Scan a configured client normally, then open **Full audit
preview** to see Layer 5 after Layer 4 in the paid report. There is no client or
saved-competitor selector on the landing page. Brands without configured competitors
do not show a Layer 5 panel. A normal scan of a configured client also scans its
named competitors; its job result includes `layer5Report`.

The one Layer 5 check is **Score vs. 3–5 named competitors**, worth 100% of the layer.
Its score compares the scored checks in Layers 1, 2 and 4. Each competitor beaten
earns 1 point, a tie 0.5, and a loss 0, averaged and converted to 100 per check.
These relative scores use the existing check weights and normalized layer weights
20:25:15. All ties produce 50, even if every store is fully ready. Layer 3 public
checkout detection is informational; no purchase is attempted.

At least three comparable competitors are required before Layer 5 contributes
15% to a **separate combined audit score**. One or two produce a provisional
comparison; no usable peers or an invalid client produce unavailable. Unknown
results do not become zeros. Scans with reported errors, incomplete product samples,
missing crawler responses, mismatched engine/content methods or timestamps more
than 24 hours apart are excluded. Existing checklist heuristics still apply;
the scans do not establish AI recommendation frequency or market equivalence.

`finalScore`, grades, gap impacts and detail panels retain their Layers 1–4 readiness
meaning. `layer5Report.combinedScore` uses the original layer scores and weights:
`0.20*L1 + 0.25*L2 + 0.25*L3 + 0.15*L4 + 0.15*L5`. It is null for provisional or
unavailable comparisons. The dashboard labels both totals separately.

Saved-report API: `GET /api/benchmarks` lists configured mappings;
`GET /api/benchmark/<client-domain>` returns a saved client report. Existing scan
and polling endpoints retain their shape. Batch snapshots are overwritten on
refresh; archive them separately if historical comparisons are needed.

## Changing the scoring

Everything tunable is in the top 60 lines of `engine.js`:

- `WEIGHTS` — the five layer weights
- `SKIPPED_LAYERS` — currently `['layer5']`; remaining weights rescale to 100 automatically
- `LAYER2_SPEC` — Layer 2's six checks with their spec weights and whether each is
  scored. Layer 2's scoring weights are derived from this, not typed separately.
- `SUB` — sub-check weights inside each layer
- `scoreCheckoutStack()` — Layer 3's native-vs-third-party logic

Change a number, rerun. Nothing else needs touching.

## Layer 2, in detail

Layer 2 is 25% of the spec and 29% of the score computed here. It is the layer
clients ask about most, so it is the one reported in full.

### Sub-weights now come from the spec, not by hand

`LAYER2_SPEC` holds the spec's own weights — product 35, variant 20, org 15,
FAQ 10, llms.txt 10, review 10. `llms.txt` is measured but not scored, so its
10 points are redistributed across the other five in proportion. The scoring
weights are computed from that table.

The previous version typed the weights separately and they had drifted:
variant data scored at 15% against a spec weight of 20%, review at 15% against
10%. The screen printed the spec column while the score used the drifted one.
Fixing it moved SuperYou's Layer 2 from 62 to 64 and its total from 73 to 74.
Little Rituals moved 84 to 86 with no change to its total.

### The three ways a sub-score is produced

Every Layer 2 check now reports its `basis`, and the screen labels it:

| Basis | Meaning |
|---|---|
| `measured` | A percentage of the sampled products. Moves with the catalogue. |
| `state` | One of a fixed set of graded outcomes, not a percentage. |
| `baseline` | No fault found, and none assumed. A floor, by choice. |

**There are exactly two baselines in Layer 2, both at 50, both deliberate:**

- **No reviews anywhere on the store.** A brand that has not collected reviews
  yet has not made a markup error. Scoring it 0 would rank it below a store that
  hides real reviews from agents, which is backwards. A store that *has* reviews
  but exposes no schema scores 25 — worse, because that one is a real fault.
- **No FAQ content anywhere.** Same reasoning: nothing to mark up is not the
  same as failing to mark up what you have. A store with an FAQ page carrying no
  schema scores 30.

Nothing else in Layer 2 has a floor. `productSchema` and `variantSchema` are
straight percentages of the sample with no baseline at all — a store where no
product carries schema scores 0, not 50. If you see those two at 50, that is a
real measurement: half the sample passed. SuperYou's product schema is 50
because 10 of its 20 sampled products publish price, availability and SKU.

If you disagree with either baseline, change the two `50`s in `score()`'s `l2`
block. They are two literals, not a smoothing pass over the layer.

### What the screen shows

The Layer 2 section renders every check as an expandable card carrying:

- the measured result and how the number was produced (`basis` + a plain note)
- **which products failed**, by name, linked, with the specific field each is
  missing
- **the exact JSON-LD this store needs**, built from its own catalogue — real
  title, real handle, real price, real SKU, real option names, real currency

That last point is why two stores never see the same fix. SuperYou gets a
`Product` block for *Assorted Minis - Pack of 10* carrying SKU
`SNK-WBM-ASS-020-10` and price ₹275, plus an `AggregateRating` block because
Judge.me is running without schema. Little Rituals passes product schema 20 of
20 and gets neither; it gets an `Organization` block instead, because its
homepage markup lists zero `sameAs` profiles. Anything the scanner genuinely
cannot know is written in `SCREAMING_CASE` so it is obvious a human still has to
fill it in — we never invent a rating or an answer a store hasn't published.

The check objects are built once and shared by both the deep section and the
Layer 1+2 overview, so the two cannot disagree. They used to: the overview
duplicated the result strings and printed "FAQ page exists but carries no
schema" on stores scoring 70, whose FAQ markup was on their product pages.
Little Rituals is one of them, and now reads "On 14 product pages, not on the
FAQ page".

## Open question on Layer 3

`scoreCheckoutStack()` assumes native Shopify checkout is fully agentic-eligible
and each third-party checkout layer reduces that. **This is unverified.**

Shopify's agentic storefronts documentation describes direct checkout in AI
channels as a setting under Sales channels → Agentic, activated by default. It
does not say a third-party checkout app affects it. GoKwik and Shopflo override
the *online store* checkout, which may be a different path entirely.

If direct checkout turns out to be independent of the checkout app, set every
return value in `scoreCheckoutStack()` to 100 and redistribute Layer 3's weight.
Until that's confirmed, the scanner penalises 14 of 15 tested Indian stores for
something that may not be a problem.

Check it in a store admin under **Sales channels → Agentic** before showing a
score to a client.

## Speed on screen

Page speed used to appear only as one row in the Layer 1 spec table. It now has
its own section: median time to first byte, median HTML payload, median full
response, the score, and the range across all sampled pages — plus the five
slowest pages by name.

The penalty is split into **size** and **time** rather than shown as one number,
because they point at different work. Neither is a hosting choice — every
Shopify store runs on Shopify's infrastructure. Payload is what the theme and
its apps emit; slow TTFB is render time, which is theme logic and app blocks.
sleepyowl.co serves 965KB in 497ms while nicobar.com serves 991KB in 1236ms on
the same infrastructure, which is the whole argument for splitting them.

**Page speed is the only Layer 1 check that ranks anyone.** Measured across ten
Indian D2C stores it runs 28 to 100 (mean 73, sd 22.4) — headsupfortails.com
serves 3.0MB of HTML per product page against superyou.in's 469KB. The other
three Layer 1 spec checks return 100 on every Shopify store.

`pageSpeedScore(kb, ttfb)` is the single source for both the Layer 1 score and
this panel, so they cannot drift. Free below 600KB and 800ms, graded above.

**This is not Core Web Vitals.** The spec asks for LCP < 2.5s via PageSpeed
Insights, which needs an API key and roughly 30 seconds per URL — ten minutes
added to every scan. TTFB and payload are what decide how many pages a crawler
samples per visit, they cost nothing, and the screen says so in as many words.

## v2 formula — what the live data says about it

Built to the v2 build spec. Two findings from verifying it against live stores,
both of which the spec should absorb in its next revision.

### The checkout-stack retirement is correct — confirmed at 13 stores

`/.well-known/ucp` was fetched on 13 stores ranging from native checkout
(hairdramacompany.com) to four stacked apps (namhyafoods.com: GoKwik + Shopflo +
RazorpayMagic + Fastrr). Every one returned UCP `2026-08-25` with the identical
eight capabilities and the same checkout version. Checkout-app count has no
relationship to declared capability, because Shopify serves the profile from its
platform layer beneath the storefront the apps modify. The v1 penalty was wrong.

### But `ucp_profile_check` is the same non-discriminating check in new clothes

It returns **100 on all 13**. The spec anticipates this and says to demote it
once confirmed at scale — that confirmation now exists, at 13 stores rather than
5. It is currently scored at 0.50 per the spec, which puts **half of Layer 3 on
a constant**.

Measured consequence across seven stores: **Layer 3 scores 50 on six of them.**
Only littlerituals.in differs, at 71, because it is the single store publishing
`OfferShippingDetails`. The layer ranks almost nobody.

Two contributing causes, both from the spec as written:

- **Binary `cod_prepaid_check` scores 0 everywhere.** No store tested declares
  `acceptedPaymentMethod`, though most name COD in page text.
- **Binary `shipping_serviceability_check` scores 0 almost everywhere.** One
  store in thirteen publishes `OfferShippingDetails`.

The graded ladders these replaced (schema = full, rendered text = 40, policy
prose = 20) did separate stores. They are preserved in git history and are a
one-line revert in `l3` if the spec is revised.

The check with real spread — return/exchange policy on `MerchantReturnPolicy`,
scoring 100/55/40/30 across tested stores — is built but held back by the spec's
`hidden: true` flag. Removing that flag restores it and renormalises the weights
automatically.

### Optional: grading answer-first with Gemini

Set `GEMINI_API_KEY` and Layer 4's answer-first check is graded by a model
instead of keyword matching:

```
GEMINI_API_KEY=... node server.js
GEMINI_MODEL=gemini-3.5-flash-lite   # optional, this is the default
```

Keep the key in the shell or a `.env` that is gitignored — never in a tracked
file. Model names retire: `gemini-2.5-flash-lite` now 404s for new keys with a
message naming 3.5 as its replacement, which is why `GEMINI_MODEL` exists.

Measured on superyou.in, grading changes the answer-first number substantially:

| Fact | Keyword detection | Gemini |
|---|---|---|
| material or composition | missing on 11 of 20 | missing on 7 of 20 |
| primary use case | **missing on 19 of 20** | **missing on 1 of 20** |
| size or dimension guidance | missing on 8 of 20 | missing on 2 of 20 |
| a specific factual attribute | missing on 2 of 20 | missing on 7 of 20 |

answer-first 53 -> 80, Layer 4 48 -> 59, total 65 -> 67. The two large
corrections are the ones predicted from reading the copy by hand: the use-case
regex missed real use cases phrased outside its vocabulary, and the attribute
regex fired on the word "protein" for a protein brand, where it could not fail.

**Determinism is improved, not guaranteed.** Within a running process the hash
cache makes a re-scan free and byte-identical (verified: second pass graded 0,
served 20 from cache, same score). Across process restarts Gemini at
`temperature: 0` still varied by a point between runs (79 vs 80). If a score
must be stable for a returning client, persist the verdict cache alongside the
scan results rather than relying on temperature alone.

**Nothing else changes without a key.** No key, a bad key, a rate limit or a
timeout all fall back to the regexes and the scan completes normally — the free
tier keeps its "no dependencies, no API keys" promise. The report always names
which path produced the number, and prints the reason when it fell back
("Graded by keyword detection (Gemini rate limit hit (free tier) — …)"), because
LLM-graded and regex-graded scores are not comparable and hiding the difference
would make two scans silently mean different things.

Design notes:

- **One request per scan.** All sampled descriptions are batched into a single
  call, so the free tier's per-minute request cap is never the bottleneck.
  Flash-Lite's free quota is 15 requests/min and 1,000/day — that is 1,000 scans
  a day, not 50.
- **`temperature: 0` and verdicts cached by description hash.** An LLM in the
  scoring path would otherwise make scores non-reproducible, which is the exact
  problem deterministic sampling was chosen to avoid. Unchanged copy always
  scores the same.
- **Only answer-first uses it.** Factual density counts units and entity
  consistency matches strings; a model is not better at either, and would be
  worse at counting.
- **Free-tier data terms.** Google's free tier may use submitted content to
  improve their products. That content is public product copy, but it is client
  product copy — worth a deliberate decision before pointing this at a client's
  store. A paid key removes the question.

### Layer 4's fallback structure, without LLM calls

The spec computes answer-first and factual density with a Claude Haiku call. This
implementation asks the same four questions (material/composition, primary use
case, size guidance, a specific factual attribute) with deterministic keyword
detection, so a scan needs no API key and costs nothing.

**The trade is stated on screen, not hidden.** Keyword detection errs in both
directions: "premium materials" counts as covering material where an LLM would
mark it NOT FOUND, while a use case phrased outside the matched vocabulary is
missed entirely. On superyou.in the use-case probe reports 19 of 20 descriptions
failing — plausible for supplement copy, but partly an artefact of the
vocabulary list. Treat `answerFirst` as an indicator, not a verdict.

`entityConsistency` returned **70 on all seven stores tested** — every store
renders its brand name in more than one literal form but identically after case
and spacing are normalised. On this sample it is a third non-discriminating
check, and worth the same scrutiny as UCP before its 0.30 weight is locked.

## Layer 3

All five spec checks are measured. `LAYER3_SPEC` holds the weights, derived the
same way as Layer 2. Agentic Storefronts eligibility is measured but never
scored: `"planName"` appears in the homepage HTML on only 3 of 10 stores tested,
so the check can confirm a tier but can never rule one out, and scoring it would
punish stores for our blind spot. Its 15% redistributes across the other four.

Two checks were added in this pass — COD/prepaid and pincode serviceability —
both built on the same ladder: a parseable field scores highest, rendered text
earns partial credit, silence scores zero.

### Return policy is scored on schema, not prose length

The old check graded the policy page's readable length, which is not what the
spec asks for — a 3,000-character page no agent can parse scored 100. It now
reads `MerchantReturnPolicy` wherever it lives (Product offer, Organization,
OnlineStore block, or standalone) and grades what it finds:

| State | Score |
|---|---|
| Full terms with a stated return window | 100 |
| Typed schema, no return window | 70 |
| `hasMerchantReturnPolicy` holding only a link | 55 |
| Prose only, over 1200 characters | 40 |
| Prose only, over 400 | 30 |
| Any policy text | 20 |
| No policy page found | 0 |

**Prose caps at 40 however long it is.** Length is not machine-readability.

The 55 band exists because of a false negative worth remembering: keying off
`@type` alone missed littlerituals.in and zouk.co.in, which publish
`hasMerchantReturnPolicy` as an **untyped** stub containing nothing but
`merchantReturnLink`. Scoring those as "no schema" was unfair — a machine-readable
pointer beats prose — but they are not full terms either, since an agent that
follows the link lands on a page it still cannot parse.

Measured across five stores: superyou.in 100 (7-day window, free returns),
littlerituals.in and zouk.co.in 55, nicobar.com 40, beminimalist.co 30.

## Fixed in 2.1

- **Layer 2 sub-weights had drifted from the spec** and the screen printed the
  spec column while the score used the drifted one. Weights are now derived from
  `LAYER2_SPEC`. See "Layer 2, in detail" above for the score movement.
- **The Layer 1+2 overview duplicated Layer 2's result strings** and had gone out
  of sync — the FAQ row printed "carries no schema" on stores scoring 70. Both
  views now render the same objects.
- **Layer 2 sub-scores didn't say how they were produced.** Each now reports
  `measured`, `state` or `baseline`, so a 50 is never read as a measurement when
  it is a deliberate floor.
- **`sameAs` counted empty strings.** Themes emit a slot per social setting
  whether filled or not — superyou.in publishes nine entries of which seven are
  `""`. The scanner counted array length, printed "Present, 9 linked profiles",
  and would have passed the 2+ test on a store with one real profile among five
  blanks. Only entries that parse as URLs count now, and the empty slots are
  reported rather than hidden.
- **The variant check scored 100 on an empty set.** superyou.in has no
  multi-variant products at all, so every product passed vacuously and the check
  awarded full marks — 22% of the layer — for evaluating nothing, while labelled
  `measured`. It now reports `baseline` with an explicit note. The score is
  unchanged pending the decision on whether this check should be scored at all.
- **Unlisted review apps fell through to the no-reviews baseline.** The named app
  list had six entries; sleepyowl.co runs Junip, so the scanner reported "no
  reviews found" and scored it 50 — crediting a store that in fact hides real
  reviews from agents, which scores 25. The list is now fifteen apps plus a
  generic backstop (`REVIEW_UI_RE`) that catches unnamed widgets by their
  rendered review count. sleepyowl now scores 25 correctly; its Layer 2 moved
  92 → 89 and its total 81 → 80. Verified that nicobar.com, which genuinely has
  no reviews, still lands on the 50 baseline.

## Fixed in 2.0

- **Page weight scored 0 on nearly every store.** Not a code bug — a calibration
  error. The check penalised more than 40 script tags, but real Shopify stores
  run 64–180 because themes and apps inject dozens of inline blocks, including
  the JSON-LD scored elsewhere. That produced 91–210 points of penalty on a
  100-point scale. Now measures payload size and time-to-first-byte instead.
- **Review schema was binary.** A store with no reviews anywhere scored 0,
  identical to a store hiding real reviews from agents. Now three states:
  schema present, reviews displayed by an app but not exposed (25), no reviews
  at all (50, not treated as a fault).
- **FAQ schema only checked product pages.** FAQ markup usually lives on a
  dedicated FAQ page. Now checks the homepage and four FAQ page paths, and
  distinguishes "FAQ content exists but isn't marked up" from "no FAQ at all".
- **Shipping and return policies only checked one URL each.** Now checks four
  paths each and scores on a graded scale rather than pass/fail.
- **Gap messages were templated.** Every message now cites numbers measured on
  that specific store, so two scans never produce the same sentence.

## Two known artefacts of the current weights

- A store with **zero product descriptions still scores about 69** ("Partially
  Ready") because content is only 15% of the total. Shopify's own listing
  quality rubric ranks heavily on description completeness, so this may
  understate the problem.
- A store that **blocks all crawlers still scores 100 on Layer 3**, because
  checkout is scored independently of whether anyone can reach the site.

Both follow from the weights as specified. Worth a decision rather than a
silent fix.

## What it does and doesn't do

Reads only publicly served pages — `/products.json`, `/policies/*`, product
HTML, `robots.txt`, `sitemap.xml`. No login, no admin access, no cooperation
from the store. Requests are rate-limited and identify themselves as an
Anphonic scanner.

Samples up to 20 products spread across the catalogue, not the whole thing.
Layer 5 is available for the configured competitor sets; see the commands above.

## Moving this to production

Three changes, in order of importance:

1. **Replace the in-memory `jobs` Map in `server.js` with Supabase.** That single
   change makes it persistent and multi-user. Store raw fetch results too — the
   paid audit reuses them instead of rescanning.
2. **Raise the rate limit deliberately.** Currently 20 scans per IP per hour. A
   public tool that fetches arbitrary domains needs this before launch, not after.
3. **Stamp a formula version on every result.** When weights change, a returning
   brand's score moves for reasons they can't see. Version it.

### Lead database

Requires Node.js 22.13+ (Node 24 recommended). Start with `npm start`.
The consent form posts to `POST /api/leads` and saves name, normalized email,
store origin, consent timestamp/version, and creation/update timestamps in
`data/leads.sqlite`. The database is created automatically, outside the public
folder. Repeated email/store pairs update the existing lead. Database files
are excluded from Git. Email remains **unverified**; the demo code does not
prove ownership of an email address.

Set `LEADS_DB_PATH` to change the database location. Use a persistent disk when
deploying; ephemeral hosting will not retain SQLite data across deployments.
There is no public lead-list endpoint. Inspect locally with a SQLite client:

```bash
sqlite3 -header -column data/leads.sqlite 'SELECT name, email, store_url, consent_at, email_verified FROM leads ORDER BY updated_at DESC;'
```

This stores contacts only; scan jobs/history still live in memory. Payment,
real email delivery, CRM integration, and lead-to-scan result linking are not
part of this change.
