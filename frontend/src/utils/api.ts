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
 * Fetch with authentication token.
 * Use getErrorMessageFromResponse(response, fallback) when !response.ok to show server error in toast.
 */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('authToken')
  
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  
  return fetch(apiUrl(path), {
    ...options,
    headers,
  })
}
