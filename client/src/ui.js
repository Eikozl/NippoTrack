export function element(tagName, { className, text, attrs, dataset } = {}, children = []) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);

  Object.entries(attrs || {}).forEach(([name, value]) => {
    if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  });
  Object.entries(dataset || {}).forEach(([name, value]) => {
    node.dataset[name] = String(value);
  });
  const normalizedChildren = Array.isArray(children) ? children : [children];
  normalizedChildren.filter(Boolean).forEach((child) => node.appendChild(child));
  return node;
}

export function pageHeader({ eyebrow, title, description, action }) {
  const copy = element('div', {}, [
    element('p', { className: 'eyebrow', text: eyebrow }),
    element('h1', { className: 'mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-3xl', text: title }),
    element('p', { className: 'mt-2 max-w-2xl text-sm leading-6 text-muted', text: description })
  ]);
  return element('header', { className: 'mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between' }, [copy, action]);
}

export function loadingState(label = 'Loading data…') {
  return element('div', { className: 'surface grid min-h-52 place-items-center p-8' }, [
    element('div', { className: 'grid justify-items-center gap-3 text-muted' }, [
      element('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }),
      element('p', { className: 'text-sm', text: label })
    ])
  ]);
}

export function emptyState({ title = 'Nothing here yet', description = 'Create your first record to get started.' } = {}) {
  return element('div', { className: 'surface grid min-h-52 place-items-center p-8 text-center' }, [
    element('div', {}, [
      element('p', { className: 'text-base font-semibold text-ink', text: title }),
      element('p', { className: 'mt-2 max-w-md text-sm leading-6 text-muted', text: description })
    ])
  ]);
}

export function errorState(error, retry) {
  const retryButton = retry ? element('button', { className: 'button-secondary mt-4', text: 'Try again', attrs: { type: 'button' } }) : null;
  retryButton?.addEventListener('click', retry);
  return element('div', { className: 'surface border-red-200 bg-red-50/60 p-6' }, [
    element('p', { className: 'font-semibold text-red-800', text: 'We could not load this view.' }),
    element('p', { className: 'mt-2 text-sm text-red-700', text: error?.message || 'Unexpected error.' }),
    retryButton
  ]);
}

export function showToast(message, type = 'success') {
  const region = document.getElementById('toast-region');
  const toast = element('div', {
    className: `pointer-events-auto rounded-xl border bg-white px-4 py-3 text-sm shadow-lg ${type === 'error' ? 'border-red-200 text-red-800' : 'border-stone text-ink'}`,
    text: message,
    attrs: { role: type === 'error' ? 'alert' : 'status' }
  });
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

export function field({ name, label, type = 'text', value = '', required = false, maxLength, options, multiple = false, placeholder = '' }) {
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
        ...(type === 'number' ? { min: '1', step: '1' } : {})
      }
    });
  }

  return element('label', { className: 'field', attrs: { for: `field-${name}` } }, [
    element('span', { text: label }),
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
  const optionLabels = new Map(options.map((option) => [String(option.value), option.label]));
  const labelId = `field-${name}-label`;
  const hiddenSelect = element('select', {
    className: 'hidden',
    attrs: { name, id: `field-${name}`, multiple: '', 'aria-hidden': 'true', tabindex: '-1' }
  });

  const chips = element('div', { className: 'flex min-h-8 flex-wrap gap-2' });
  const optionsList = element('div', {
    className: 'max-h-40 overflow-y-auto rounded-lg border border-stone bg-white p-1',
    attrs: { role: 'group', 'aria-labelledby': labelId }
  });
  const search = element('input', {
    className: 'field-control',
    attrs: { type: 'search', placeholder, autocomplete: 'off', 'aria-labelledby': labelId }
  });
  let optionRows = [];
  let requestSequence = 0;

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
        text: '×',
        attrs: { type: 'button', 'aria-label': `Remove ${optionLabels.get(selectedValue)}` }
      });
      removeButton.addEventListener('click', () => {
        selectedValues.delete(selectedValue);
        syncSelection();
      });
      chips.appendChild(element('span', { className: 'inline-flex items-center rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-ink' }, [
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
      optionLabels.set(optionValue, option.label);
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
      const row = element('label', { className: 'flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-sm font-normal transition hover:bg-paper' }, [
        checkbox,
        element('span', { className: 'min-w-0 leading-5 text-ink', text: option.label })
      ]);
      optionRows.push({ checkbox, row, searchText: option.label.toLocaleLowerCase() });
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

  search.addEventListener('input', debounce(async () => {
    const query = search.value.trim();
    if (!loadOptions) {
      const normalizedQuery = query.toLocaleLowerCase();
      const filtered = options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery));
      renderOptions(filtered, 'No matches found.');
      return;
    }

    const sequence = ++requestSequence;
    optionsList.replaceChildren(element('p', { className: 'p-4 text-center text-sm font-normal text-muted', text: 'Searching…' }));
    try {
      const loadedOptions = await loadOptions(query);
      if (sequence !== requestSequence) return;
      renderOptions(loadedOptions, query ? 'No matches found.' : emptyMessage);
    } catch {
      if (sequence !== requestSequence) return;
      renderOptions([], 'Unable to load options. Try again.');
    }
  }, 250));

  renderOptions(options);
  return element('div', { className: 'field' }, [header, search, chips, optionsList, hiddenSelect]);
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

export function openDialog({ title, content, submitLabel = 'Save', onSubmit }) {
  const root = document.getElementById('modal-root');
  const overlay = element('div', {
    className: 'fixed inset-0 z-50 grid place-items-end bg-ink/35 p-0 sm:place-items-center sm:p-5',
    attrs: { role: 'presentation' }
  });
  const form = element('form', {
    className: 'max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:max-w-2xl sm:rounded-2xl',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' }
  });
  const closeButton = element('button', { className: 'icon-button', text: '×', attrs: { type: 'button', 'aria-label': 'Close dialog' } });
  const submitButton = element('button', { className: 'button-primary', text: submitLabel, attrs: { type: 'submit' } });
  const cancelButton = element('button', { className: 'button-secondary', text: 'Cancel', attrs: { type: 'button' } });
  const close = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') close();
  };

  closeButton.addEventListener('click', close);
  cancelButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    submitButton.textContent = 'Saving…';
    try {
      await onSubmit(form, close);
    } catch (error) {
      showToast(error.message || 'Unable to save.', 'error');
      submitButton.disabled = false;
      submitButton.textContent = submitLabel;
    }
  });

  form.append(
    element('header', { className: 'sticky top-0 z-10 flex items-center justify-between border-b border-stone bg-white px-5 py-4 sm:px-6' }, [
      element('h2', { className: 'text-lg font-semibold text-ink', text: title, attrs: { id: 'dialog-title' } }),
      closeButton
    ]),
    element('div', { className: 'grid gap-4 p-5 sm:grid-cols-2 sm:p-6' }, content),
    element('footer', { className: 'sticky bottom-0 flex justify-end gap-3 border-t border-stone bg-white px-5 py-4 sm:px-6' }, [cancelButton, submitButton])
  );
  overlay.appendChild(form);
  root.replaceChildren(overlay);
  document.addEventListener('keydown', onKeyDown);
  form.querySelector('input, select, textarea')?.focus();
  return close;
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
