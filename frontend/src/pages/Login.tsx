import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { apiUrl, getErrorMessageFromResponse, getDisplayError } from '../utils/api'

/**
 * Login — Srimukha Precision Billing & Payments portal.
 * Two-pane layout: animated hero on the left, clean auth form on the right.
 * Fully theme-aware (light + dark), accessible, keyboard friendly.
 */
function Login() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const { theme, toggleTheme } = useTheme()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [remember, setRemember] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    document.title = 'Sign in · Srimukha Precision'
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
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

  return (
    <div className="loginShell" data-theme={theme}>
      {/* Ambient gradient blobs */}
      <div className="loginShell__blob loginShell__blob--a" aria-hidden />
      <div className="loginShell__blob loginShell__blob--b" aria-hidden />
      <div className="loginShell__blob loginShell__blob--c" aria-hidden />

      {/* Theme toggle in corner */}
      <button
        type="button"
        className="loginShell__themeBtn"
        onClick={toggleTheme}
        aria-label="Toggle theme"
        title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
      >
        <i className={`pi ${theme === 'light' ? 'pi-moon' : 'pi-sun'}`} />
      </button>

      <div className="loginShell__panel">
        {/* Left — brand hero */}
        <aside className="loginHero">
          <div className="loginHero__brand">
            <div className="loginHero__mark">
              <i className="pi pi-bolt" aria-hidden />
            </div>
            <div className="loginHero__brandText">
              <div className="loginHero__company">Srimukha Precision</div>
              <div className="loginHero__tagline">Billing &amp; Payments portal</div>
            </div>
          </div>

          <h1 className="loginHero__title">
            An AI-powered<br />procurement control tower.
          </h1>
          <p className="loginHero__subtitle">
            Automate invoice validation, reconcile purchase orders,
            accelerate payments — all from one operational cockpit.
          </p>

          <ul className="loginHero__features">
            <li><i className="pi pi-check-circle" /> End-to-end PO → GRN → Invoice reconciliation</li>
            <li><i className="pi pi-check-circle" /> Automated tax, GST and amendment checks</li>
            <li><i className="pi pi-check-circle" /> Live analytics across suppliers &amp; cashflow</li>
            <li><i className="pi pi-check-circle" /> Structured approval workflows with audit trail</li>
          </ul>

          <div className="loginHero__meta">
            <div>
              <div className="loginHero__metaValue">₹ 42Cr+</div>
              <div className="loginHero__metaLabel">processed</div>
            </div>
            <div>
              <div className="loginHero__metaValue">99.3%</div>
              <div className="loginHero__metaLabel">auto-validated</div>
            </div>
            <div>
              <div className="loginHero__metaValue">24×7</div>
              <div className="loginHero__metaLabel">monitoring</div>
            </div>
          </div>
        </aside>

        {/* Right — auth form */}
        <main className="loginForm">
          <div className="loginForm__card">
            <div className="loginForm__badge">
              <i className="pi pi-lock" /> Secure access
            </div>
            <h2 className="loginForm__title">Welcome back</h2>
            <p className="loginForm__subtitle">Sign in to continue to your control tower.</p>

            <form onSubmit={handleSubmit} className="loginForm__form" noValidate>
              <div className="loginForm__field">
                <label htmlFor="login-username">Username or email</label>
                <div className="loginForm__inputWrap">
                  <i className="pi pi-user" aria-hidden />
                  <input
                    id="login-username"
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Username or Email"
                    required
                    disabled={loading}
                  />
                </div>
              </div>

              <div className="loginForm__field">
                <label htmlFor="login-password">Password</label>
                <div className="loginForm__inputWrap">
                  <i className="pi pi-key" aria-hidden />
                  <input
                    id="login-password"
                    type={showPw ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    disabled={loading}
                  />
                  <button
                    type="button"
                    className="loginForm__peek"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    <i className={`pi ${showPw ? 'pi-eye-slash' : 'pi-eye'}`} />
                  </button>
                </div>
              </div>

              <div className="loginForm__row">
                <label className="loginForm__check">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  <span>Keep me signed in</span>
                </label>
                <a href="#" className="loginForm__link" onClick={(e) => e.preventDefault()}>
                  Forgot password?
                </a>
              </div>

              {error && (
                <div className="loginForm__error" role="alert">
                  <i className="pi pi-exclamation-circle" />
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="loginForm__submit"
                disabled={loading}
              >
                {loading ? (
                  <><i className="pi pi-spin pi-spinner" /> Signing in…</>
                ) : (
                  <>Sign in <i className="pi pi-arrow-right" /></>
                )}
              </button>
            </form>

            <div className="loginForm__divider"><span>trusted tools</span></div>
            <div className="loginForm__badges">
              <span><i className="pi pi-shield" /> SSL</span>
              <span><i className="pi pi-database" /> PostgreSQL</span>
              <span><i className="pi pi-chart-line" /> Live analytics</span>
            </div>

            <p className="loginForm__foot">
              © {new Date().getFullYear()} Srimukha Precision Technologies · Billing portal
            </p>
          </div>
        </main>
      </div>
    </div>
  )
}

export default Login
