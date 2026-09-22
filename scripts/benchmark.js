import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { scanStore, VERSION } from '../engine.js';
import { buildCompetitiveReport, COMPETITORS } from '../competitive.js';

const output = resolve('reports/layer5');
await mkdir(join(output, 'scans'), { recursive: true });
const requested = process.argv[2];
if (requested && !COMPETITORS[requested]) throw new Error('Unknown client; use one of the domains in competitors.json');
const sets = requested ? { [requested]: COMPETITORS[requested] } : COMPETITORS;
const domains = [...new Set(Object.entries(sets).flatMap(([client, peers]) => [client, ...peers]))];
const results = new Map();
let next = 0;
await Promise.all(Array.from({ length: Math.min(2, domains.length) }, async () => {
  while (next < domains.length) {
    const domain = domains[next++];
    let result;
    console.error(`Scanning ${domain}`);
    try { result = await scanStore(domain, step => console.error(`[${domain}] ${step}`), { contentMethod: 'heuristic' }); }
    catch (error) { result = { domain, errors: [error.message], finalScore: null }; }
    results.set(domain, result);
    await writeFile(join(output, 'scans', `${domain}.json`), JSON.stringify(result, null, 2));
    console.error(`Finished ${domain}: ${result.finalScore ?? 'unavailable'} (${result.sampled || 0} products)`);
  }
}));
const summaries = [];
let markdown = `# Layer 5 — Competitive Position\n\nGenerated ${new Date().toISOString()} · engine ${VERSION}\n\nScores below are relative position on Layers 1, 2 and 4; checkout is informational. All ties = 50. The combined score is available only with at least three comparable competitors.\n`;
for (const [domain, names] of Object.entries(sets)) {
  const client = results.get(domain);
  const report = buildCompetitiveReport(client, names.map(d => results.get(d)), names);
  const full = { ...client, layer5Report: report };
  await writeFile(join(output, `${domain}.json`), JSON.stringify(full, null, 2));
  summaries.push({ domain, status: report.status, readiness: client.finalScore, competitive: report.score, compared: report.comparedCount, named: names.length, combined: report.combinedScore });
  markdown += `\n## ${domain}\n\nStatus: **${report.status}** · ${report.comparedCount}/${names.length} competitors comparable · Layer 5: **${report.score ?? 'N/A'}/100** · Readiness: ${client.finalScore ?? 'N/A'}/100 · Combined: ${report.combinedScore ?? 'not included'}\n\n`;
  if (report.clientIssue) markdown += `Client scan issue: ${report.clientIssue}\n\n`;
  markdown += '| Competitor | Status | Sampled |\n|---|---|---:|\n';
  for (const peer of report.competitors) markdown += `| ${peer.domain} | ${peer.reason || peer.status} | ${peer.sampled} |\n`;
  if (report.rows.length) {
    markdown += '\n| Check (score /100) | Client | Competitor median | Gap |\n|---|---:|---:|---:|\n';
    for (const row of report.rows) markdown += `| ${row.label} | ${round(row.client)} | ${row.median} | ${row.delta > 0 ? '+' : ''}${row.delta} |\n`;
    markdown += '\nPriority gaps:\n\n' + (report.gaps.length ? report.gaps.map(g => `- ${g.label}: ${g.client} vs median ${g.median}. ${g.fix?.headline || 'Inspect the evidence and existing layer recommendations.'}`).join('\n') : '- No measured checks below the competitor median.') + '\n';
  }
  markdown += '\nPublic checkout detection (not a completed purchase):\n\n';
  for (const entry of report.checkout) markdown += `- ${entry.domain}: ${entry.evidence}; detected apps: ${entry.detectedApps.join(', ') || 'none detected'}.\n`;
}
await writeFile(join(output, 'summary.json'), JSON.stringify(summaries, null, 2));
await writeFile(join(output, 'summary.md'), markdown);
console.table(summaries);
console.log(`Reports saved to ${output}`);
function round(n) { return Math.round(n * 10) / 10; }
