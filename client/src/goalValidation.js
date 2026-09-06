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

export { TARGET_AMOUNT_ERROR, isValidTargetAmount };
