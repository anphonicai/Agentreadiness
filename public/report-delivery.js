// Email links load saved findings; opening a report never starts another crawl.
let checkoutAvailable = false;
let couponsAvailable = false;
// A partial-discount code held for the Stripe session; full-access codes never
// reach here because they unlock the report outright.
let appliedCode = '';
let currentScanId = null;
let reportPreviewAvailable = false;
let reportLinkToken = new URLSearchParams(location.search).get('report');
const reportLinkBrand = new URLSearchParams(location.search).get('store');

$('demo-payment').addEventListener('click', async () => {
  if (!currentScanId || (!reportPreviewAvailable && !checkoutAvailable)) return;
  const button = $('demo-payment');
  if (button.disabled) return;
  button.disabled = true;
  $('payment-status').textContent = 'Opening your report…';
  try {
    if (checkoutAvailable) {
      const response = await fetch('/api/checkout', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scanId:currentScanId, code:appliedCode || undefined}),signal:AbortSignal.timeout(20000)});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error || 'Unable to start checkout.');
      location.assign(data.url);
      return;
    }
    const response = await fetch(`/api/scan/${encodeURIComponent(currentScanId)}/preview`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}', signal:AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to open the report.');
    showFullReport(data.result, true);
  } catch (error) {
    $('payment-status').textContent = error.name === 'TimeoutError' ? 'The request timed out. Please try again.' : error.message;
  } finally { button.disabled = false; }
});

function showFullReport(result, preview) {
  $('report').innerHTML = renderReport(result, {full:true, preview});
  demoUnlocked = true;
  setScreen('report');
  $('paid-preview').classList.add('hidden');
  $('full-detail').classList.remove('hidden');
  $('full-detail').focus({preventScroll:true});
}

$('coupon-apply').addEventListener('click', async () => {
  const code = $('coupon-code').value.trim();
  if (!code || !currentScanId) { $('coupon-status').textContent = 'Enter your code.'; return; }
  $('coupon-apply').disabled = true;
  $('coupon-status').textContent = 'Checking your code…';
  try {
    const response = await fetch('/api/redeem', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({scanId:currentScanId, code}), signal:AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'That code could not be applied.');
    if (data.discount) {
      // Partial discount: Stripe applies it on the session we open next.
      appliedCode = code;
      $('coupon-status').textContent = `${data.percent}% off applied. Continue to payment to finish.`;
      $('demo-payment').textContent = `Pay with ${data.percent}% off →`;
      return;
    }
    reportLinkToken = data.token;
    try { sessionStorage.setItem('commerce-report-link', reportLinkToken); } catch {}
    $('coupon-status').textContent = 'Code accepted — opening your full report…';
    history.replaceState(null, '', '/?saved-report=1');
    await openReportLink();
  } catch (error) {
    $('coupon-status').textContent = error.name === 'TimeoutError' ? 'That took too long. Please try again.' : error.message;
    $('coupon-apply').disabled = false;
  }
});

$('coupon-code').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('coupon-apply').click(); }
});

async function openReportLink() {
  setScreen('report-loading');
  $('report-loading-title').textContent = reportLinkBrand ? `Loading ${reportLinkBrand.slice(0,120)}` : 'Opening your report';
  $('report-link-track').classList.remove('hidden');
  $('report-link-status').textContent = 'Loading your saved analysis and recommendations…';
  $('report-link-retry').classList.add('hidden');
  try {
    const response = await fetch('/api/report/view', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:reportLinkToken}), signal:AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to open this report.');
    showFullReport(data.result, data.preview);
    document.title = `${data.result.brandName || 'Your store'} — Commerce.Anphonic.ai`;
  } catch (error) {
    $('report-link-track').classList.add('hidden');
    $('report-link-status').textContent = error.name === 'TimeoutError' ? 'Loading took too long. Please try again.' : error.message;
    $('report-link-retry').classList.remove('hidden');
  }
}
$('report-link-retry').addEventListener('click', () => checkoutSession ? completeCheckout() : openReportLink());
const checkoutSession = new URLSearchParams(location.search).get('checkout');
if (reportLinkToken) {
  // Keep the link usable on refresh without sending its secret in subsequent URLs.
  try { sessionStorage.setItem('commerce-report-link', reportLinkToken); } catch {}
  history.replaceState(null, '', '/?saved-report=1');
  openReportLink();
} else if (new URLSearchParams(location.search).has('saved-report')) {
  try { reportLinkToken = sessionStorage.getItem('commerce-report-link'); } catch {}
  openReportLink();
}

async function completeCheckout() {
  setScreen('report-loading');
  $('report-link-status').textContent='Confirming your payment…';
  $('report-link-retry').classList.add('hidden');
  try {
    const response=await fetch('/api/checkout/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:checkoutSession}),signal:AbortSignal.timeout(35000)});
    const data=await response.json();
    if(!response.ok || data.pending) throw new Error(data.error || 'Payment is still processing. Please try again shortly.');
    reportLinkToken=data.token;
    try { sessionStorage.setItem('commerce-report-link',reportLinkToken); } catch {}
    history.replaceState(null,'','/?saved-report=1');
    await openReportLink();
  } catch(error) {
    $('report-link-status').textContent=error.message;
    $('report-link-track').classList.add('hidden');
    $('report-link-retry').classList.remove('hidden');
  }
}
if(checkoutSession) completeCheckout();
const cancelledScan=new URLSearchParams(location.search).get('cancelled');
if(cancelledScan) {
  currentScanId=cancelledScan;
  poll(cancelledScan);
  history.replaceState(null,'','/');
}
