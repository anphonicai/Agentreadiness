import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { buildCompetitiveReport, domainKey } from '../competitive.js';
import { SUB, VERSION } from '../engine.js';

function scan(domain, value = 60, override = {}) {
  return {
    domain, version: VERSION, scannedAt: '2026-09-18T06:00:00.000Z',
    homeStatus: 200, sampled: 20, sampleAttempted: 20, errors: [],
    botVerdicts: { GPTBot: 'ok', ClaudeBot: 'ok', PerplexityBot: 'ok' },
    finalScore: value, checkoutStack: [], llm: { used: false },
    layers: Object.fromEntries(Object.entries(SUB).map(([layer, checks]) => [layer, {
      score: value, checks: Object.fromEntries(Object.keys(checks).map(key => [key, value])),
    }])), ...override,
  };
}
const names = ['a.example', 'b.example', 'c.example'];
const compare = (clientValue, peerValue, domains = names) => buildCompetitiveReport(
  scan('client.example', clientValue), domains.map(d => scan(d, peerValue)), domains,
);
test('ties score 50, full wins 100, full losses zero; combined weight is exactly 15%', () => {
  assert.equal(compare(60, 60).score, 50);
  assert.equal(compare(60, 60).combinedScore, 58.5);
  assert.equal(compare(80, 40).score, 100);
  assert.equal(compare(80, 40).combinedScore, 83);
  assert.equal(compare(40, 80).score, 0);
  assert.equal(compare(40, 80).combinedScore, 34);
  assert.equal(compare(60, 60).contribution, 7.5);
});
test('one or two competitors stay provisional and do not contribute', () => {
  for (const count of [1, 2]) {
    const report = compare(80, 40, names.slice(0, count));
    assert.equal(report.status, 'provisional');
    assert.equal(report.score, 100);
    assert.equal(report.combinedScore, null);
    assert.equal(report.contribution, null);
  }
});
test('unavailable competitor is not a zero and even-count median averages the middle', () => {
  const report = buildCompetitiveReport(scan('client.example', 60), [scan(names[0], 20), scan(names[1], 80), { domain: names[2], errors: ['NO_CATALOG'], finalScore: null }], names);
  assert.equal(report.score, 50);
  assert.equal(report.rows[0].median, 50);
  assert.equal(report.comparedCount, 2);
  assert.equal(report.competitors[2].reason, 'NO_CATALOG');
});
test('mismatched engine, method, timestamp and incomplete samples are excluded', () => {
  for (const override of [{ version: 'old' }, { llm: { used: true, model: 'other' } }, { scannedAt: '2026-09-15T00:00:00Z' }, { sampled: 19 }, { scannedAt: undefined }, { homeStatus: 403 }]) {
    const report = buildCompetitiveReport(scan('client.example'), [scan(names[0], 60, override)], [names[0]]);
    assert.equal(report.status, 'unavailable');
    assert.equal(report.score, null);
    assert.ok(report.competitors[0].reason);
  }
});
test('an unscannable client never receives a relative score', () => {
  const report = buildCompetitiveReport({ domain: 'client.example', errors: ['NO_RESPONSE'], finalScore: null }, names.map(d => scan(d)), names);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.score, null);
  assert.equal(report.clientIssue, 'NO_RESPONSE');
});
test('self comparisons and duplicate domains cannot satisfy minimum competitors', () => {
  const report = buildCompetitiveReport(scan('https://www.client.example'), [scan('a.example')], ['client.example', 'a.example', 'https://www.a.example/path']);
  assert.equal(report.namedCount, 1);
  assert.equal(report.status, 'provisional');
  assert.equal(domainKey('HTTPS://WWW.A.EXAMPLE/path'), 'a.example');
});
test('Layer 3 does not affect relative position, while Layer 1:2:4 weights are 20:25:15', () => {
  const client = scan('client.example', 60);
  for (const key of Object.keys(client.layers.layer2.checks)) client.layers.layer2.checks[key] = 100;
  client.layers.layer3.checks.ucpProfile = 0;
  const report = buildCompetitiveReport(client, names.map(d => scan(d)), names);
  assert.equal(report.score, 70.8);
  assert.ok(Math.abs(report.rows.reduce((sum, row) => sum + row.weight, 0) - 1) < 1e-10);
  assert.ok(report.rows.every(row => row.layer !== 'layer3'));
});
test('missing scored checks and no peers never produce misleading scores', () => {
  const peer = scan(names[0]);
  delete peer.layers.layer2.checks.productSchema;
  assert.equal(buildCompetitiveReport(scan('client.example'), [peer], [names[0]]).score, null);
  assert.equal(compare(60, 60, []).score, null);
});
test('excess competitors are rejected', () => {
  assert.throws(() => compare(60, 60, ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com']), /at most five/);
});
test('browser renders complete, provisional, unavailable and unconfigured states and escapes content', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fakeElement = { addEventListener() {} };
  const context = {
    document: { getElementById: () => fakeElement },
    fetch: async () => { throw new Error('No network in render test'); },
  };
  runInNewContext(script, context);
  for (const domains of [names, names.slice(0, 2), []]) {
    const report = compare(60, 60, domains);
    const output = context.renderLayer5(report);
    assert.ok(output.includes(report.status.toUpperCase()));
    assert.ok(!output.includes('undefined'));
    assert.ok(!output.includes('NaN'));
  }
  assert.match(context.renderLayer5(null), /NOT CONFIGURED/);
  const hostile = compare(60, 60);
  hostile.competitors[0].reason = '<img src=x onerror=alert(1)>';
  assert.ok(!context.renderLayer5(hostile).includes('<img'));
});
