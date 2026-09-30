import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the shipped definitions rather than a copy that can drift.
const source = readFileSync(new URL('../engine.js', import.meta.url), 'utf8');
const slice = (startMarker, endMarker) => {
  const a = source.indexOf(startMarker);
  assert.ok(a > -1, `${startMarker} not found`);
  const b = source.indexOf(endMarker, a);
  return source.slice(a, b + endMarker.length);
};
const context = {};
runInNewContext([
  slice('const CHECKOUT_STACKS = [', '];'),
  slice('const DISABLED_FLAG =', ';'),
  slice('const withoutDisabledFlags =', ';'),
  // const bindings are lexical and never land on the context object.
  'this.CHECKOUT_STACKS = CHECKOUT_STACKS; this.withoutDisabledFlags = withoutDisabledFlags;',
].join('\n'), context);
const {CHECKOUT_STACKS, withoutDisabledFlags} = context;
const detect = html => Array.from(CHECKOUT_STACKS.filter(c => c.re.test(withoutDisabledFlags(html))), c => c.key);

test('a checkout app named only to switch it off is not an installation', () => {
  // Both of these shipped in real reports as the store's checkout stack.
  assert.deepEqual(detect('{"view_more_button_text":"MORE INFO","enable_shopflo_checkout":false}'), []);
  assert.deepEqual(detect('skipPage3 : simplyOtp.skip ?? false, goKwik:false, onlyIndia: false'), []);
  for (const off of ['"gokwik":false', "shopflo: 0", '"enable_snapmint":"false"', 'fastrr = null']) {
    assert.deepEqual(detect(off), [], `expected no detection for ${off}`);
  }
});

test('a real integration is still detected by the asset it loads', () => {
  assert.deepEqual(detect('<script src="https://pdp-widget.gokwik.co/v1/gokwik.js"></script>'), ['GoKwik']);
  assert.deepEqual(detect('<script src="https://cdn.shopflo.com/checkout.js"></script>'), ['Shopflo']);
  assert.deepEqual(detect('<script src="https://checkout.razorpay.com/v1/magic-checkout.js"></script>'), ['RazorpayMagic']);
  assert.deepEqual(detect('https://app.snapmint.com/widget'), ['Snapmint']);
  assert.deepEqual(detect('https://api.shiprocket.in/track'), ['Shiprocket']);
});

test('prose and unrelated words never register as a checkout stack', () => {
  assert.deepEqual(detect('We keep it simple: simply the best. A simpler checkout.'), []);
  assert.deepEqual(detect('Read our blog post comparing GoKwik and Shopflo for Indian brands.'), []);
});

test('a store can legitimately run more than one stack', () => {
  const both = detect('<script src="https://cdn.shopflo.com/a.js"></script><img src="https://snapmint.com/p.gif">');
  assert.deepEqual(both.sort(), ['Shopflo', 'Snapmint']);
});
