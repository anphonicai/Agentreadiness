// Present existing scan data in the Figma free and detailed report layouts.
// Scores, claims and recommendations come from the scan, never the design fixtures.
function renderReport(r, {full = false, preview = false} = {}) {
  if (r.finalScore === null) return renderDetailedReport(r);
  const layers = Object.values(r.layers || {});
  const gaps = (r.gaps || []).slice(0, 3);
  const fixes = [r.layer2Report, r.layer3Report, r.layer4Report]
    .flatMap(layer => layer?.checks || [])
    .filter(check => check.fix?.headline && check.scored && check.value < 100);
  return `<div id="paid-preview" class="free-report">
    <div class="eyebrow">${esc(r.brandName || r.domain)} · FREE REPORT</div><h1>AI commerce readiness</h1>
    <header class="free-report-context"><h2>Agent Readiness Report</h2><p>AI AGENT INDEXING DIRECTIVE // ${esc(r.domain)}${r.scannedAt ? ` · ${esc(new Date(r.scannedAt).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}))}` : ''}</p></header>
    <div class="free-verdict"><div><strong>${r.finalScore}</strong><small>SCORE / 100</small></div><div><h2>${esc(r.grade)}</h2><p>Readiness score · Layers 1–4. ${esc(r.gradeNote)}</p><small>${esc(r.domain)} · ${r.catalogCount} products, ${r.sampled} sampled · checkout: ${esc(r.checkoutStack?.length ? r.checkoutStack.join(' + ') : 'native Shopify')}</small></div></div>
    <section class="free-results"><div class="free-section-heading"><h2>Category Readiness Scores</h2><span>SCORED FROM YOUR STOREFRONT</span></div>${layers.map(l => `<div class="free-category"><div><h3>${esc(l.name)}</h3><small>${Math.round(l.weight * 100)}% spec weight</small></div><strong>${l.score}</strong><div class="free-score-track" aria-hidden="true"><i class="${gradeClass(l.score)}" style="width:${Math.max(0,Math.min(100,l.score))}%"></i></div></div>`).join('')}<p class="free-score-note">Readiness uses Layers 1–4 with their weights rescaled to 100%.</p></section>
    <section class="free-gaps"><h2>Top 3 Gaps Identified</h2><p>Ranked by how much each one is costing the total score.</p><ol>${gaps.map(g => `<li><h3>${esc(r.layers?.[g.layer]?.name || 'Readiness gap')}</h3><p>${esc(g.message)}</p></li>`).join('')}</ol>${gaps.length ? '' : '<p>No scored gaps identified.</p>'}</section>
    <div class="free-upgrade"><div><h2>See what matters. Unlock exactly how to fix it.</h2><p>Your store-specific fixes are ready.</p></div><button type="button" data-view="full">View premium report →</button></div>
  </div>
  ${full ? `<div id="full-detail" class="hidden" tabindex="-1"><div class="report-actions"><button type="button" data-view="free">← Free report</button><button type="button" data-print>Download PDF</button></div><div class="preview-notice" tabindex="-1"><b>${preview ? 'Full report preview' : 'Your full report'}</b><span>${preview ? 'Local preview · No email sent or payment collected' : 'Private report · Commerce.Anphonic.ai'}</span></div><article class="report-document">${renderDetailedReport(r)}<section class="fix-roadmap"><div class="sechead"><h3>Fix Roadmap</h3></div><p class="muted">Recommendations from this scan. Effort and timing require implementation review.</p>${fixes.length ? `<div class="benchmark-scroll"><table><thead><tr><th>Recommended task</th><th>Current score</th><th>Implementation</th></tr></thead><tbody>${fixes.map(c => `<tr><td>${esc(c.fix.headline)}</td><td>${c.value}/100</td><td>${esc(c.fix.where || 'Review check details')}</td></tr>`).join('')}</tbody></table></div>` : '<p>No implementation recommendations are available for this scan.</p>'}</section></article><div class="report-actions"><button type="button" data-view="free">← Free report</button><button type="button" data-print>Download PDF</button></div></div>` : ''}`;
}

document.getElementById('report').addEventListener('click', event => {
  if (event.target.closest('[data-print]')) window.print();
});
