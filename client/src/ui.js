import { icon, iconForTitle, iconTile } from './icons';
import { t } from './i18n';
import { setActionPending } from './pendingAction';

export { isActionPending, setActionPending, setPendingLabel, withPendingAction } from './pendingAction';
export { isGlobalLoading, showGlobalLoading, withGlobalLoading } from './globalLoading';

export function element(tagName, { className, text, attrs, dataset } = {}, children = []) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = t(text);

  Object.entries(attrs || {}).forEach(([name, value]) => {
    if (value !== undefined && value !== null) node.setAttribute(name, ['placeholder', 'title', 'aria-label'].includes(name) ? t(value) : String(value));
  });
  Object.entries(dataset || {}).forEach(([name, value]) => {
    node.dataset[name] = String(value);
  });
  const normalizedChildren = Array.isArray(children) ? children : [children];
  normalizedChildren.filter(Boolean).forEach((child) => node.appendChild(child));
  return node;
}

// v6.1: decorative section eyebrows retired — the small-caps descriptor above
// the title restated the section and read as AI-generated. The `eyebrow`
// param stays accepted so existing call sites keep working, but it is
// intentionally never rendered. Functional labels (onboarding steps,
// landing copy, kanji ownership) live outside this helper and are untouched.
export function pageHeader({ eyebrow: _eyebrow, title, description, action }) {
  const headerIcon = iconForTitle(title);
  const heading = element('div', { className: 'flex items-center gap-3' }, [
    ...(headerIcon ? [iconTile(headerIcon, { className: 'page-header-icon' })] : []),
    element('h1', { className: 'font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl', text: title })
  ]);
  const copy = element('div', {}, [
    element('div', { className: 'mt-2' }, [heading]),
    element('p', { className: 'mt-2 max-w-2xl text-sm leading-6 text-muted', text: description })
  ]);
  return element('header', { className: 'mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between' }, [copy, action]);
}

