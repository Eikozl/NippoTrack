// Goal Target Amount frontend contract (mirrors the backend 1–999 rule).
//
// DOM-free so it stays unit-testable: the form uses a text control with
// inputmode="numeric" and maxlength="3" (maxlength does not reliably apply
// to type=number), and this guard rejects anything outside whole numbers
// 1–999 on submit. Nothing is ever clamped — invalid input is rejected
// with TARGET_AMOUNT_ERROR.

const TARGET_AMOUNT_ERROR = 'Enter a whole number from 1 to 999.';

function isValidTargetAmount(raw) {
  const text = String(raw ?? '').trim();
  return /^\d{1,3}$/.test(text) && Number(text) >= 1 && Number(text) <= 999;
}

// attachDigitGuard(input, { maxDigits }) -> boolean. Keeps a text control
// digit-only with a bounded length: typing or pasting anything that would
// leave a non-digit or exceed maxDigits is prevented via beforeinput, so the
// invalid characters never enter the field and the previous valid value is
// preserved. Deletions, undo/redo, and IME composition pass through; an
// input-event net cleans anything that bypasses beforeinput (autofill,
// drag sources without data). Range (1–999) is still validated at submit —
// "0" may sit in the field while editing "10" without premature errors.
function attachDigitGuard(input, { maxDigits = 3 } = {}) {
  if (!input || typeof input.addEventListener !== 'function' || !input.dataset) return false;
  if (input.dataset.digitGuard) return true;
  input.dataset.digitGuard = 'true';
  input.addEventListener('beforeinput', (event) => {
    const type = String(event.inputType || '');
    if (!type || type.indexOf('delete') === 0 || type.indexOf('history') === 0) return;
    if (type.indexOf('insertCompositionText') === 0) return;
    if (type.indexOf('insert') !== 0) return;
    const data = event.data == null ? '' : String(event.data);
    const value = String(input.value ?? '');
    const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
    const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : value.length;
    const next = value.slice(0, start) + data + value.slice(end);
    if (!/^[0-9]*$/.test(next) || next.length > maxDigits) event.preventDefault();
  });
  input.addEventListener('input', () => {
    const cleaned = String(input.value ?? '').replace(/[^0-9]/g, '').slice(0, maxDigits);
    if (cleaned !== String(input.value ?? '')) input.value = cleaned;
  });
  return true;
}

export { TARGET_AMOUNT_ERROR, attachDigitGuard, isValidTargetAmount };
