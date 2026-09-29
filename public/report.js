// Present existing scan data in the Figma free and detailed report layouts.
// Scores, claims and recommendations come from the scan, never the design fixtures.
function renderReport(r, {full = false, preview = false} = {}) {
  if (r.finalScore === null) return renderDetailedReport(r);
  const layers = Object.values(r.layers || {});
  const gaps = (r.gaps || []).slice(0, 3);
  const fixes = [r.layer2Report, r.layer3Report, r.layer4Report]
    .flatMap(layer => layer?.checks || [])
    .map(check => ({...check, fix:reportFix(check)}))
    .filter(check => check.fix?.headline && check.value < 100);
  return `<div id="paid-preview" class="free-report conversion-report" data-company="${esc(r.brandName || r.domain || 'your store')}">
    <header class="report-intro"><div><div class="eyebrow">${esc(r.brandName || r.domain)} · Free report</div><h1>Your store through<br>the eyes of AI.</h1><p class="report-intro-note">Your readiness snapshot is here. See what works, what needs attention, and where to go next.</p></div><div class="report-scan-meta"><span>Storefront audit</span><strong>${esc(r.domain)}</strong><span>${r.sampled} product pages sampled${r.scannedAt ? ` · ${esc(new Date(r.scannedAt).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}))}` : ''}</span></div></header>
    <div class="free-verdict"><div><strong>${r.finalScore}</strong><small>Readiness out of 100</small></div><div><span class="verdict-eyebrow">Your starting point</span><h2>${esc(r.grade)}</h2><p>${reportText(r.gradeNote)}</p><small>Based on crawler access, structured data, checkout declarations, and content clarity.</small></div></div>
    <section class="free-results" aria-label="Category readiness scores">${layers.map(l => `<div class="free-category"><strong class="${gradeClass(l.score)}">${l.score}<small> out of 100</small></strong><h3>${esc(l.name)}</h3><div class="free-score-track" aria-hidden="true"><i class="${gradeClass(l.score)}" style="width:${Math.max(0,Math.min(100,l.score))}%"></i></div></div>`).join('')}</section><p class="free-score-note">The four readiness categories are weighted to a total of 100. This audit measures public storefront data, not a live AI purchase.</p>
    <section class="free-gaps"><div class="report-section-heading"><span class="report-kicker">Your priorities</span><h2>See what matters first.</h2><p>Your top findings, ranked by their effect on your readiness score.</p></div><ol>${gaps.map(g => `<li><h3>${esc(r.layers?.[g.layer]?.name || 'Readiness gap')}</h3><p>${reportText(g.message)}</p></li>`).join('')}</ol>${gaps.length ? '' : '<p>No scored gaps were identified in this sample. The full report contains the supporting evidence and detailed checks.</p>'}</section>
    ${renderReportValue(r, full)}
    ${!full ? `<section class="competitor-card" aria-labelledby="competitor-title"><div class="competitor-eyebrow">Your competitive position</div><div class="competitor-heading"><h2 id="competitor-title">See how you compare</h2><span class="competitor-badge">INCLUDED IN THE FULL REPORT</span></div><p class="competitor-intro">See where your store leads and where others do better. Add 2 to 5 competitors to include a tailored comparison in your <strong>full report</strong>.</p><div class="competitor-benefits"><span>Side-by-side scores</span><span>Gaps worth closing</span><span>Priorities for your store</span></div><form id="competitor-form"><div class="competitor-fields">${[1,2,3].map(i => `<label><span class="competitor-field-label"><span class="competitor-number">0${i}</span> Competitor ${i}${i>2?' (optional)':''}</span><input name="competitor" type="text" inputmode="url" placeholder="e.g. rivalbrand.com" maxlength="2048" ${i<3?'required':''}></label>`).join('')}</div><div class="competitor-actions"><button type="button" id="competitor-add">+ Add another competitor</button><button type="submit" id="competitor-save">Save competitors →</button></div><p class="competitor-note">Results unlock after payment. Add at least 3 competitors for a scored benchmark. Two usable stores provide a provisional comparison. Some stores may not be scannable. Your selection is fixed once saved.</p><p id="competitor-status" role="status" aria-live="polite"></p></form></section>` : ''}
    ${full
      ? `<section class="free-upgrade"><div class="upgrade-value-copy"><span class="report-kicker">Your next step</span><h2>Read the evidence<br>behind this score.</h2><p>Your full report is open on this page. It holds the findings for every sampled check.</p><ul><li>Detailed findings for sampled pages</li><li>Store-specific fixes and JSON-LD where applicable</li><li>Competitor results when a usable comparison is available</li><li>Prioritized recommendations and a downloadable PDF</li></ul></div><div class="upgrade-value-action"><button type="button" data-view="full">Open full report →</button><p>This summary stays available.</p></div></section>`
      : `<section class="free-upgrade"><div class="upgrade-value-copy"><span class="report-kicker">Your next step</span><h2>Turn the findings<br>into a clear plan.</h2><p>Get the evidence behind your score and practical guidance for improving your storefront.</p><ul><li>Detailed findings for sampled pages</li><li>Store-specific fixes and JSON-LD where applicable</li><li>Competitor results when a usable comparison is available</li><li>Prioritized recommendations and a downloadable PDF</li></ul></div><div class="upgrade-value-action"><span class="upgrade-price">$249 <small>USD</small></span><span class="upgrade-price-note">One payment. No subscription.</span><button type="button" data-view="full">Unlock full report →</button><p>Your free findings stay available.</p></div></section>`}

  </div>
  ${full ? `<div id="full-detail" class="hidden" tabindex="-1"><div class="report-actions"><button type="button" data-view="free">← Free report</button><button type="button" data-print>Download PDF</button></div><div class="preview-notice" tabindex="-1"><b>${preview ? 'Full report preview' : 'Your full report'}</b><span>${preview ? 'Local preview · No email sent or payment collected' : 'Private report · Commerce.Anphonic.ai'}</span></div><article class="report-document">${renderDetailedReport(r)}<section class="fix-roadmap"><div class="sechead"><h3>Fix Roadmap</h3></div><p class="muted">Recommendations from this scan. Effort and timing require implementation review.</p>${fixes.length ? `<div class="benchmark-scroll"><table><thead><tr><th>Recommended task</th><th>Current score</th><th>Implementation</th></tr></thead><tbody>${fixes.map(c => `<tr><td>${reportText(c.fix.headline)}</td><td>${c.value}/100${c.scored ? '' : ' · Informational'}</td><td>${esc(c.fix.where || 'Review check details')}</td></tr>`).join('')}</tbody></table></div>` : '<p>No implementation recommendations are available for this scan.</p>'}</section></article><div class="report-actions"><button type="button" data-view="free">← Free report</button><button type="button" data-print>Download PDF</button></div></div>` : ''}`;
}