export function loadingState(label = 'Loading data…') {
  return element('div', { className: 'surface loading-state grid min-h-52 place-items-center p-8', attrs: { role: 'status', 'aria-live': 'polite' } }, [
    element('div', { className: 'grid justify-items-center gap-3 text-muted' }, [
      element('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }),
      element('p', { className: 'text-sm', text: label })
    ])
  ]);
}

// Community skeletons (additive, loadingState untouched): pulsing placeholder
// blocks shaped like the upcoming rows/cards. Visual blocks are aria-hidden;
// AT hears role=status "Loading…" via the visually-hidden line. Pulse uses
// .skeleton-block (nt-skeleton shimmer), which the stylesheet already stills
// under prefers-reduced-motion (animation: none). Callers set aria-busy on
// the loading container while the skeleton is shown.
export function skeleton({ rows = 3, variant = 'cards', label = 'Loading…' } = {}) {
  const count = Math.max(1, Math.min(6, Number(rows) || 3));
  const visualChildren = [];
  if (variant === 'grid') {
    for (let index = 0; index < count; index += 1) {
      visualChildren.push(element('div', { className: 'rounded-xl border border-stone bg-paper px-3 py-2' }, [
        element('div', { className: 'skeleton-block h-4 w-3/4' }),
        element('div', { className: 'skeleton-block mt-2 h-3 w-1/2' })
      ]));
    }
    const visual = element('div', { className: 'grid min-w-0 grid-cols-2 gap-2 xl:grid-cols-3', attrs: { 'aria-hidden': 'true' } }, visualChildren);
    return element('div', { className: 'grid gap-2', attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': label } }, [
      visual,
      element('p', { className: 'visually-hidden', text: label })
    ]);
  }
  if (variant === 'rows') {
    for (let index = 0; index < count; index += 1) {
      visualChildren.push(element('div', { className: 'surface flex items-center gap-3 p-3' }, [
        element('span', { className: 'skeleton-block size-10 shrink-0 rounded-full' }),
        element('div', { className: 'grid min-w-0 flex-1 gap-2' }, [
          element('div', { className: 'skeleton-block h-4 w-1/3' }),
          element('div', { className: 'skeleton-block h-3 w-2/3' })
        ])
      ]));
    }
    const visual = element('div', { className: 'grid gap-3', attrs: { 'aria-hidden': 'true' } }, visualChildren);
    return element('div', { className: 'grid gap-2', attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': label } }, [
      visual,
      element('p', { className: 'visually-hidden', text: label })
    ]);
  }
  // Default 'cards' (also used for 'preview' text shapes): post-card shaped
  // placeholders with a header row + text lines, like feed/discover/profile
  // cards and the reading excerpt.
  for (let index = 0; index < count; index += 1) {
    visualChildren.push(element('div', { className: 'surface p-4 sm:p-5' }, [
      element('div', { className: 'flex items-center gap-3' }, [
        element('span', { className: 'skeleton-block size-10 shrink-0 rounded-full' }),
        element('div', { className: 'grid flex-1 gap-2' }, [
          element('div', { className: 'skeleton-block h-4 w-1/3' }),
          element('div', { className: 'skeleton-block h-3 w-1/4' })
        ])
      ]),
      element('div', { className: 'skeleton-block mt-3 h-4 w-5/6' }),
      element('div', { className: 'skeleton-block mt-2 h-4 w-full' }),
      element('div', { className: 'skeleton-block mt-2 h-4 w-2/3' })
    ]));
  }
  const visual = element('div', { className: 'grid gap-3', attrs: { 'aria-hidden': 'true' } }, visualChildren);
  return element('div', { className: 'grid gap-2', attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': label } }, [
    visual,
    element('p', { className: 'visually-hidden', text: label })
  ]);
}

export function emptyState({ title = 'Nothing here yet', description = 'Create your first record to get started.', icon = null, action = null } = {}) {
  return element('div', { className: 'surface empty-state grid min-h-52 place-items-center p-8 text-center' }, [
    element('div', { className: 'grid max-w-md justify-items-center' }, [
      ...(icon ? [iconTile(icon, { className: 'panel-icon' })] : []),
      element('p', { className: 'empty-state-title font-display text-base font-semibold text-ink', text: title }),
      element('p', { className: 'mt-2 max-w-md text-sm leading-6 text-muted', text: description }),
      ...(action ? [element('div', { className: 'mt-4' }, [action])] : [])
    ])
  ]);
}

export function errorState(error, retry) {
  const retryButton = retry ? element('button', { className: 'button-secondary mt-4', text: 'Try again', attrs: { type: 'button' } }) : null;
  retryButton?.addEventListener('click', retry);
  return element('div', { className: 'surface error-panel border-red-200 bg-red-50/60 p-6', attrs: { role: 'alert' } }, [
    element('p', { className: 'error-panel-title font-semibold text-red-800', text: 'We could not load this view.' }),
    element('p', { className: 'error-panel-detail mt-2 text-sm text-red-700', text: error?.message || 'Unexpected error.' }),
    retryButton
  ]);
}

export function showToast(message, type = 'success') {
  const region = document.getElementById('toast-region');
  const toast = element('div', {
    className: `pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-lg toast-panel ${type === 'error' ? 'border-red-200 text-red-800 toast-panel--error' : 'border-stone bg-paper text-ink'}`,
    text: message,
    attrs: { role: type === 'error' ? 'alert' : 'status' }
  });
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

export function field({ name, label, type = 'text', value = '', required = false, maxLength, max, inputmode, autocomplete, options, multiple = false, placeholder = '', description = '' }) {
  let control;

  if (options) {
    control = element('select', {
      className: `field-control ${multiple ? 'min-h-32' : ''}`,
      attrs: { name, id: `field-${name}`, ...(required ? { required: '' } : {}), ...(multiple ? { multiple: '' } : {}) }
    });
    options.forEach((option) => {
      const optionNode = element('option', { text: option.label, attrs: { value: option.value } });
      const selectedValues = multiple ? new Set((value || []).map(String)) : null;
      if ((multiple && selectedValues.has(String(option.value))) || (!multiple && String(value ?? '') === String(option.value))) {
        optionNode.selected = true;
      }
      control.appendChild(optionNode);
    });
  } else if (type === 'textarea') {
    control = element('textarea', {
      className: 'field-control min-h-24 resize-y',
      text: value ?? '',
      attrs: { name, id: `field-${name}`, placeholder, ...(required ? { required: '' } : {}), ...(maxLength ? { maxlength: maxLength } : {}) }
    });
  } else {
    control = element('input', {
      className: 'field-control',
      attrs: {
        name,
        id: `field-${name}`,
        type,
        value: value ?? '',
        placeholder,
        ...(required ? { required: '' } : {}),
        ...(maxLength ? { maxlength: maxLength } : {}),
        ...(type === 'number' ? { min: '1', step: '1' } : {}),
        ...(type === 'number' && max !== undefined ? { max: String(max) } : {}),
        ...(inputmode ? { inputmode } : {}),
        ...(autocomplete ? { autocomplete } : {})
      }
    });
  }

  return element('label', { className: 'field', attrs: { for: `field-${name}` } }, [
    element('span', { text: label }),
    ...(description ? [element('span', { className: 'text-xs font-normal leading-5 text-muted', text: description })] : []),
    control
  ]);
}

export function searchableMultiSelect({
  name,
  label,
  options = [],
  value = [],
  placeholder = 'Search…',
  emptyMessage = 'No records available.',
  createLabel = 'Add new',
  onCreate,
  loadOptions
}) {
  const selectedValues = new Set(value.map(String));
  const optionLabels = new Map(options.map((option) => [String(option.value), option.chipLabel || option.label]));
  const labelId = `field-${name}-label`;
  const hiddenSelect = element('select', {
    className: 'hidden',
    attrs: { name, id: `field-${name}`, multiple: '', 'aria-hidden': 'true', tabindex: '-1' }
  });

  const chips = element('div', { className: 'flex min-h-8 flex-wrap gap-2' });
  const optionsList = element('div', {
    className: 'multiselect-options max-h-40 overflow-y-auto rounded-lg border border-stone bg-paper p-1',
    attrs: { role: 'group', 'aria-labelledby': labelId }
  });
  const search = element('input', {
    className: 'field-control',
    attrs: { type: 'search', placeholder, autocomplete: 'off', 'aria-labelledby': labelId }
  });
  let optionRows = [];
  let requestSequence = 0;

  function optionSearchText(option) {
    return [option.label, option.meta, option.description]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
  }

  function syncSelection() {
    hiddenSelect.replaceChildren();
    selectedValues.forEach((selectedValue) => {
      const option = element('option', {
        text: optionLabels.get(selectedValue) || selectedValue,
        attrs: { value: selectedValue }
      });
      option.selected = true;
      hiddenSelect.appendChild(option);
    });
    optionRows.forEach(({ checkbox }) => {
      checkbox.checked = selectedValues.has(checkbox.value);
    });

    chips.replaceChildren();
    if (selectedValues.size === 0) {
      chips.appendChild(element('span', { className: 'text-xs font-normal text-muted', text: 'Nothing selected' }));
      return;
    }

    selectedValues.forEach((selectedValue) => {
      const removeButton = element('button', {
        className: 'ml-1 rounded-full px-1 text-muted transition hover:bg-white hover:text-vermilion',
        attrs: { type: 'button', 'aria-label': `Remove ${optionLabels.get(selectedValue)}` }
      }, [icon('close', { size: 14 })]);
      removeButton.addEventListener('click', () => {
        selectedValues.delete(selectedValue);
        syncSelection();
      });
      chips.appendChild(element('span', { className: 'inline-flex items-center rounded-full border border-stone bg-paper px-2.5 py-1 text-xs font-semibold text-ink' }, [
        element('span', { text: optionLabels.get(selectedValue) }),
        removeButton
      ]));
    });
  }

  function renderOptions(availableOptions, message = null) {
    optionRows = [];
    optionsList.replaceChildren();

    availableOptions.forEach((option) => {
      const optionValue = String(option.value);
      optionLabels.set(optionValue, option.chipLabel || option.label);
      const checkbox = element('input', {
        className: 'mt-0.5 size-4 accent-vermilion',
        attrs: { type: 'checkbox', value: optionValue }
      });
      checkbox.checked = selectedValues.has(optionValue);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedValues.add(optionValue);
        else selectedValues.delete(optionValue);
        syncSelection();
      });
      const details = element('span', { className: 'min-w-0 leading-5' }, [
        element('span', { className: 'block font-semibold text-ink', text: option.label }),
        ...(option.meta ? [element('span', { className: 'block text-xs text-muted', text: option.meta })] : []),
        ...(option.description ? [element('span', { className: 'block truncate text-xs text-ink/70', text: option.description })] : [])
      ]);
      const row = element('label', { className: 'multiselect-row flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-sm font-normal transition hover:bg-paper' }, [
        checkbox,
        details
      ]);
      optionRows.push({ checkbox, row, searchText: optionSearchText(option) });
      optionsList.appendChild(row);
    });

    if (availableOptions.length === 0) {
      optionsList.appendChild(element('p', {
        className: 'grid min-h-24 place-items-center p-4 text-center text-sm font-normal leading-5 text-muted',
        text: message || emptyMessage
      }));
    }
    syncSelection();
  }

  const createButton = element('button', {
    className: 'text-xs font-semibold text-vermilion transition hover:text-vermilion-dark',
    text: `+ ${createLabel}`,
    attrs: { type: 'button' }
  });
  if (onCreate) createButton.addEventListener('click', onCreate);

  const header = element('div', { className: 'flex items-center justify-between gap-3' }, [
    element('span', { text: label, attrs: { id: labelId } }),
    onCreate ? createButton : null
  ]);

  const loadRemoteOptions = debounce(async (query, sequence) => {
    try {
      const loadedOptions = await loadOptions(query);
      if (sequence !== requestSequence) return;
      renderOptions(loadedOptions, query ? 'No matches found.' : emptyMessage);
    } catch {
      if (sequence !== requestSequence) return;
      renderOptions([], 'Unable to load options. Try again.');
    }
  }, 250);

  const debouncedLocalFilter = debounce((query) => {
    const normalizedQuery = query.toLocaleLowerCase();
    const filtered = options.filter((option) => optionSearchText(option).includes(normalizedQuery));
    renderOptions(filtered, 'No matches found.');
  }, 150);

  search.addEventListener('input', () => {
    const query = search.value.trim();
    const sequence = ++requestSequence;
    if (!loadOptions) {
      debouncedLocalFilter(query);
      return;
    }

    optionsList.replaceChildren(element('p', { className: 'p-4 text-center text-sm font-normal text-muted', text: 'Searching…' }));
    loadRemoteOptions(query, sequence);
  });

  renderOptions(options);
  const wrapper = element('div', { className: 'field' }, [header, search, chips, optionsList, hiddenSelect]);
  // Day-link merge slot (sessions "Link what I studied that day"): appends
  // externally-fetched options without wiping manual picks. Selected ids
  // persist in selectedValues so the hidden select (submit source) and chips
  // stay correct even when the new rows are not in the current filtered view.
  // Never removes existing selections; callers skip duplicates before calling.
  wrapper.appendLinkedOptions = (linkedOptions = [], idsToSelect = []) => {
    for (const option of Array.isArray(linkedOptions) ? linkedOptions : []) {
      if (!option || option.value === undefined || option.value === null) continue;
      const key = String(option.value);
      if (!optionLabels.has(key)) optionLabels.set(key, option.chipLabel || option.label || key);
      if (!options.some((entry) => String(entry.value) === key)) options.push(option);
    }
    for (const id of Array.isArray(idsToSelect) ? idsToSelect : []) {
      if (id === undefined || id === null || id === '') continue;
      selectedValues.add(String(id));
    }
    syncSelection();
  };
  return wrapper;
}

