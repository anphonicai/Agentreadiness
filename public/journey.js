// Contact details persist through the leads API. Scans use the existing API.
// Demo verification and checkout do not grant production authentication/access.
let pendingStore = '';
let demoUnlocked = false;
let verificationExpires = 0;
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

function resetDemoCode() {
  verificationExpires = Date.now() + 5 * 60 * 1000;
  resendAvailable = Date.now() + 30 * 1000;
  $('verification-code').value = '';
  updateCodeBoxes();
  $('verification-error').classList.add('hidden');
  clearInterval(resendTimer);
  const update = () => {
    const seconds = Math.max(0, Math.ceil((resendAvailable - Date.now()) / 1000));
    $('resend-code').disabled = seconds > 0;
    $('resend-code').textContent = seconds ? `Reset demo code in ${seconds}s` : 'Reset demo code';
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
    const response = await fetch('/api/leads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.value.trim(), email: $('contact-email').value.trim(), url: pendingStore, consent: $('contact-consent').checked }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result.saved) throw new Error(result.error || 'Unable to save your details. Please try again.');
    $('verification-email').textContent = $('contact-email').value.trim();
    $('resend-status').textContent = '';
    resetDemoCode();
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
$('verification-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('verification-form').reportValidity()) return;
  const error = Date.now() > verificationExpires
    ? 'Demo code expired. Reset the code to continue.'
    : $('verification-code').value !== '123456' ? 'Incorrect demo code. Enter 123456.' : '';
  if (error) {
    $('verification-error').textContent = error;
    $('verification-error').classList.remove('hidden');
    $('verification-code').focus();
    return;
  }
  clearInterval(resendTimer);
  run(pendingStore);
});
$('resend-code').addEventListener('click', () => {
  resetDemoCode();
  $('resend-status').textContent = 'Demo code reset to 123456. No email was sent.';
});
document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => {
  clearInterval(resendTimer);
  setScreen(button.dataset.back);
}));

function openPayment() {
  $('payment-status').textContent = '';
  setScreen('upgrade');
}
$('demo-payment').addEventListener('click', () => {
  if (!$('full-detail')) return;
  demoUnlocked = true;
  setScreen('report');
  $('full-detail').classList.remove('hidden');
  $('paid-preview').classList.add('hidden');
  const notice = document.querySelector('#full-detail .preview-notice');
  notice.setAttribute('tabindex', '-1');
  notice.focus();
  notice.scrollIntoView({block:'start'});
});

$('checkout-open').addEventListener('click', () => {
  $('name-preview').value = $('contact-name').value.trim() || 'Demo customer';
  setScreen('payment');
});
function updateCodeBoxes() {
  document.querySelectorAll('.code-boxes span').forEach((box, index) => {
    box.textContent = $('verification-code').value[index] || '';
  });
}
$('verification-code').addEventListener('input', updateCodeBoxes);
$('resend-code').addEventListener('click', updateCodeBoxes);
