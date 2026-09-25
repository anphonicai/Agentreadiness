// Contact details persist through the leads API. Scans use the existing API.
// Email verification is checked by the server before a scan starts.
let pendingStore = '';
let demoUnlocked = false;
let verificationToken = '';
let challengeId = '';
async function requestCode() {
  verificationToken = '';
  const response = await fetch('/api/otp/request', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:$('contact-name').value.trim(),email:$('contact-email').value.trim(),url:pendingStore,consent:$('contact-consent').checked}),signal:AbortSignal.timeout(20000)});
  const result = await response.json();
  if(!response.ok) throw new Error(result.error || 'Unable to send code.');
  challengeId=result.challengeId;
  resetCodeTimer();
}
let resendAvailable = 0;
let resendTimer;

async function beginJourney(value) {
  if ($('go').disabled) return;
  clearError();
  $('url').removeAttribute('aria-invalid');
  $('go').disabled = true;
  $('go').textContent = 'Checking store…';
  let suggestion = false;
  $('form').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/store', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({url:value}), signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) throw new Error('The server needs a restart. Stop it with Ctrl+C, run node server.js, then try again.');
    const result = await response.json().catch(() => { throw new Error('The server returned an unexpected response. Please try again.'); });
    if (!response.ok || !result.url) throw new Error(result.error || 'Unable to check the URL. Please try again.');
    if (result.needsConfirmation) {
      suggestion = true;
      $('url').value = result.url;
      showError(`We couldn’t identify the official website from that name. Suggested URL: ${result.url}. Check or edit it, then continue.`);
      $('url').focus();
      return;
    }
    pendingStore = result.url;
    $('url').value = pendingStore;
    document.querySelectorAll('.journey-store').forEach(node => { node.textContent = pendingStore; });
    setScreen('consent');
  } catch (error) {
    showError(error.name === 'TimeoutError' ? 'The request timed out. Please try again.' : error.message || 'Unable to connect. Please try again.');
    $('url').setAttribute('aria-invalid', 'true');
    $('url').focus();
  } finally {
    $('go').disabled = false;
    $('go').textContent = suggestion ? 'Use this URL →' : 'Analyse store →';
    $('form').removeAttribute('aria-busy');
  }
}
$('url').addEventListener('input', () => {
  if (!$('go').disabled) $('go').textContent = 'Analyse store →';
  clearError();
  $('url').removeAttribute('aria-invalid');
});

function resetCodeTimer() {
  resendAvailable = Date.now() + 30 * 1000;
  $('verification-code').value = '';
  updateCodeBoxes();
  $('verification-error').classList.add('hidden');
  clearInterval(resendTimer);
  const update = () => {
    const seconds = Math.max(0, Math.ceil((resendAvailable - Date.now()) / 1000));
    $('resend-code').disabled = seconds > 0;
    $('resend-code').textContent = seconds ? `Resend code in ${seconds}s` : 'Resend code';
    if (!seconds) clearInterval(resendTimer);
  };
  update();
  resendTimer = setInterval(update, 1000);
}

$('consent-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('contact-name');
  name.setCustomValidity(name.value.trim() ? '' : 'Enter your name.');
  if (!$('consent-form').reportValidity()) return;
  const button = $('consent-form').querySelector('button[type="submit"]');
  if (button.disabled) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving…';
  $('consent-error').classList.add('hidden');
  try {
    await requestCode();
    $('verification-email').textContent = $('contact-email').value.trim();
    $('resend-status').textContent = '';
    resetCodeTimer();
    if (document.body.dataset.screen === 'consent') setScreen('verification');
  } catch (error) {
    $('consent-error').textContent = error.name === 'TimeoutError' ? 'Saving took too long. Please try again.' : error.message || 'Unable to save your details. Please try again.';
    $('consent-error').classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});
