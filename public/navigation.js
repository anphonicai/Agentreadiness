// History contains visited public screens only, never report data or access tokens.
(() => {
  const renderScreen = setScreen;
  const back = document.getElementById('journey-back');
  const forward = document.getElementById('journey-forward');
  const session = Math.random().toString(36).slice(2);
  let entries = ['home'];
  let position = 0;
  const state = () => ({journey:session, position});
  const paidVisible = () => {
    const detail = document.getElementById('full-detail');
    return document.body.dataset.screen === 'report' && detail && !detail.classList.contains('hidden');
  };
  function update() {
    const paid = paidVisible();
    back.hidden = forward.hidden = Boolean(paid);
    back.disabled = position === 0;
    forward.disabled = position >= entries.length - 1;
  }
  function show(screen) {
    // Revisiting "report" always opens its free summary. Paid content still
    // requires the existing verified-payment/private-link flow.
    document.getElementById('full-detail')?.classList.add('hidden');
    document.getElementById('paid-preview')?.classList.remove('hidden');
    renderScreen(screen);
    update();
  }
  history.replaceState(state(), '', location.href);
  setScreen = function(screen, options = {}) {
    if (screen === 'report-loading' || options.privateReport) {
      renderScreen(screen);
      update();
      return;
    }
    if (screen !== entries[position]) {
      entries = entries.slice(0, position + 1);
      entries.push(screen);
      position++;
      // Keep private report/checkout query strings out of navigation entries.
      history.pushState(state(), '', '/');
    }
    renderScreen(screen);
    update();
  };
  back.addEventListener('click', () => { if (!back.disabled) history.back(); });
  forward.addEventListener('click', () => { if (!forward.disabled) history.forward(); });
  window.addEventListener('popstate', event => {
    if (event.state?.journey !== session) return;
    position = event.state.position;
    let screen = entries[position] || 'home';
    // A completed scan must not reopen a stale progress screen.
    if (screen === 'analysis' && document.getElementById('report').innerHTML.trim()) screen = 'report';
    show(screen);
  });
  // Existing in-page Back links should traverse history instead of adding
  // duplicate steps. The fallback preserves their original destination.
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-back]');
    if (!button) return;
    const target = entries.lastIndexOf(button.dataset.back, position - 1);
    if (position > 0 && target >= 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      history.go(target - position);
    }
  }, true);
  new MutationObserver(update).observe(document.getElementById('report'), {subtree:true, childList:true, attributes:true, attributeFilter:['class']});
  update();
})();
