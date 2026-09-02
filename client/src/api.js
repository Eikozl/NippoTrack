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
