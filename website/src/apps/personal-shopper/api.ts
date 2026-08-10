/**
 * Personal Shopper API client — thin wrapper around fetch with same-origin credentials.
 */

const BASE = '/api/apps/personal-shopper'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body && typeof body.error === 'string') message = body.error
    } catch { /* non-JSON */ }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path)
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}
