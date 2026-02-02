/**
 * Client-side validation helpers for forms.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  return EMAIL_REGEX.test(value.trim())
}

export function validatePassword(value: string): { valid: boolean; message?: string } {
  if (!value || value.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters' }
  }
  if (!/[a-zA-Z]/.test(value)) {
    return { valid: false, message: 'Password must contain at least one letter' }
  }
  if (!/[0-9]/.test(value)) {
    return { valid: false, message: 'Password must contain at least one number' }
  }
  return { valid: true }
}