export function paginationControls(pagination, onPageChange) {
  if (!pagination || pagination.totalPages <= 1) return null;

  const previous = element('button', {
    className: 'button-secondary min-h-9 px-3 py-1.5',
    text: 'Previous',
    attrs: { type: 'button', ...(pagination.page <= 1 ? { disabled: '' } : {}) }
  });
  const next = element('button', {
    className: 'button-secondary min-h-9 px-3 py-1.5',
    text: 'Next',
    attrs: { type: 'button', ...(pagination.page >= pagination.totalPages ? { disabled: '' } : {}) }
  });
  previous.addEventListener('click', () => onPageChange(pagination.page - 1));
  next.addEventListener('click', () => onPageChange(pagination.page + 1));

  return element('nav', { className: 'mt-5 flex flex-col items-center justify-between gap-3 sm:flex-row', attrs: { 'aria-label': 'Pagination' } }, [
    element('p', {
      className: 'text-sm text-muted',
      text: `Page ${pagination.page} of ${pagination.totalPages} · ${pagination.total} records`
    }),
    element('div', { className: 'flex gap-2' }, [previous, next])
  ]);
}

// Single-overlay slot: dialogs and drawers share #modal-root and never
// stack. Opening a new overlay silently retires the previous one (listeners
// removed, scroll lock handed over) so recursive detail refreshes
// (viewRecord → viewRecord) cannot leak key handlers or strand focus.
let currentOverlayClose = null;
function claimOverlaySlot(close) {
  const previous = currentOverlayClose;
  currentOverlayClose = close;
  if (previous && previous !== close) {
    try { previous({ silent: true }); } catch { /* retirement is best-effort */ }
  }
}
function releaseOverlaySlot(close) {
  if (currentOverlayClose === close) currentOverlayClose = null;
}

