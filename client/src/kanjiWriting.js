// Kanji handwriting MVP: write overlay + stroke-ORDER validation only (never
// shape-graded). The model comes from the ordered stroke paths (same assets as the
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

// Ramer-Douglas-Peucker decimation to cap points per stroke
function decimatePoints(points, maxPoints = 200, epsilon = 1.0) {
  if (!points || points.length <= maxPoints) return points;
  // Simplified: just sample evenly
  const step = points.length / maxPoints;
  const decimated = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(Math.floor(i * step), points.length - 1);
    decimated.push(points[idx]);
  }
  // Ensure last point is included
  if (decimated[decimated.length - 1] !== points[points.length - 1]) {
    decimated[decimated.length - 1] = points[points.length - 1];
  }
  return decimated;
}

// Mounts the practice widget into container. Returns a cleanup function.
// Async asset load is fail-open: a missing asset explains itself in place.
export function mountKanjiWriting(container, { character = '', onDone = null } = {}) {
  if (!container) return () => {};
  const doc = typeof document !== 'undefined' ? document : (typeof globalThis !== 'undefined' ? globalThis.document : null);
  container.replaceChildren();
  const status = element('p', { className: 'text-sm text-muted', text: 'Loading stroke order…' });
  container.appendChild(status);

  let cancelled = false;
  let resizeObserver = null;
  let cleanupScroll = () => {};
  const cleanup = () => {
    cancelled = true;
    try { resizeObserver?.disconnect?.(); } catch { /* observer teardown is best-effort */ }
    try { cleanupScroll(); } catch { /* listener teardown is best-effort */ }
    resizeObserver = null;
  };

  loadStrokePaths(character).then((paths) => {
    if (cancelled) return;
    const modelStarts = paths.map(parseStrokeStart);
    if (modelStarts.some((start) => !start)) throw new Error('Stroke asset has no readable starts.');
    try {
      container.replaceChildren();
    } catch (e) {
      console.error('Failed to clear container:', e);
    }

    const wrap = element('div', { className: 'grid gap-3' });
    const stage = element('div', {
      className: 'relative mx-auto',
      attrs: { style: `width:${WRITING_CANVAS_SIZE}px;height:${WRITING_CANVAS_SIZE}px;border:1px solid #e7e2d9;border-radius:12px;overflow:hidden;` }
    });
    const canvas = doc.createElement('canvas');
    // DPR scaling will be applied in applyDpr()
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', `Handwriting canvas for ${character}: ${paths.length} strokes in order`);
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;user-select:none;';
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

    // Stroke counter badge
    const strokeCounter = element('div', {
      className: 'absolute top-2 right-2 px-2 py-0.5 text-xs font-mono text-ink/70 bg-paper/90 backdrop-blur rounded-full border border-stone/30',
      attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' }
    });
    stage.appendChild(strokeCounter);

    const drawnStrokes = []; // { points: original[], smoothed: [], modelStart, path2d }
    let current = null; // { points: [], smoothed: null }
    let rectCache = null;
    let offscreenCanvas = null;
    let offscreenCtx = null;
    resizeObserver = null;

    const ctx = canvas.getContext('2d');

    // Apply DPR scaling
    function applyDpr() {
      const dpr = globalThis.devicePixelRatio || 1;
      const cssWidth = stage.clientWidth || WRITING_CANVAS_SIZE;
      const cssHeight = stage.clientHeight || WRITING_CANVAS_SIZE;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = cssWidth + 'px';
      canvas.style.height = cssHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Recreate offscreen canvas at new size
      offscreenCanvas = doc.createElement('canvas');
      offscreenCanvas.width = canvas.width;
      offscreenCanvas.height = canvas.height;
      offscreenCtx = offscreenCanvas.getContext('2d');
      offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Repaint settled strokes into the fresh offscreen, then redraw
      repaintOffscreen();
      redraw();
    }

    // Cache bounding rect on pointerdown, update on scroll/resize
    function updateRectCache() {
      rectCache = canvas.getBoundingClientRect();
    }

    // Update rect cache on scroll to handle page scroll during drawing
    const handleScroll = () => updateRectCache();
    document.addEventListener('scroll', handleScroll, { passive: true });
    cleanupScroll = () => document.removeEventListener('scroll', handleScroll);

    const posOf = (event) => {
      if (!rectCache) updateRectCache();
      return { x: event.clientX - rectCache.left, y: event.clientY - rectCache.top };
    };

    // Build Path2D for a stroke's points (CSS user-space units)
    function buildPath2D(points) {
      const path = new Path2D();
      if (!points || points.length === 0) return path;
      path.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        path.lineTo(points[i].x, points[i].y);
      }
      return path;
    }

    // Repaint settled strokes into the offscreen canvas. Points are in
    // CSS user-space units and offscreenCtx carries the dpr transform, so
    // this stays 1:1 on any backing-store size. Called after each finished
    // stroke and after a resize recreates the offscreen canvas (otherwise
    // settled strokes would vanish on resize until the next stroke).
    const repaintOffscreen = () => {
      if (!offscreenCtx) return;
      const dpr = globalThis.devicePixelRatio || 1;
      const cssWidth = offscreenCanvas.width / dpr;
      const cssHeight = offscreenCanvas.height / dpr;
      offscreenCtx.clearRect(0, 0, cssWidth, cssHeight);
      offscreenCtx.lineWidth = 4;
      offscreenCtx.lineCap = 'round';
      offscreenCtx.lineJoin = 'round';
      const marks = assignDrawnStrokes(drawnStrokes.map((stroke) => stroke.modelStart), modelStarts).perStroke;
      drawnStrokes.forEach((stroke, index) => {
        offscreenCtx.strokeStyle = marks[index] === 'right' ? '#2f7d4f' : '#c2691e';
        offscreenCtx.stroke(stroke.path2d);
      });
    };

    // Redraw using offscreen canvas for settled strokes + current stroke
    const redraw = (upTo = drawnStrokes.length) => {
      if (!ctx) return;
      const cssWidth = canvas.width / (globalThis.devicePixelRatio || 1);
      const cssHeight = canvas.height / (globalThis.devicePixelRatio || 1);
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Draw offscreen canvas (settled strokes). The offscreen backing
      // store is css*dpr device px while ctx carries the dpr transform, so
      // the destination must be sized in CSS user-space units — a bare
      // 3-arg drawImage would blit it dpr× oversized (2×/3× on HiDPI).
      if (offscreenCanvas) {
        const dpr = globalThis.devicePixelRatio || 1;
        ctx.drawImage(offscreenCanvas, 0, 0, offscreenCanvas.width / dpr, offscreenCanvas.height / dpr);
      }

      // Draw current in-progress stroke
      if (current && current.points.length > 1) {
        ctx.strokeStyle = '#44403c';
        ctx.beginPath();
        const pts = current.points;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
      }

      // Update stroke counter badge
      strokeCounter.textContent = `${drawnStrokes.length} / ${modelStarts.length}`;
    };

    const finishStroke = () => {
      if (!current || current.points.length === 0) { current = null; return; }

      // Decimate the stroke (cap points, no smoothing)
      const decimated = decimatePoints(current.points);

      // Model-space start uses ORIGINAL first point for grading, scaled by
      // the ACTUAL css canvas size (stage is responsive — the 260 default
      // would mis-scale grading on any other canvas size).
      const modelStart = toModelSpace(current.points[0], stage.clientWidth || WRITING_CANVAS_SIZE);

      const strokeData = {
        points: current.points,        // Original points (for grading)
        smoothed: decimated,           // Smoothed + decimated points (for render)
        modelStart,
        path2d: buildPath2D(decimated) // Cached Path2D for fast redraw
      };

      drawnStrokes.push(strokeData);
      current = null;

      // Rebuild offscreen canvas with all settled strokes
      repaintOffscreen();

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
        // Brief green flash on canvas
        canvas.style.outline = '3px solid #2f7d4f';
        setTimeout(() => { canvas.style.outline = ''; }, 400);
      } else {
        verdict.textContent = `Stroke ${drawnStrokes.length} of ${modelStarts.length} looks good — keep going.`;
      }
    };

    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      try { canvas.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
      updateRectCache();
      current = { points: [posOf(event)] };
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!current) return;
      event.preventDefault();
      current.points.push(posOf(event));
      redraw(drawnStrokes.length);
    });

    const endStroke = () => finishStroke();
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', () => {
      if (current && current.points.length > 0) {
        finishStroke();
      } else {
        current = null;
        redraw();
      }
    });

    // Ringotan-style replay: dim the model, then draw each stroke in order.
    // Reduced motion shows the final state instantly (the static overlay).
    const buttonClass = 'button-secondary min-h-8 px-2.5 py-1 text-xs';
    const watch = element('button', { className: buttonClass, text: 'Watch stroke order', attrs: { type: 'button' } });
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

    // Clear button: resets canvas
    const clear = element('button', { className: buttonClass, text: 'Clear', attrs: { type: 'button', 'aria-label': 'Clear canvas' } });
    clear.addEventListener('click', () => {
      drawnStrokes.length = 0;
      current = null;
      // Clear offscreen canvas
      if (offscreenCtx) {
        const cssWidth = offscreenCanvas.width / (globalThis.devicePixelRatio || 1);
        const cssHeight = offscreenCanvas.height / (globalThis.devicePixelRatio || 1);
        offscreenCtx.clearRect(0, 0, cssWidth, cssHeight);
      }
      redraw();
      verdict.hidden = false;
      verdict.textContent = 'Cleared.';
      canvas.focus?.();
    });

    // Done button: finishes practice
    const next = element('button', { className: 'button-primary min-h-8 px-2.5 py-1 text-xs', text: 'Done', attrs: { type: 'button', 'aria-label': 'Finish practice' } });
    next.addEventListener('click', () => { if (typeof onDone === 'function') onDone(); });

    // Show/hide stroke order guide toggle
    const showGuideLabel = element('label', { className: 'flex items-center gap-2 text-sm text-muted' }, [
      element('input', { attrs: { type: 'checkbox', checked: 'checked' } }),
      element('span', { text: 'Show stroke order' })
    ]);
    const guideCheckbox = showGuideLabel.querySelector('input');
    guideCheckbox.addEventListener('change', () => {
      svg.style.display = guideCheckbox.checked ? '' : 'none';
    });

    wrap.append(
      element('div', { className: 'flex flex-col items-center gap-2' }, [
        element('div', { className: 'text-5xl font-serif text-ink', text: character, attrs: { 'aria-hidden': 'true' } }),
        element('p', { className: 'text-sm text-muted', text: 'Write this kanji' }),
        strokeCounter
      ]),
      stage,
      verdict,
      element('div', { className: 'grid grid-cols-3 gap-2', attrs: { role: 'group', 'aria-label': 'Writing actions' } }, [watch, clear, next]),
      element('div', { className: 'flex justify-center' }, [showGuideLabel])
    );
    container.appendChild(wrap);

    // Initial DPR application and ResizeObserver
    applyDpr();
    resizeObserver = new ResizeObserver(() => {
      applyDpr();
    });
    resizeObserver.observe(stage);

  }).catch((error) => {
    if (cancelled) return;
    container.replaceChildren(element('p', { className: 'text-sm text-muted', text: `Handwriting practice is unavailable: ${error?.message || 'no stroke order data'}` }));
  });

  return cleanup;
}