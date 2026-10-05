/**
 * Stage 4 - Cursor graphics.
 *
 * A soft ring that trails the pointer and swells over anything clickable. Purely
 * decorative: it ignores pointer events, and it is skipped entirely on touch screens
 * and when the viewer asks for reduced motion.
 */

(() => {
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!finePointer.matches || reducedMotion.matches) return;

  const INTERACTIVE = 'a, button:not(:disabled), select, summary, input';
  const EASE = 0.22;

  const ring = document.createElement('div');
  ring.className = 'cursor-ring';
  ring.setAttribute('aria-hidden', 'true');
  document.body.append(ring);

  const target = { x: 0, y: 0, scale: 1 };
  const current = { x: 0, y: 0, scale: 1 };
  let active = false;
  let pressed = false;
  let frame = 0;

  function render() {
    current.x += (target.x - current.x) * EASE;
    current.y += (target.y - current.y) * EASE;
    current.scale += (target.scale - current.scale) * EASE;
    ring.style.transform = `translate3d(${current.x}px, ${current.y}px, 0) scale(${current.scale})`;

    const settled =
      Math.abs(target.x - current.x) < 0.1 &&
      Math.abs(target.y - current.y) < 0.1 &&
      Math.abs(target.scale - current.scale) < 0.005;
    frame = settled ? 0 : requestAnimationFrame(render);
  }

  function update() {
    target.scale = pressed ? 0.75 : active ? 1.5 : 1;
    ring.classList.toggle('is-active', active);
    if (frame === 0) frame = requestAnimationFrame(render);
  }

  document.addEventListener('pointermove', (event) => {
    if (!ring.classList.contains('is-visible')) {
      // First sighting: jump to the pointer instead of sliding in from the corner.
      current.x = event.clientX;
      current.y = event.clientY;
      ring.classList.add('is-visible');
    }
    target.x = event.clientX;
    target.y = event.clientY;
    active = event.target instanceof Element && event.target.closest(INTERACTIVE) !== null;
    update();
  });
  document.addEventListener('pointerdown', () => { pressed = true; update(); });
  document.addEventListener('pointerup', () => { pressed = false; update(); });
  document.documentElement.addEventListener('pointerleave', () => ring.classList.remove('is-visible'));
})();