document.getElementById('report').addEventListener('click', event => {
  if (event.target.closest('[data-print]')) window.print();
});

// The summary keeps its evidence sections once the report is paid for; only the
// sales framing around them is dropped.
function renderReportValue(r, full = false) {
  const preview = r.preview;
  const product = preview?.product;
  return `${product?.fields?.length ? `<section class="report-product-preview"><div class="report-section-heading"><span class="report-kicker">A closer look</span><h2>What your product data reveals.</h2><p>A real product from your scan. These are the fields our scanner could read, not a simulated AI conversation.</p></div><div class="product-evidence"><div class="product-evidence-heading"><span>Sampled product</span><h3>${esc(product.title)}</h3></div><dl>${product.fields.map(field => `<div><dt>${esc(field.label)}</dt><dd class="${field.visible ? 'readable' : 'missing'}">${field.visible ? esc(field.value || 'Found') : 'Not found in sampled data'}</dd></div>`).join('')}</dl><p>${full ? 'Your full report explains the missing fields and the changes needed to expose them.' : 'The full report explains the missing fields and the changes needed to expose them.'}</p></div></section>` : ''}
  ${full ? '' : `<section class="report-deliverables"><div class="report-section-heading"><span class="report-kicker">Inside your full report</span><h2>From knowing the gap<br>to knowing what to change.</h2><p>Go beyond the score with evidence and implementation guidance for your store.</p></div><div class="deliverable-grid"><article class="fix-preview-card"><span class="deliverable-label">Store-specific recommendations</span><h3>${preview?.recommendationTitle ? reportText(preview.recommendationTitle) : 'Know where to make each change'}</h3><p>${preview?.recommendationCount > 0 ? `${preview.recommendationCount} recommendations with implementation guidance are included in this audit.` : 'Review the detailed findings, supporting evidence, and available fixes.'}</p><div class="locked-outline" aria-hidden="true"><span>Evidence from your storefront</span><i></i><i></i><span>Implementation steps and code where applicable</span><i></i><i></i></div><span class="deliverable-access">Full instructions included in the paid report</span></article><div class="deliverable-list"><article><span>01</span><div><h3>See the evidence</h3><p>Understand how each check was measured and which sampled pages need attention.</p></div></article><article><span>02</span><div><h3>Give your team a starting point</h3><p>Use store-specific recommendations and copy-paste schema fixes where the audit provides them.</p></div></article><article><span>03</span><div><h3>Put your score in context</h3><p>Compare usable competitor scans and take the full report into your next planning session.</p></div></article></div></div></section>`}
  ${renderAgentGap(r, full)}`;
}

// The consequence of the top finding, shown as the shopper question an agent
// cannot answer from this store's data today.
function renderAgentGap(r, full = false) {
  const ask = r.preview?.agentAsk;
  if (!ask?.question) return '';
  const unreadable = (ask.unreadable || []).filter(label => typeof label === 'string');
  return `<section class="agent-gap" aria-labelledby="agent-gap-title">
    <div class="report-section-heading"><span class="report-kicker">What an agent gets right now</span><h2 id="agent-gap-title">The question your store<br>can't answer yet.</h2><p>A shopper asks an AI assistant about a product it sampled from your storefront. This is what the available data supports.</p></div>
    <div class="agent-thread">
      <div class="agent-turn ask"><span class="agent-avatar" aria-hidden="true">AI</span><p>${esc(ask.question)}</p></div>
      <div class="agent-turn reply"><p>${esc(ask.answer)}</p><span class="agent-flag" aria-hidden="true">?</span></div>
      <p class="agent-thread-note">Your own product data, today. The assistant has no <strong>${esc(ask.missing)}</strong> to read${unreadable.length ? `, and ${esc(unreadable.join(', '))} ${unreadable.length === 1 ? 'is' : 'are'} missing too` : ''}. See your first finding above.</p>
    </div>
    ${full ? '' : `<div class="agent-fix">
      <span class="deliverable-label">The opportunity</span>
      <h3>The fix is specific to your store</h3>
      <p>The full report names the exact field, the page it belongs on, and the markup to publish.</p>
      <div class="locked-code" aria-hidden="true"><pre>{
  "@type": "Offer",
  "price": "…",
  "priceCurrency": "…",
  "acceptedPaymentMethod": [
    { "@type": "PaymentMethod", "name": "…" }
  ],
  "shippingDetails": { "@type": "OfferShippingDetails" }
}</pre></div>
      <p class="agent-fix-note">Illustrative structure. Your report contains the completed markup for your products.</p>
    </div>`}
  </section>`;
}
