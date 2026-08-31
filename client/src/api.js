const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function apiRequest(path, { method = 'GET', body, signal, notifyAuth = true } = {}) {
  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
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
    if (response.status === 401 && notifyAuth) window.dispatchEvent(new CustomEvent('jlt-auth-required'));
    throw new ApiError(data?.error || 'Request failed.', response.status);
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
