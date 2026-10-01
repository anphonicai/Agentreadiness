import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {unscannable, observedRating} from '../engine.js';

test('a store whose product pages all fail is never scored', () => {
  // shop.truvani.com served a full products.json while every /products/<handle>
  // returned 404. Scoring that produced zeros on every schema check.
  const allFailed = {products: [{pageOk: false}, {pageOk: false}], errors: []};
  assert.equal(unscannable(allFailed), 'NO_PRODUCT_PAGES');

  // One readable page is enough to score: the sample is thin, not absent.
  assert.equal(unscannable({products: [{pageOk: false}, {pageOk: true}], errors: []}), null);
  assert.equal(unscannable({products: [{pageOk: true}], errors: []}), null);
});

test('fatal collection errors stop a score being published', () => {
  for (const e of ['NO_RESPONSE', 'NOT_SHOPIFY', 'NO_CATALOG']) {
    assert.equal(unscannable({products: [{pageOk: true}], errors: [e]}), e);
  }
  // A non-fatal note alongside readable pages still scores.
  assert.equal(unscannable({products: [{pageOk: true}], errors: ['BLOCKED_403']}), null);
  // Nothing collected at all.
  assert.equal(unscannable({errors: ['NO_RESPONSE']}), 'NO_RESPONSE');
  assert.equal(unscannable({products: [], errors: []}), null);
});

test('review apps are detected by their asset, not their name in prose', () => {
  const source = readFileSync(new URL('../engine.js', import.meta.url), 'utf8');
  const cut = (a, b) => { const i = source.indexOf(a); return source.slice(i, source.indexOf(b, i) + b.length); };
  const ctx = {};
  runInNewContext([
    cut('const REVIEW_APPS = [', '];'),
    cut('const DISABLED_FLAG =', ';'),
    cut('const withoutDisabledFlags =', ';'),
    'this.REVIEW_APPS = REVIEW_APPS; this.withoutDisabledFlags = withoutDisabledFlags;',
  ].join('\n'), ctx);
  const detect = html => Array.from(ctx.REVIEW_APPS.filter(a => a.re.test(ctx.withoutDisabledFlags(html))), a => a.key);

  assert.deepEqual(detect('<script src="https://cdn.judge.me/loader.js"></script>'), ['Judge.me']);
  assert.deepEqual(detect('<script src="https://staticw2.yotpo.com/x/widget.js"></script>'), ['Yotpo']);
  // The app name is quoted back in the merchant's recommendation, so prose,
  // comparison links and disabled flags must not register as installed.
  assert.deepEqual(detect('We compared Yotpo and Junip before choosing.'), []);
  assert.deepEqual(detect('"growave_enabled":false'), []);
  assert.deepEqual(detect('Read our Trustpilot reviews policy page'), []);
});

test('a rating is reported only when the page really states one', () => {
  const found = h => observedRating(h, {appPresent: true});

  // Real aggregates, however the app renders them.
  assert.deepEqual(found("data-average-rating='4.50' data-number-of-reviews='4'"), {status:'found', count:4, value:4.5});
  assert.deepEqual(found('<span itemprop="ratingValue" content="4.8"></span><span itemprop="reviewCount" content="12"></span>'), {status:'found', count:12, value:4.8});
  assert.equal(found('Based on 34 reviews').count, 34);

  // superyou.in carried a stray "8" ending one element and a "Reviews" heading
  // in the next; \s+ spanned the newline and invented eight reviews.
  assert.equal(found('<span>8</span>\n        <h3>Reviews</h3>').status, 'untraceable');

  // A bare data-rating is one star in a widget's markup, not an aggregate.
  assert.equal(found("data-rating='5' data-rating='4' data-rating='3'").status, 'untraceable');

  // A widget reporting zero was read successfully; that is not the same as
  // failing to read it, and neither is the same as there being no widget.
  assert.equal(found("data-number-of-reviews='0' data-average-rating='0.00'").status, 'none');
  assert.equal(found('<div class="jdgm-widget"></div>').status, 'untraceable');
  assert.equal(observedRating('<p>a page with no review app</p>'), null);
});
