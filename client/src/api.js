const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
import { accessToken } from './authClient';

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function apiRequest(path, { method = 'GET', body, signal, notifyAuth = true } = {}) {
  let response;

  try {
    const token = await accessToken();
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(
      'Unable to reach the API. Run "npm start" from the project root and open the Vite URL.',
      0
    );
  }

  if (response.status === 204) {
    if (!response.ok) throw new ApiError('Request failed.', response.status);
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && notifyAuth) window.dispatchEvent(new CustomEvent('jlt-auth-required', { detail: { status: response.status, code: data?.code } }));
    throw new ApiError(data?.error || 'Request failed.', response.status, data);
  }

  return data;
}

// V5.3a — Immersion reading pipeline. Thin wrappers over apiRequest so pages
// never hand-build endpoint URLs.
export function analyzeImmersionText(text) {
  return apiRequest('/api/immersion/analyze', { method: 'POST', body: { text } });
}

export function createImmersionSession(payload) {
  return apiRequest('/api/immersion/create-session', { method: 'POST', body: payload });
}

export function listImmersionHistory({ page, limit, from, to, level } = {}) {
  return apiRequest(`/api/immersion/history${queryString({ page, limit, from, to, level })}`);
}

// V5.3a — Graded reading library + reader. Thin wrappers so pages never
// hand-build endpoint URLs or drift from the API contract.
export function listReadingLibrary({ level, source, date, page, limit } = {}) {
  return apiRequest(`/api/reading/library${queryString({ level, source, date, page, limit })}`);
}

export function getReadingText(id) {
  return apiRequest(`/api/reading/text/${encodeURIComponent(id)}`);
}

export function createUserReadingText({ text, title } = {}) {
  return apiRequest('/api/reading/user-text', { method: 'POST', body: { text, title } });
}

export function deleteReadingText(id) {
  return apiRequest(`/api/reading/text/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function updateReadingProgress(id, { position, timeSpentSeconds, completed } = {}) {
  return apiRequest(`/api/reading/text/${encodeURIComponent(id)}/progress`, {
    method: 'PUT',
    body: { position, ...(timeSpentSeconds !== undefined ? { timeSpentSeconds } : {}), ...(completed !== undefined ? { completed } : {}) }
  });
}

export function importReadingSources(sourceType, { urls, index } = {}) {
  return apiRequest('/api/reading/import', {
    method: 'POST',
    body: { sourceType, ...(urls !== undefined ? { urls } : {}), ...(index ? { index } : {}) }
  });
}

export function previewReadingImport(sourceType, index) {
  return apiRequest(`/api/reading/import/preview${queryString({ source: sourceType, index })}`);
}

export function importReadingUrl(url) {
  return apiRequest('/api/reading/import/url', { method: 'POST', body: { url } });
}

export function listReadingProgress({ page, limit } = {}) {
  return apiRequest(`/api/reading/progress${queryString({ page, limit })}`);
}

// Community reading texts: publish owned texts, browse the feed, import
// copies into the reader library. Thin wrappers, same contract style.
export function listReadingPublications({ limit, offset, ownerId } = {}) {
  return apiRequest(`/api/reading/publications${queryString({ limit, offset, ownerId })}`);
}

export function getReadingPublication(id) {
  return apiRequest(`/api/reading/publications/${encodeURIComponent(id)}`);
}

export function publishReadingText({ textId, title, description } = {}) {
  return apiRequest('/api/reading/publications', { method: 'POST', body: { textId, title, description } });
}

export function deleteReadingPublication(id) {
  return apiRequest(`/api/reading/publications/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function importReadingPublication(id) {
  return apiRequest(`/api/reading/publications/${encodeURIComponent(id)}/import`, { method: 'POST' });
}

export function queryString(values) {
  const params = new URLSearchParams();

  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      params.set(key, String(value).trim());
    }
  });

  const query = params.toString();
  return query ? `?${query}` : '';
}