export function openDialog({ title, content, submitLabel = 'Save', submitClassName = 'button-primary', cancelLabel = 'Cancel', pendingLabel = 'Saving…', showFooter = true, showCloseButton = true, panelClass = '', description = null, onSubmit }) {
  const root = document.getElementById('modal-root');
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = element('div', {
    className: 'dialog-overlay fixed inset-0 z-50 grid grid-cols-1 place-items-end bg-ink/35 p-0 sm:place-items-center sm:p-5',
    attrs: { role: 'presentation' }
  });
  // grid-cols-1 pins the single track to minmax(0,1fr) so no amount of wide
  // content can push the panel past the viewport; min-w-0 + wrap-anywhere let
  // every descendant (long URLs, tokens, titles) wrap instead of stretching
  // the panel's scroll area horizontally on small screens.
  const form = element('form', {
    className: `dialog-panel max-h-[92vh] w-full min-w-0 wrap-anywhere overflow-y-auto rounded-t-2xl bg-paper shadow-2xl sm:max-w-2xl sm:rounded-2xl${panelClass ? ` ${panelClass}` : ''}`,
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title', ...(description ? { 'aria-describedby': 'dialog-description' } : {}) }
  });
  const closeButton = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': 'Close dialog' } }, [icon('close', { size: 20 })]);
  const submitButton = submitLabel ? element('button', { className: `${submitClassName} max-w-full`, text: submitLabel, attrs: { type: 'submit' } }) : null;
  const cancelButton = element('button', { className: 'button-secondary max-w-full', text: cancelLabel, attrs: { type: 'button' } });
  let closed = false;
  const focusable = () => [...form.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  const close = ({ silent = false } = {}) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    releaseOverlaySlot(close);
    if (!silent && previouslyFocused?.isConnected) requestAnimationFrame(() => previouslyFocused.focus({ preventScroll: true }));
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const controls = focusable();
    if (!controls.length) return event.preventDefault();
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  closeButton.addEventListener('click', close);
  cancelButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  if (submitButton && typeof onSubmit === 'function') form.addEventListener('submit', async (event) => {
    event.preventDefault();
    // Local pending feedback on the submit action itself (never a blocking
    // overlay). Guarded so double-submit cannot re-enter; cleanup restores
    // the original label, enabled state, and removes the spinner.
    if (!setActionPending(submitButton, true, { pendingLabel })) return;
    try {
      await onSubmit(form, close);
    } catch (error) {
      showToast(error.message || 'Unable to save.', 'error');
      setActionPending(submitButton, false);
    }
  });

  form.append(
    element('header', { className: 'dialog-header sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-stone bg-paper px-5 py-4 sm:px-6' }, [
      element('h2', { className: 'dialog-title min-w-0 break-words font-display text-lg font-semibold text-ink', text: title, attrs: { id: 'dialog-title' } }),
      ...(showCloseButton ? [closeButton] : [])
    ]),
    element('div', { className: 'grid gap-4 p-5 grid-cols-1 sm:grid-cols-2 sm:p-6' }, [
      ...(description ? [element('p', { className: 'text-sm leading-6 text-muted sm:col-span-2', text: description, attrs: { id: 'dialog-description' } })] : []),
      ...content
    ]),
    ...(showFooter ? [element('footer', { className: 'dialog-footer sticky bottom-0 flex flex-wrap justify-end gap-3 border-t border-stone bg-paper px-5 py-4 sm:px-6' }, [cancelButton, ...(submitButton ? [submitButton] : [])])] : [])
  );
  overlay.appendChild(form);
  claimOverlaySlot(close);
  root.replaceChildren(overlay);
  document.addEventListener('keydown', onKeyDown);
  (form.querySelector('input, select, textarea') || focusable()[0])?.focus();
  return close;
}

// v5.1-E.1 drawer / detail primitive — read/detail-only presentation model.
// Desktop: contextual right-side panel preserving collection context.
// Mobile: full-screen focused sheet. Forms stay in dialogs (openDialog);
// drawers never host a second form stack. Single-instance like dialogs:
// opening a drawer replaces any open dialog/drawer overlay.
// Focus trap + Escape + overlay-click + focus return mirror openDialog.
export function openDrawer({ title, subtitle = null, content = [], actions = [], onClose = null }) {
  const root = document.getElementById('modal-root');
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = element('div', { className: 'drawer-overlay', attrs: { role: 'presentation' } });
  const panel = element('section', {
    className: 'drawer-panel',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' }
  });
  const closeButton = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': 'Close detail panel' } }, [icon('close', { size: 20 })]);
  let closed = false;
  const focusable = () => [...panel.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  const close = ({ silent = false } = {}) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.body.style.overflow = '';
    overlay.remove();
    releaseOverlaySlot(close);
    if (!silent) {
      try { onClose?.(); } catch { /* close hooks are best-effort */ }
      if (previouslyFocused?.isConnected) requestAnimationFrame(() => previouslyFocused.focus({ preventScroll: true }));
    }
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = focusable();
    if (!controls.length) return event.preventDefault();
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  panel.append(
    element('header', { className: 'drawer-header' }, [
      element('div', { className: 'min-w-0' }, [
        element('h2', { className: 'drawer-title', text: title, attrs: { id: 'drawer-title' } }),
        ...(subtitle ? [element('p', { className: 'drawer-subtitle', text: subtitle })] : [])
      ]),
      closeButton
    ]),
    element('div', { className: 'drawer-body' }, content),
    ...(actions.length ? [element('footer', { className: 'drawer-footer' }, actions)] : [])
  );
  overlay.appendChild(panel);
  claimOverlaySlot(close);
  root.replaceChildren(overlay);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKeyDown, true);
  (panel.querySelector('button:not([disabled]), [href], input, select, textarea') || closeButton)?.focus();
  return close;
}

// v5.1-E corrective spotlight detail modal — the primary entity detail UX.
// Centered, content-appropriate width (vocab/grammar ~58rem, kanji ~68rem),
// dimmed + subtly blurred backdrop, read state first with explicit actions.
// Mobile becomes a full-screen focused experience. Replaces the rejected
// side drawer for Vocabulary/Kanji/Grammar detail; openDrawer stays exported
// but is no longer the detail path. Single-overlay slot, focus trap, Escape,
// overlay-click, and focus return mirror openDialog.
export function openDetailModal({ title, subtitle = null, content = [], actions = [], size = 'default', onClose = null }) {
  const root = document.getElementById('modal-root');
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = element('div', { className: 'detail-overlay', attrs: { role: 'presentation' } });
  const panel = element('section', {
    className: `detail-panel${size === 'kanji' ? ' detail-panel--kanji' : ''}`,
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'detail-title' }
  });
  const closeButton = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': 'Close detail view' } }, [icon('close', { size: 20 })]);
  let closed = false;
  const focusable = () => [...panel.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  const close = ({ silent = false } = {}) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.body.style.overflow = '';
    overlay.remove();
    releaseOverlaySlot(close);
    if (!silent) {
      try { onClose?.(); } catch { /* close hooks are best-effort */ }
      if (previouslyFocused?.isConnected) requestAnimationFrame(() => previouslyFocused.focus({ preventScroll: true }));
    }
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = focusable();
    if (!controls.length) return event.preventDefault();
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  panel.append(
    element('header', { className: 'detail-header' }, [
      element('div', { className: 'min-w-0' }, [
        element('h2', { className: 'detail-title', text: title, attrs: { id: 'detail-title' } }),
        ...(subtitle ? [element('p', { className: 'detail-subtitle', text: subtitle })] : [])
      ]),
      closeButton
    ]),
    element('div', { className: 'detail-body' }, content),
    ...(actions.length ? [element('footer', { className: 'detail-footer' }, actions)] : [])
  );
  overlay.appendChild(panel);
  claimOverlaySlot(close);
  root.replaceChildren(overlay);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKeyDown, true);
  (panel.querySelector('button:not([disabled]), [href], input, select, textarea') || closeButton)?.focus();
  return close;
}

export function confirmDialog({ title = 'Confirm deletion', description, confirmLabel = 'Delete', confirmClassName = 'button-danger', pendingLabel = 'Deleting…', onConfirm }) {
  return openDialog({
    title,
    description,
    content: [],
    submitLabel: confirmLabel,
    submitClassName: confirmClassName,
    pendingLabel,
    onSubmit: async (form, close) => {
      await onConfirm();
      close();
    }
  });
}

export function formatDate(value) {
  if (!value) return 'No date';
  const isoDate = String(value).slice(0, 10);
  const date = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? isoDate
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

export function debounce(callback, delay = 250) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
}
