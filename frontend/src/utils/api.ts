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

/**
 * Fetch with authentication token
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
