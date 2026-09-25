import { readFile } from 'node:fs/promises';
import { scanStore, SUB, WEIGHTS, LAYER2_SPEC, LAYER4_SPEC } from './engine.js';

export const METHOD_VERSION = 'competitive-v1';
export const COMPETITORS = JSON.parse(await readFile(new URL('./competitors.json', import.meta.url), 'utf8'));
const LAYERS = ['layer1', 'layer2', 'layer4'];
const round = n => Math.round(n * 10) / 10;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export function domainKey(value) {
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  return url.hostname.toLowerCase().replace(/^www\./, '');
}
const numericScore = value => Number.isFinite(value) && value >= 0 && value <= 100;
const contentMethod = r => r.llm?.used ? `llm:${r.llm.model}` : 'heuristic';
const labels = Object.fromEntries([
  ...LAYER2_SPEC, ...LAYER4_SPEC,
  { key: 'pageWeight', label: 'Page weight and response time' },
  { key: 'botWall', label: 'Crawler access' },
  { key: 'productFeed', label: 'Product feed and indexability' },
].map(c => [c.key, c.label]));

function invalidReason(r, client) {
  if (!r?.layers || !numericScore(r.finalScore)) return r?.errors?.join(', ') || 'Scan unavailable';
  if (r.errors?.length) return r.errors.join(', ');
  if (r.homeStatus !== 200) return 'Homepage was not successfully measured';
  if (!r.sampled || r.sampled !== r.sampleAttempted) return 'Incomplete product-page sample';
  if (Object.values(r.botVerdicts || {}).some(v => v === 'no response')) return 'Crawler access measurement incomplete';
  if (!Number.isFinite(Date.parse(r.scannedAt))) return 'Missing scan timestamp';
  if (LAYERS.some(layer => Object.keys(SUB[layer]).some(key => !numericScore(r.layers[layer]?.checks?.[key])))) return 'Missing scored checks';
  if (client) {
    if (r.version !== client.version) return 'Different engine version';
    if (contentMethod(r) !== contentMethod(client)) return 'Different content grading method';
    if (Math.abs(Date.parse(r.scannedAt) - Date.parse(client.scannedAt)) > 24 * 60 * 60 * 1000) return 'Scans more than 24 hours apart';
  }
  return null;
}

