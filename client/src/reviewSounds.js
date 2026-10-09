// Review grading sounds: tiny Web Audio synth (no assets, no network).
// Good → bright ascending arpeggio; Again → soft descending pair; Hard →
// silent (neutral by design). Persisted toggle via localStorage; everything
// fail-open so audio never blocks grading.
const SOUND_KEY = 'jlt-review-sound';

export function isReviewSoundOn() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return true;
    return window.localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setReviewSoundOn(on) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (on) window.localStorage.removeItem(SOUND_KEY);
    else window.localStorage.setItem(SOUND_KEY, 'off');
  } catch { /* preference is best-effort */ }
}

function playToneSequence(notes) {
  const Ctor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!Ctor) return;
  const context = new Ctor();
  const startAt = context.currentTime + 0.02;
  notes.forEach(([frequency, offset, duration, type, gain]) => {
    const oscillator = context.createOscillator();
    const amplifier = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    amplifier.gain.setValueAtTime(0.0001, startAt + offset);
    amplifier.gain.exponentialRampToValueAtTime(gain, startAt + offset + 0.02);
    amplifier.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + duration);
    oscillator.connect(amplifier);
    amplifier.connect(context.destination);
    oscillator.start(startAt + offset);
    oscillator.stop(startAt + offset + duration + 0.05);
  });
  const total = notes.reduce((max, [, offset, duration]) => Math.max(max, offset + duration), 0);
  setTimeout(() => { context.close().catch(() => {}); }, Math.ceil((total + 0.3) * 1000));
}

export function playReviewSound(result) {
  try {
    if (!isReviewSoundOn()) return;
    if (result === 'Good') {
      // C5 → E5 → G5 → C6, quick and bright.
      playToneSequence([
        [523.25, 0, 0.14, 'sine', 0.16],
        [659.25, 0.09, 0.14, 'sine', 0.16],
        [783.99, 0.18, 0.16, 'sine', 0.16],
        [1046.5, 0.27, 0.28, 'sine', 0.18]
      ]);
    } else if (result === 'Again') {
      // E3 → C3, soft and low — a nudge, never a buzz.
      playToneSequence([
        [164.81, 0, 0.2, 'triangle', 0.14],
        [130.81, 0.16, 0.32, 'triangle', 0.14]
      ]);
    }
  } catch { /* sound never blocks grading */ }
}
