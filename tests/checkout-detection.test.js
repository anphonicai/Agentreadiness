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

// Native detection is market-independent and must not infer it from an empty app list.
test('native Shopify evidence detects UAE storefront runtime and cart markup', async () => {
  const {nativeCheckoutSignals} = await import('../engine.js');
  const html = `Shopify.country="AE"; Shopify.PaymentButton=Shopify.PaymentButton||{};<form action="/cart" method="post">`;
  assert.deepEqual(nativeCheckoutSignals(html, true), ['Shopify payment-button runtime', 'Shopify cart form']);
  assert.deepEqual(nativeCheckoutSignals(html, false), []);
  assert.deepEqual(nativeCheckoutSignals('Shopify.shop="example.myshopify.com";', true), []);
  assert.deepEqual(nativeCheckoutSignals('<style>.shopify-payment-button {color:red}</style>', true), []);
  assert.deepEqual(nativeCheckoutSignals('<shopify-accelerated-checkout-cart >', true), ['Shopify accelerated checkout element']);
  assert.deepEqual(nativeCheckoutSignals('<form action="/en-ae/cart">', true), ['Shopify cart form']);
  assert.deepEqual(nativeCheckoutSignals('<form action="/cartoon">', true), []);
});

test('native signals do not replace detected third-party apps', async () => {
  const {nativeCheckoutSignals} = await import('../engine.js');
  const html = 'Shopify.PaymentButton={};<script src="https://cdn.shopflo.com/checkout.js"></script>';
  assert.deepEqual(detect(html), ['Shopflo']);
  assert.deepEqual(nativeCheckoutSignals(html, true), ['Shopify payment-button runtime']);
});

test('native cart evidence supports international locales and same-origin absolute URLs', async () => {
  const {nativeCheckoutSignals} = await import('../engine.js');
  for (const path of ['/cart', '/ar/cart', '/en-ae/cart', '/en-IN/cart/', '/fr-ca/cart?checkout=1', '/zh-Hant-TW/cart', '/fil/cart']) {
    for (const action of [path, 'https://example.com' + path]) {
      assert.deepEqual(nativeCheckoutSignals(`<form action="${action}">`, true, 'https://example.com/products/item'), ['Shopify cart form'], action);
    }
  }
  for (const html of ['<form action="https://other.com/cart">', '<!-- <form action="/cart"> -->', `<script>const template='<form action="/cart">';</script>`, '<form data-action="/cart">']) {
    assert.deepEqual(nativeCheckoutSignals(html, true, 'https://example.com'), []);
  }
  assert.deepEqual(nativeCheckoutSignals('<form action=/cart>', true), ['Shopify cart form']);
});