export function buildCompetitiveReport(client, competitors, namedDomains) {
  const names = [...new Set(namedDomains.map(domainKey))].filter(d => d !== domainKey(client.domain));
  if (names.length > 5) throw new Error('Use at most five named competitors');
  const clientIssue = invalidReason(client);
  const byDomain = new Map(competitors.map(r => [domainKey(r.domain), r]));
  const entries = names.map(domain => {
    const result = byDomain.get(domain);
    const reason = invalidReason(result, client);
    return { domain, result, reason };
  });
  const eligible = entries.filter(e => !e.reason);
  const usable = clientIssue ? [] : eligible;
  const totalWeight = LAYERS.reduce((n, layer) => n + WEIGHTS[layer], 0);
  const rows = usable.length ? LAYERS.flatMap(layer => Object.entries(SUB[layer]).map(([check, weight]) => {
    const value = client.layers[layer].checks[check];
    const values = usable.map(e => ({ domain: e.domain, value: e.result.layers[layer].checks[check] }));
    const midpoint = median(values.map(v => v.value));
    const points = values.reduce((sum, peer) => sum + (value > peer.value ? 1 : value === peer.value ? 0.5 : 0), 0);
    const detail = client[`${layer}Report`]?.checks?.find(c => c.key === check);
    return {
      layer, check, label: labels[check], client: value, competitors: values,
      median: round(midpoint), delta: round(value - midpoint),
      relativeScore: 100 * points / values.length,
      weight: WEIGHTS[layer] / totalWeight * weight,
      evidence: detail?.evidence || null, fix: detail?.fix || null,
      basis: detail?.basis || 'measured',
    };
  })) : [];
  const score = rows.length ? round(rows.reduce((n, row) => n + row.relativeScore * row.weight, 0)) : null;
  const status = clientIssue || !usable.length ? 'unavailable' : usable.length < 3 ? 'provisional' : 'complete';
  const contribution = status === 'complete' ? round(score * WEIGHTS.layer5) : null;
  // Use unrounded layer scores, not 85% of the already rounded readiness total.
  const readinessPoints = Object.entries(client.layers || {}).reduce((n, [key, layer]) => n + layer.score * (WEIGHTS[key] || 0), 0);
  const combinedScore = status === 'complete' ? round(readinessPoints + score * WEIGHTS.layer5) : null;
  const gaps = rows.filter(row => row.delta < 0)
    .sort((a, b) => (-b.delta * b.weight) - (-a.delta * a.weight)).slice(0, 3);
  const checkout = [{ domain: domainKey(client.domain), result: client }, ...entries].map(({ domain, result }) => ({
    domain,
    detectedApps: result?.checkoutStack || [],
    declarationScore: numericScore(result?.layers?.layer3?.checks?.ucpProfile) ? result.layers.layer3.checks.ucpProfile : null,
    evidence: result?.layer3Report?.checks?.find(c => c.key === 'ucpProfile')?.result || 'Not measured',
    note: 'Public detection only; no purchase or live checkout was tested. No detected app does not confirm native checkout.',
  }));
  return {
    methodVersion: METHOD_VERSION, engineVersion: client.version || null,
    domain: domainKey(client.domain), scannedAt: client.scannedAt || null,
    status, score, contribution, combinedScore, readinessScore: client.finalScore,
    weight: 15, checkWeight: 100, namedCount: names.length, comparedCount: usable.length,
    minimumCompetitors: 3, clientIssue,
    competitors: entries.map(e => ({
      domain: e.domain, status: e.reason ? 'unavailable' : 'measured', reason: e.reason,
      sampled: e.result?.sampled || 0, scannedAt: e.result?.scannedAt || null,
      readinessScore: e.reason ? null : e.result.finalScore,
      layers: e.reason ? null : Object.fromEntries(LAYERS.map(k => [k, e.result.layers[k].score])),
    })),
    rows, gaps, checkout,
    methodology: 'One Layer 5 check (100% of this layer): weighted relative position on the scored checks in Layers 1, 2 and 4. Each competitor beaten earns 1, a tie 0.5, a loss 0. Layer weights 20:25:15 and existing within-layer weights are normalized across those checks. All ties = 50. Layer 3 is informational. The 15% contribution requires 3–5 comparable competitors.',
    limitations: [
      'A relative score, not AI recommendation frequency, sales performance, or a successful agent purchase.',
      'Up to 20 product pages per store; different catalogues, not matched product pairs.',
      'Existing checklist heuristics and baselines are reused; check scores are not all coverage percentages.',
      'Scans with reported errors, incomplete product samples or missing crawler responses are excluded, never scored as zero. Scans must share an engine version, content method, and 24-hour window.',
      'Requested domains are sampled as served to this scanner; geographic storefront and product-category matching are not verified.',
      'Site content, response times, and competitor selection can change the result.',
    ],
  };
}

export async function scanWithCompetitors(domain, onProgress = () => {}) {
  const key = domainKey(domain);
  const names = Object.hasOwn(COMPETITORS, key) ? COMPETITORS[key] : null;
  if (!names) return scanStore(domain, onProgress);
  const client = await scanStore(domain, onProgress, { contentMethod: 'heuristic' });
  const peers = [];
  for (const peer of names) {
    onProgress(`Comparing ${peer}`);
    try { peers.push(await scanStore(peer, step => onProgress(`Comparing ${peer}: ${step}`), { contentMethod: 'heuristic' })); }
    catch (error) { peers.push({ domain: peer, errors: [error.message], finalScore: null }); }
  }
  return { ...client, layer5Report: buildCompetitiveReport(client, peers, names) };
}
