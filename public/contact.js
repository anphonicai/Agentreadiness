const params = new URLSearchParams(location.search);
const store = document.getElementById('review-store');
const message = document.getElementById('review-message');
try {
  const url = new URL(params.get('store'));
  if (['https:', 'http:'].includes(url.protocol)) store.value = url.origin;
} catch { /* A direct visit starts with an empty store field. */ }
const reasons = {
  NO_CATALOG: 'The scan could not sample my store’s public product feed.',
  NO_RESPONSE: 'My store did not respond to the scanner.',
  NOT_SHOPIFY: 'My store was not identified as a supported Shopify storefront.',
};
if (store.value) {
  message.value = `${reasons[params.get('reason')] || 'The automated scan could not be completed.'}\n\nCould you help me understand the next steps and discuss a manual review?`;
}
document.getElementById('review-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  const status = document.getElementById('review-status');
  button.disabled = true;
  button.textContent = 'Sending…';
  status.textContent = '';
  try {
    const response = await fetch('/api/contact', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        name:document.getElementById('review-name').value.trim(),
        email:document.getElementById('review-email').value.trim(),
        company:document.getElementById('review-company').value.trim(),
        url:store.value, message:message.value.trim(),
      }), signal:AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok || !result.saved) throw new Error(result.error || 'Unable to save your enquiry. Please try again.');
    status.textContent = 'Thank you. Your enquiry has been saved. Our team will reach out to you by email.';
    button.textContent = 'Enquiry sent';
  } catch (error) {
    status.textContent = error.name === 'TimeoutError' ? 'The request timed out. Please try again.' : error.message || 'Unable to connect. Please try again.';
    button.disabled = false;
    button.textContent = 'Send enquiry →';
  }
});
