import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { useToast } from '../contexts/ToastContext'
import { apiUrl, getErrorMessageFromResponse, getDisplayError } from '../utils/api'

/**
 * Sign-in screen. Two-column layout:
 *   left  — brand panel (gradient + production metrics)
 *   right — auth form (email + password, show/hide, remember, forgot link)
 *
 * Auth flow is unchanged from the prior version: POST /auth/login,
 * stash the token via AuthContext.login(), then navigate to /.
 */
function Login() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const toast = useToast()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [remember, setRemember] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { document.title = 'Sign in · Srimukha Precision' }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!username.trim() || !password) {
      setError('Please enter both username and password.')
      return
    }
    setLoading(true)
    try {
      const res = await fetch(apiUrl('auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password })
      })
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Invalid credentials')
        throw new Error(msg)
      }
      const data = await res.json()
      login(data.token, data.user)
      navigate('/', { replace: true })
    } catch (err: unknown) {
      setError(getDisplayError(err))
    } finally {
      setLoading(false)
    }
  }

  function handleForgot(e: React.MouseEvent) {
    e.preventDefault()
    if (!username.trim()) {
      toast.warn('Enter your email first', 'Type your work email above and click Forgot password again.')
      return
    }
    toast.info('Reset link sent', `If an account matches ${username.trim()}, a reset link will arrive in your inbox shortly.`)
  }

  return (
    <div className="login-shell" data-theme={theme}>
      {/* corner theme toggle */}
      <button
        type="button"
        className="login-shell__theme"
        onClick={toggleTheme}
        aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      >
        <i className={`pi ${theme === 'light' ? 'pi-moon' : 'pi-sun'}`} />
      </button>

      <div className="login-grid">

        {/* ============== LEFT — BRAND PANEL ============== */}
        <aside className="login-hero">
          <div className="login-brand">
            <div className="login-brand__mark">SP</div>
            <div>
              <div className="login-brand__name">Srimukha Precision</div>
              <div className="login-brand__product">Billing &amp; Payments</div>
            </div>
          </div>

          <div className="login-hero__body">
            <span className="login-hero__eyebrow"><i className="pi pi-bolt" /> Welcome back</span>
            <h1 className="login-hero__title">
              Validate, reconcile, and pay supplier invoices — without the chaos.
            </h1>
            <p className="login-hero__sub">
              Daily Bill Register and OCR pipelines feed straight into a 28-rule
              validation engine, so your team only touches the invoices that
              actually need a human.
            </p>

            <div className="login-metrics">
              <div className="login-metric">
                <div className="login-metric__l">Invoices</div>
                <div className="login-metric__v">1,643</div>
                <div className="login-metric__f">in system</div>
              </div>
              <div className="login-metric">
                <div className="login-metric__l">Validated</div>
                <div className="login-metric__v">230</div>
                <div className="login-metric__f">ready for payment</div>
              </div>
              <div className="login-metric">
                <div className="login-metric__l">Avg cycle</div>
                <div className="login-metric__v">28d</div>
                <div className="login-metric__f">load → bank</div>
              </div>
            </div>
          </div>

          <div className="login-hero__foot">
            <span>© {new Date().getFullYear()} Srimukha Precision Tech Pvt Ltd</span>
            <span>
              <a href="#" onClick={(e) => e.preventDefault()}>Privacy</a> ·{' '}
              <a href="#" onClick={(e) => e.preventDefault()}>Terms</a> ·{' '}
              <a href="#" onClick={(e) => e.preventDefault()}>Help</a>
            </span>
          </div>
        </aside>

        {/* ============== RIGHT — FORM ============== */}
        <main className="login-form-pane">
          <div className="login-form-inner">
            <div className="login-form__crumb"><i className="pi pi-shield" /> Secure sign in</div>
            <h2 className="login-form__title">Sign in to your account</h2>
            <p className="login-form__sub">Enter your work email and password to continue.</p>

            <form onSubmit={handleSubmit} noValidate>
              <div className="login-field">
                <label htmlFor="login-username">Work email or username</label>
                <div className="login-field__wrap">
                  <i className="pi pi-envelope login-field__ic" />
                  <input
                    id="login-username"
                    type="text"
                    autoComplete="username"
                    placeholder="you@srimukha.com"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={loading}
                    required
                  />
                </div>
              </div>

              <div className="login-field">
                <label htmlFor="login-password">Password</label>
                <div className="login-field__wrap">
                  <i className="pi pi-lock login-field__ic" />
                  <input
                    id="login-password"
                    type={showPw ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    required
                  />
                  <button
                    type="button"
                    className="login-field__toggle"
                    onClick={() => setShowPw((v) => !v)}
                    tabIndex={-1}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                  >
                    <i className={`pi ${showPw ? 'pi-eye-slash' : 'pi-eye'}`} />
                  </button>
                </div>
              </div>

              <div className="login-row">
                <label className="login-check">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  <span>Keep me signed in</span>
                </label>
                <a href="#" className="login-forgot" onClick={handleForgot}>Forgot password?</a>
              </div>

              {error && (
                <div className="login-alert login-alert--err" role="alert">
                  <i className="pi pi-exclamation-circle" />
                  <span>{error}</span>
                </div>
              )}

              <button type="submit" className="login-submit" disabled={loading}>
                {loading
                  ? (<><i className="pi pi-spin pi-spinner" /> <span>Signing in…</span></>)
                  : (<><i className="pi pi-sign-in" /> <span>Sign in</span></>)
                }
              </button>
            </form>

            <p className="login-foot">
              Don't have an account? Ask your <a href="#" onClick={(e) => e.preventDefault()}>workspace administrator</a> to invite you.
            </p>
          </div>
        </main>
      </div>
    </div>
  )
}

export default Login