$('contact-name').addEventListener('input', () => $('contact-name').setCustomValidity(''));
$('verification-code').addEventListener('input', () => {
  $('verification-code').value = $('verification-code').value.replace(/\D/g, '').slice(0, 6);
  $('verification-error').classList.add('hidden');
});
$('verification-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('verification-form').reportValidity()) return;
  const button=$('verification-form').querySelector('button[type="submit"]');
  if(button.disabled) return;
  button.disabled=true;
  try {
    const response=await fetch('/api/otp/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challengeId,code:$('verification-code').value}),signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok) throw new Error(result.error || 'Unable to verify code.');
    verificationToken=result.verificationToken;
    clearInterval(resendTimer);
    run(pendingStore);
  } catch(error) {
    $('verification-error').textContent=error.message;
    $('verification-error').classList.remove('hidden');
  } finally {button.disabled=false;}
});
$('resend-code').addEventListener('click', async () => {
  $('resend-code').disabled=true;
  try {await requestCode();$('resend-status').textContent='A new code has been sent. Check your inbox.';}
  catch(error) {$('resend-status').textContent=error.message;$('resend-code').disabled=false;}
});
document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => {
  clearInterval(resendTimer);
  setScreen(button.dataset.back);
}));

function openPayment() {
  document.querySelector('.price-card > p').textContent = checkoutAvailable ? 'USD · one-time payment' : 'USD · once · design preview';
  document.querySelector('.price-card > small').textContent = checkoutAvailable ? 'Secure payment via Stripe · Report link by email' : 'Preview checkout · No charge';
  if (!checkoutAvailable && !reportPreviewAvailable) {
    document.querySelector('.price-card > p').textContent = 'USD · one-time report · coming soon';
    document.querySelector('.price-card > small').textContent = 'Your free report is ready. Paid reports will be available soon.';
    $('checkout-open').textContent = 'Paid reports coming soon';
    $('checkout-open').disabled = true;
  }
  $('payment-status').textContent = '';
  setScreen('upgrade');
}
$('checkout-open').addEventListener('click', () => {
  $('name-preview').value = $('contact-name').value.trim() || 'Demo customer';
  $('demo-payment').disabled = !reportPreviewAvailable && !checkoutAvailable;
  $('demo-payment').textContent = checkoutAvailable ? 'Pay $249 & unlock report →' : 'Preview full report →';
  document.querySelectorAll('.journey-form > input, .journey-form > label').forEach(el => el.classList.toggle('hidden', checkoutAvailable));
  // A code is worth offering whenever a real report can be unlocked by one.
  $('coupon-box').classList.toggle('hidden', !couponsAvailable || (!checkoutAvailable && !reportPreviewAvailable));
  $('coupon-status').textContent = '';
  $('coupon-code').value = '';
  $('coupon-apply').disabled = false;
  appliedCode = '';
  document.querySelector('.payment-card .journey-kicker').textContent = checkoutAvailable ? 'SECURE STRIPE CHECKOUT' : 'DEMO · NO CHARGE';
  document.querySelector('.payment-card small').textContent = checkoutAvailable ? 'Enter your payment details securely on Stripe.' : 'Payment integration not configured';
  document.querySelector('.checkout-copy .journey-kicker').textContent = checkoutAvailable ? 'CHECKOUT' : 'CHECKOUT PREVIEW';
  document.querySelector('.checkout-copy .journey-notice').textContent = 'Your report will be emailed after confirmed payment.';
  $('payment-status').textContent = checkoutAvailable ? 'After payment, your report opens here and a private link is emailed to you.' : reportPreviewAvailable ? 'Demo checkout. No payment collected or email sent.' : 'Email delivery follows confirmed payment. Checkout is not connected yet.';
  setScreen('payment');
});
function updateCodeBoxes() {
  document.querySelectorAll('.code-boxes span').forEach((box, index) => {
    box.textContent = $('verification-code').value[index] || '';
  });
}
$('verification-code').addEventListener('input', updateCodeBoxes);
$('resend-code').addEventListener('click', updateCodeBoxes);
