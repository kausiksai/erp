import { useState, useEffect, useCallback } from 'react'

/**
 * Returns a debounced value that updates after `delay` ms of no changes.
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debouncedValue
}

/**
 * Returns a stable callback that invokes the latest fn after `delay` ms from last call.
 */
export function useDebouncedCallback<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): T {
  const timeoutRef = { current: null as ReturnType<typeof setTimeout> | null }
  const fnRef = { current: fn }
  fnRef.current = fn

  const debounced = useCallback(
    ((...args: unknown[]) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        fnRef.current(...args)
      }, delay)
    }) as T,
    [delay]
  )

  return debounced
}
