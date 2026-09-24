// Email links load saved findings; opening a report never starts another crawl.
let checkoutAvailable = false;
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
      const response = await fetch('/api/checkout', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scanId:currentScanId}),signal:AbortSignal.timeout(20000)});
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
    $('report').innerHTML = renderReport(data.result, {full:true, preview:true});
    demoUnlocked = true;
    setScreen('report');
    $('paid-preview').classList.add('hidden');
    $('full-detail').classList.remove('hidden');
    $('full-detail').focus({preventScroll:true});
  } catch (error) {
    $('payment-status').textContent = error.name === 'TimeoutError' ? 'The request timed out. Please try again.' : error.message;
  } finally { button.disabled = false; }
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
    $('report').innerHTML = renderReport(data.result, {full:true, preview:data.preview});
    demoUnlocked = true;
    setScreen('report');
    $('paid-preview').classList.add('hidden');
    $('full-detail').classList.remove('hidden');
    $('full-detail').focus({preventScroll:true});
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
