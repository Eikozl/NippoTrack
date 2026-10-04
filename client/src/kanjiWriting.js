// Kanji handwriting MVP: trace overlay + stroke-ORDER validation only (never
// shape). The model comes from the ordered stroke paths (same assets as the
// reference overlay); each drawn stroke is matched to a model stroke by its
// start point, and the drawn sequence must follow the model order.
import { element } from './ui.js';
import { STROKE_DRAW_MS, STROKE_PAUSE_MS, STROKE_SVG_NS, STROKE_SVG_VIEWBOX, loadStrokePaths } from './strokeOrder.js';
import {
  MODEL_SPACE,
  START_TOLERANCE,
  WRITING_CANVAS_SIZE,
  assignDrawnStrokes,
  parseStrokeStart,
  toModelSpace
} from './kanjiWritingLogic.js';

export { MODEL_SPACE, START_TOLERANCE, WRITING_CANVAS_SIZE };

// Mounts the practice widget into container. Returns a cleanup function.
// Async asset load is fail-open: a missing asset explains itself in place.
export function mountKanjiWriting(container, { character = '', onDone = null } = {}) {
  if (!container) return () => {};
  const doc = typeof document !== 'undefined' ? document : (typeof globalThis !== 'undefined' ? globalThis.document : null);
  container.replaceChildren();
  const status = element('p', { className: 'text-sm text-muted', text: 'Loading stroke model…' });
  container.appendChild(status);

  let cancelled = false;
  const cleanup = () => { cancelled = true; };

  loadStrokePaths(character).then((paths) => {
    if (cancelled) return;
    const modelStarts = paths.map(parseStrokeStart);
    if (modelStarts.some((start) => !start)) throw new Error('Stroke asset has no readable starts.');
    container.replaceChildren();

    const wrap = element('div', { className: 'grid gap-3' });
    const stage = element('div', {
      className: 'relative mx-auto',
      attrs: { style: `width:${WRITING_CANVAS_SIZE}px;height:${WRITING_CANVAS_SIZE}px;background-image:linear-gradient(#e7e2d9 1px,transparent 1px),linear-gradient(90deg,#e7e2d9 1px,transparent 1px);background-size:25% 25%;border:1px solid #e7e2d9;border-radius:12px;overflow:hidden;` }
    });
    const canvas = doc.createElement('canvas');
    canvas.width = WRITING_CANVAS_SIZE;
    canvas.height = WRITING_CANVAS_SIZE;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', `Handwriting canvas for ${character}: ${paths.length} strokes in order`);
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;';
    const svg = doc.createElementNS(STROKE_SVG_NS, 'svg');
    svg.setAttribute('viewBox', STROKE_SVG_VIEWBOX);
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0.45;';
    for (const d of paths) {
      const path = doc.createElementNS(STROKE_SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#8a8474');
      path.setAttribute('stroke-width', '4');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
    }
    stage.append(canvas, svg);
    const verdict = element('p', { className: 'text-sm font-medium leading-6 text-ink', attrs: { 'aria-live': 'polite' } });
    verdict.hidden = true;

    const drawnStrokes = [];
    let current = null;
    const ctx = canvas.getContext('2d');
    const posOf = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const redraw = (upTo = drawnStrokes.length) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const marks = assignDrawnStrokes(drawnStrokes.map((stroke) => stroke.modelStart), modelStarts).perStroke;
      drawnStrokes.slice(0, upTo).forEach((stroke, index) => {
        ctx.strokeStyle = marks[index] === 'right' ? '#2f7d4f' : '#c2691e';
        ctx.beginPath();
        stroke.points.forEach((point, pointIndex) => {
          if (pointIndex === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();
      });
    };
    const finishStroke = () => {
      if (!current || current.points.length === 0) { current = null; return; }
      current.modelStart = toModelSpace(current.points[0]);
      drawnStrokes.push(current);
      current = null;
      redraw();
      const marks = assignDrawnStrokes(drawnStrokes.map((stroke) => stroke.modelStart), modelStarts).perStroke;
      const wrongAt = marks.findIndex((mark) => mark === 'wrong');
      verdict.hidden = false;
      if (drawnStrokes.length > modelStarts.length) {
        verdict.textContent = `Too many strokes — ${character} has ${modelStarts.length}. Clear and try again.`;
      } else if (wrongAt >= 0) {
        const last = drawnStrokes[drawnStrokes.length - 1].modelStart;
        let nearest = 0;
        let nearestDistance = Infinity;
        modelStarts.forEach((modelStart, modelIndex) => {
          const distance = Math.hypot(last.x - modelStart.x, last.y - modelStart.y);
          if (distance < nearestDistance) { nearestDistance = distance; nearest = modelIndex; }
        });
        verdict.textContent = `That looks like stroke ${nearest + 1}, but stroke ${wrongAt + 1} comes next for ${character}.`;
      } else if (drawnStrokes.length === modelStarts.length) {
        verdict.textContent = `Stroke order matches for ${character}.`;
      } else {
        verdict.textContent = `Stroke ${drawnStrokes.length} of ${modelStarts.length} looks good — keep going.`;
      }
    };
    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      try { canvas.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
      current = { points: [posOf(event)] };
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!current) return;
      event.preventDefault();
      current.points.push(posOf(event));
      redraw(drawnStrokes.length);
      if (ctx && current.points.length > 1) {
        const tail = current.points;
        ctx.strokeStyle = '#44403c';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(tail[tail.length - 2].x, tail[tail.length - 2].y);
        ctx.lineTo(tail[tail.length - 1].x, tail[tail.length - 1].y);
        ctx.stroke();
      }
    });
    const endStroke = () => finishStroke();
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', () => { current = null; redraw(); });

    // Ringotan-style replay: dim the model, then draw each stroke in order.
    // Reduced motion shows the final state instantly (the static overlay).
    const buttonClass = 'button-secondary min-h-8 px-2.5 py-1 text-xs';
    const watch = element('button', { className: buttonClass, text: 'Watch order', attrs: { type: 'button' } });
    watch.addEventListener('click', () => {
      let reduceMotion = false;
      try {
        reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      } catch { /* motion query is best-effort */ }
      const modelPaths = [...svg.querySelectorAll('path')];
      // Flush per replay: cancel settled fill-forwards animations first —
      // they outrank inline styles, so without this every replay draws on
      // top of the previous one.
      modelPaths.forEach((modelPath) => {
        try {
          (modelPath.getAnimations?.() || []).forEach((animation) => {
            try { animation.cancel(); } catch { /* cancel is best-effort */ }
          });
        } catch { /* WAAPI lookup is best-effort */ }
        modelPath.style.strokeDasharray = '';
        modelPath.style.strokeDashoffset = '';
        modelPath.style.opacity = reduceMotion ? '' : '0.12';
      });
      if (reduceMotion) return;
      modelPaths.forEach((modelPath, modelIndex) => {
        let length = 300;
        try { length = modelPath.getTotalLength() || 300; } catch { /* measure is best-effort */ }
        modelPath.style.strokeDasharray = String(length);
        modelPath.style.strokeDashoffset = String(length);
        modelPath.style.opacity = '1';
        try {
          modelPath.animate(
            [{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
            { duration: STROKE_DRAW_MS, delay: modelIndex * (STROKE_DRAW_MS + STROKE_PAUSE_MS), easing: 'ease-out', fill: 'forwards' }
          );
        } catch {
          modelPath.style.strokeDashoffset = '0';
        }
      });
    });
    const clear = element('button', { className: buttonClass, text: 'Clear', attrs: { type: 'button' } });
    clear.addEventListener('click', () => {
      drawnStrokes.length = 0;
      current = null;
      redraw();
      verdict.hidden = false;
      verdict.textContent = 'Canvas cleared.';
      canvas.focus?.();
    });
    const retry = element('button', { className: buttonClass, text: 'Retry', attrs: { type: 'button' } });
    retry.addEventListener('click', () => {
      drawnStrokes.length = 0;
      current = null;
      redraw();
      verdict.hidden = true;
      verdict.textContent = '';
      canvas.focus?.();
    });
    const next = element('button', { className: 'button-primary min-h-8 px-2.5 py-1 text-xs', text: 'Done', attrs: { type: 'button' } });
    next.addEventListener('click', () => { if (typeof onDone === 'function') onDone(); });
    wrap.append(
      element('p', { className: 'text-sm leading-6 text-muted', text: `Watch the order first, then trace ${character} (${paths.length} strokes). Only the order is checked — shape is yours.` }),
      stage,
      verdict,
      element('div', { className: 'grid grid-cols-2 gap-2', attrs: { role: 'group', 'aria-label': 'Writing actions' } }, [watch, clear, retry, next])
    );
    container.appendChild(wrap);
  }).catch((error) => {
    if (cancelled) return;
    container.replaceChildren(element('p', { className: 'text-sm text-muted', text: `Handwriting practice is unavailable: ${error?.message || 'no stroke model'}` }));
  });

  return cleanup;
}
