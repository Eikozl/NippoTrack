// Shared Japanese speech playback (Web Speech API, no files, no network).
// Dependency-free so pages and tests can use it: pass the platform pieces
// in, get a verdict back, and let the caller decide how to surface it.
export function japaneseVoiceGuidance() {
  return 'No Japanese voice found on this device — install one in your system settings to hear audio.';
}

export function findJapaneseVoice(voices) {
  try {
    const list = Array.isArray(voices) ? voices : [];
    return list.find((voice) => String(voice?.lang || '').toLowerCase().replace('_', '-').startsWith('ja')) || null;
  } catch {
    return null;
  }
}

function readVoices(synthesis) {
  try {
    const voices = typeof synthesis?.getVoices === 'function' ? synthesis.getVoices() : [];
    return Array.isArray(voices) ? voices : [];
  } catch {
    return [];
  }
}

// Speaks text with a Japanese voice when one is listed. Never throws:
// callers branch on the returned verdict.
export function speakJapanese(text, { rate = 1, synthesis = null, Utterance = null, onEnd = null } = {}) {
  const say = String(text || '').trim();
  if (!say) return { ok: false, reason: 'empty' };
  if (!synthesis || typeof synthesis.speak !== 'function') {
    return { ok: false, reason: 'unsupported', message: 'Audio is not supported in this browser.' };
  }
  let utterance = null;
  try {
    utterance = Utterance ? new Utterance(say) : null;
    if (!utterance) return { ok: false, reason: 'unsupported', message: 'Audio is not supported in this browser.' };
  } catch {
    return { ok: false, reason: 'unsupported', message: 'Audio is not supported in this browser.' };
  }
  const voices = readVoices(synthesis);
  const picked = findJapaneseVoice(voices);
  if (voices.length && !picked) {
    return { ok: false, reason: 'no-voice', message: japaneseVoiceGuidance() };
  }
  try {
    utterance.lang = 'ja-JP';
    utterance.rate = rate;
    if (picked) utterance.voice = picked;
    if (typeof onEnd === 'function') {
      try { utterance.onend = onEnd; } catch { /* handler is best-effort */ }
    }
    try { synthesis.cancel(); } catch { /* stop is best-effort */ }
    synthesis.speak(utterance);
    return { ok: true, reason: picked ? 'voice' : 'unknown' };
  } catch {
    return { ok: false, reason: 'unavailable', message: 'Audio playback is unavailable on this device right now.' };
  }
}
