export function apiUrl(path: string): string {
  // Use /api prefix to leverage Vite proxy to backend (localhost:4000)
  // Vite proxy is configured in vite.config.ts to forward /api/* to http://localhost:4000
  const base = (import.meta as any).env?.VITE_API_URL as string | undefined
  const apiPrefix = base || '/api'
  
  // Remove leading slash from path if present
  const cleanPath = path.startsWith('/') ? path.slice(1) : path
  
  // If path already starts with 'api/', don't add it again
  if (cleanPath.startsWith('api/')) {
    return `/${cleanPath}`
  }
  
  // Otherwise, add the api prefix
  return `/${apiPrefix}/${cleanPath}`.replace(/\/+/g, '/')
}

const DEFAULT_ERROR = 'Something went wrong. Please try again.'
export const NETWORK_ERROR = 'Check your connection and try again.'

/** Use in catch blocks to show a user-friendly message (network vs generic). */
export function getDisplayError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === NETWORK_ERROR) return err.message
    // Treat common network/fetch failures as connection message
    const msg = (err.message || '').toLowerCase()
    if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed') || msg.includes('network request failed')) {
      return NETWORK_ERROR
    }
  }
  return err instanceof Error ? err.message : DEFAULT_ERROR
}

/**
 * Extract error message from API response body (e.g. { message: "..." }) or return fallback.
 */
export async function getErrorMessageFromResponse(
  response: Response,
  fallback: string = DEFAULT_ERROR
): Promise<string> {
  try {
    const data = await response.json()
    if (data && typeof data.message === 'string' && data.message.trim()) {
      return data.message.trim()
    }
    if (data && typeof data.error === 'string' && data.error.trim()) {
      return data.error.trim()
    }
  } catch {
    // response not JSON or empty
  }
  return fallback
}

/**
 * Clear auth and notify app to redirect to login (for 401/403).
 */
function handleUnauthorized() {
  localStorage.removeItem('authToken')
  localStorage.removeItem('authUser')
  window.dispatchEvent(new CustomEvent('auth:session-expired'))
}

/**
 * Fetch with authentication token.
 * - On 401/403: clears token and dispatches 'auth:session-expired' (listen in app to redirect to login).
 * - On network failure: throws with message NETWORK_ERROR so UI can show "Check your connection".
 * Use getErrorMessageFromResponse(response, fallback) when !response.ok to show server error in toast.
 */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('authToken')
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  let response: Response
  try {
    response = await fetch(apiUrl(path), { ...options, headers })
  } catch {
    throw new Error(NETWORK_ERROR)
  }

  if (response.status === 401 || response.status === 403) {
    handleUnauthorized()
  }
  return response
}
