// Progressive enhancement: the first page remains usable if GSAP cannot load.
(() => {
  const gsap = window.gsap;
  const home = document.getElementById('intro');
  if (!gsap || !home) return;
  const button = document.getElementById('go');
  let media;
  let screen;

  function syncScreen() {
    const next = document.body.dataset.screen;
    if (next === screen) return;
    screen = next;
    media?.revert();
    media = null;
    if (screen !== 'home') return;

    media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', context => {
      const entrance = gsap.timeline({defaults:{duration:0.65, ease:'power3.out'}});
      entrance
        .from(home.querySelector('.eyebrow'), {opacity:0, y:12, clearProps:'opacity,transform'}, 0)
        .from(home.querySelector('h1'), {opacity:0, y:28, clearProps:'opacity,transform'}, 0.08)
        .from(home.querySelector('p'), {opacity:0, y:18, clearProps:'opacity,transform'}, 0.18)
        .from(home.querySelector('#form'), {opacity:0, y:20, clearProps:'opacity,transform'}, 0.28)
        .from(home.querySelector('.form-note'), {opacity:0, y:8, clearProps:'opacity,transform'}, 0.36)
        .from(home.querySelectorAll('.flow-signals span'), {opacity:0, y:12, stagger:0.09, clearProps:'opacity,transform'}, 0.45);

      // Keyboard/pointer interaction should never wait for the entrance to finish.
      const finishEntrance = () => entrance.progress(1);
      home.addEventListener('focusin', finishEntrance);
      home.addEventListener('pointerdown', finishEntrance);
      context.add('lift', () => {
        if (!button.disabled) gsap.to(button, {y:-2, duration:0.18, ease:'power2.out', overwrite:true});
      });
      context.add('settle', () => gsap.to(button, {y:0, scale:1, duration:0.18, overwrite:true, clearProps:'transform'}));
      context.add('press', () => {
        if (!button.disabled) gsap.to(button, {y:0, scale:0.98, duration:0.1, overwrite:true});
      });
      const events = [['pointerenter','lift'], ['focus','lift'], ['pointerleave','settle'], ['blur','settle'], ['pointerdown','press'], ['pointerup','settle'], ['pointercancel','settle']];
      events.forEach(([event, handler]) => button.addEventListener(event, context[handler]));
      return () => {
        home.removeEventListener('focusin', finishEntrance);
        home.removeEventListener('pointerdown', finishEntrance);
        events.forEach(([event, handler]) => button.removeEventListener(event, context[handler]));
      };
    });
  }
  new MutationObserver(syncScreen).observe(document.body, {attributes:true, attributeFilter:['data-screen']});
  syncScreen();
})();
