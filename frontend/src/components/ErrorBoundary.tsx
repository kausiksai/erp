import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div
          style={{
            padding: '2rem',
            maxWidth: '600px',
            margin: '2rem auto',
            fontFamily: 'system-ui, sans-serif',
            border: '1px solid #fecaca',
            borderRadius: '12px',
            background: '#fef2f2',
          }}
        >
          <h2 style={{ color: '#b91c1c', marginTop: 0 }}>Something went wrong</h2>
          <p style={{ color: '#991b1b', marginBottom: '1rem' }}>
            {this.state.error.message}
          </p>
          <pre
            style={{
              fontSize: '0.75rem',
              overflow: 'auto',
              padding: '1rem',
              background: '#fff',
              border: '1px solid #fecaca',
              borderRadius: '8px',
            }}
          >
            {this.state.error.stack}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              cursor: 'pointer',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
            }}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
