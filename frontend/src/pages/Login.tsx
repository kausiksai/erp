import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { InputText } from 'primereact/inputtext'
import { Password } from 'primereact/password'
import { Button } from 'primereact/button'
import { Toast } from 'primereact/toast'
import { apiUrl } from '../utils/api'
import { useAuth } from '../contexts/AuthContext'
import Header from '../components/Header'
import styles from './Login.module.css'

function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { login } = useAuth()
  const toast = useRef<Toast>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const response = await fetch(apiUrl('auth/login'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      })

      let data
      try {
        data = await response.json()
      } catch (parseError) {
        throw new Error('Invalid response from server')
      }

      if (!response.ok) {
        throw new Error(data.message || 'Login failed')
      }

      if (data.token && data.user) {
        login(data.token, data.user)
        navigate('/')
      } else {
        throw new Error('Invalid response from server')
      }
    } catch (err: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Login Failed',
        detail: err.message || 'An error occurred during login',
        life: 5000
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.loginPage}>
      <Header />
      <Toast ref={toast} position="top-right" />
      <div className={styles.loginLayout}>
        <div className={styles.leftSection}>
          <div className={styles.brandingContent}>
            <div className={styles.brandHeader}>
              <div className={styles.brandLogo}>
                <i className="pi pi-building"></i>
              </div>
              <h1 className={styles.brandTitle}>Billing System</h1>
            </div>
            <p className={styles.brandDescription}>
              Streamline your invoicing and billing processes with our comprehensive enterprise solution. 
              Manage suppliers, purchase orders, and invoices all in one place.
            </p>
            <div className={styles.featuresGrid}>
              <div className={styles.featureCard}>
                <div className={styles.featureIcon}>
                  <i className="pi pi-shield"></i>
                </div>
                <h3 className={styles.featureTitle}>Secure</h3>
                <p className={styles.featureText}>Enterprise-grade security and encryption</p>
              </div>
              <div className={styles.featureCard}>
                <div className={styles.featureIcon}>
                  <i className="pi pi-bolt"></i>
                </div>
                <h3 className={styles.featureTitle}>Fast</h3>
                <p className={styles.featureText}>Lightning-fast processing and real-time updates</p>
              </div>
              <div className={styles.featureCard}>
                <div className={styles.featureIcon}>
                  <i className="pi pi-chart-line"></i>
                </div>
                <h3 className={styles.featureTitle}>Analytics</h3>
                <p className={styles.featureText}>Comprehensive reporting and insights</p>
              </div>
              <div className={styles.featureCard}>
                <div className={styles.featureIcon}>
                  <i className="pi pi-mobile"></i>
                </div>
                <h3 className={styles.featureTitle}>Accessible</h3>
                <p className={styles.featureText}>Access from anywhere, anytime</p>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.rightSection}>
          <div className={styles.loginPanel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>Sign In</h2>
              <p className={styles.panelSubtitle}>Enter your credentials to access your account</p>
            </div>

            <form onSubmit={handleSubmit} className={styles.loginForm}>
              <div className={styles.formField}>
                <label htmlFor="username" className={styles.fieldLabel}>
                  Username or Email
                </label>
                <div className={styles.inputContainer}>
                  <i className={`pi pi-user ${styles.fieldIcon}`}></i>
                  <InputText
                    id="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className={styles.textInput}
                    placeholder="Enter your username or email"
                    required
                    autoFocus
                    disabled={loading}
                  />
                </div>
              </div>

              <div className={styles.formField}>
                <label htmlFor="password" className={styles.fieldLabel}>
                  Password
                </label>
                <div className={styles.inputContainer}>
                  <i className={`pi pi-lock ${styles.fieldIcon}`}></i>
                  <Password
                    id="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={styles.passwordWrapper}
                    placeholder="Enter your password"
                    feedback={false}
                    toggleMask
                    required
                    disabled={loading}
                    inputClassName={styles.passwordInput}
                  />
                </div>
              </div>

              <Button
                type="submit"
                label={loading ? 'Signing in...' : 'Sign In'}
                icon={loading ? 'pi pi-spin pi-spinner' : 'pi pi-sign-in'}
                className={styles.submitButton}
                disabled={loading || !username || !password}
                loading={loading}
              />
            </form>

            <div className={styles.panelFooter}>
              <div className={styles.securityBadge}>
                <i className="pi pi-shield"></i>
                <span>Protected by enterprise-grade security</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Login
