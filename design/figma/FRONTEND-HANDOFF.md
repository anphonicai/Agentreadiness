# Frontend flow

Implemented from Figma file w3GV6PfeP7XvuYxR0D6Oq4: flow frames 49:521,
49:564, 49:613, 49:668, 49:743, 49:838, 49:885; detailed report 73:26.

Run `npm start` and visit http://localhost:3100.

Journey: store URL → consent → verification → analysis → free report →
premium upgrade → checkout preview → full report. Verification code: 123456.

The scan API and engine are unchanged. `public/journey.js` owns the demo
verification and upgrade transitions. `public/report.js` presents existing
scan results; `public/refinement.css` applies the Figma styling over the
existing styles. Detailed evidence renderers remain in `public/index.html`.

Backend work remaining:
- Implement real email verification. Consent/contact details now persist in SQLite via `/api/leads`.
- Replace demo checkout with payment-provider integration and server-side access.
- Supply reviewed roadmap timing/effort if required; currently only actual scan
  recommendations are displayed. Competitor data is shown when provided by the API.
- $249 is the design's preview price, not an active charge.

PDF download opens the browser print dialog (Save as PDF).

Validation: existing 10 tests pass. Browser checks with a saved scan exercised
all screens at 1440px and 390px, invalid and valid verification, upgrade,
checkout and return to free report, with no JS errors or page overflow.
