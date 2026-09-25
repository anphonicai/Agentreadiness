// History contains visited public screens only, never report data or access tokens.
(() => {
  const renderScreen = setScreen;
  const session = Math.random().toString(36).slice(2);
  let entries = ['home'];
  let position = 0;
  const state = () => ({journey:session, position});
  function show(screen) {
    // Revisiting "report" always opens its free summary. Paid content still
    // requires the existing verified-payment/private-link flow.
    document.getElementById('full-detail')?.classList.add('hidden');
    document.getElementById('paid-preview')?.classList.remove('hidden');
    renderScreen(screen);
  }
  history.replaceState(state(), '', location.href);
  setScreen = function(screen, options = {}) {
    if (screen === 'report-loading' || options.privateReport) {
      renderScreen(screen);
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
  };
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
})();
