// Kanji writing MVP, pure logic: stroke-start parsing, model-space scaling
// and stroke-ORDER assignment. Zero imports so Node tests stay dependency
// free; the DOM mount lives in kanjiWriting.js.
export const WRITING_CANVAS_SIZE = 200;
export const MODEL_SPACE = 109;
export const START_TOLERANCE = 25;

// First moveto of a path (KanjiVG strokes open with one). Falls back to the
// first coordinate pair when the path opens unconventionally.
export function parseStrokeStart(d) {
  const text = String(d || '').trim();
  if (!text) return null;
  const move = /^\s*[Mm]\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/.exec(text);
  if (move) return { x: Number(move[1]), y: Number(move[2]) };
  const pair = /(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/.exec(text);
  if (!pair) return null;
  return { x: Number(pair[1]), y: Number(pair[2]) };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// MVP order check: same stroke count, and every drawn stroke must start near
// its same-index model stroke. Anything else is "wrong order" feedback, not
// a grade — the review grade stays with the Again/Hard/Good buttons.
export function assignDrawnStrokes(drawnStarts, modelStarts, tolerance = START_TOLERANCE) {
  const model = Array.isArray(modelStarts) ? modelStarts : [];
  const drawn = Array.isArray(drawnStarts) ? drawnStarts : [];
  const perStroke = drawn.map((start, index) => {
    const expected = model[index] || null;
    if (!start || !expected) return 'wrong';
    return distance(start, expected) <= tolerance ? 'right' : 'wrong';
  });
  const allRight = drawn.length > 0 && drawn.length === model.length && perStroke.every((mark) => mark === 'right');
  return { perStroke, allRight };
}

export function toModelSpace(point, canvasSize = WRITING_CANVAS_SIZE) {
  const scale = MODEL_SPACE / canvasSize;
  return { x: point.x * scale, y: point.y * scale };
}
