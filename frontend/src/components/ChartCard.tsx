import { useEffect, useRef } from 'react'
import { Chart, registerables } from 'chart.js'
import type { ChartConfiguration } from 'chart.js'
import type { ReactNode } from 'react'

Chart.register(...registerables)

interface ChartCardProps {
  title: string
  subtitle?: string
  icon?: string
  config: ChartConfiguration
  height?: number
  action?: ReactNode
}

/**
 * ChartCard wraps a chart.js canvas in our glass-card container. It recreates
 * the chart whenever the `config` object changes, and destroys the previous
 * instance on cleanup to avoid canvas reuse errors.
 */
function ChartCard({ title, subtitle, icon = 'pi-chart-bar', config, height = 280, action }: ChartCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Clean up any previous instance before creating a new one
    chartRef.current?.destroy()

    // Read CSS variables at mount so colours follow the current theme
    const style = getComputedStyle(document.documentElement)
    const textPrimary = style.getPropertyValue('--text-primary').trim() || '#0f172a'
    const textMuted = style.getPropertyValue('--text-muted').trim() || '#64748b'
    const borderSubtle = style.getPropertyValue('--border-subtle').trim() || 'rgba(15,23,42,0.06)'

    const defaults: ChartConfiguration['options'] = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: {
        legend: {
          labels: {
            color: textMuted,
            font: { family: style.getPropertyValue('--font-sans') || 'Inter, sans-serif', size: 12 },
            boxWidth: 14,
            boxHeight: 14,
            padding: 14
          }
        },
        tooltip: {
          backgroundColor: textPrimary,
          padding: 12,
          cornerRadius: 10,
          titleFont: { weight: 600 },
          boxPadding: 4
        }
      },
      scales: {
        x: {
          grid: { color: borderSubtle, drawTicks: false },
          ticks: { color: textMuted, padding: 8 },
          border: { display: false }
        },
        y: {
          grid: { color: borderSubtle, drawTicks: false },
          ticks: { color: textMuted, padding: 8 },
          border: { display: false }
        }
      }
    }

    chartRef.current = new Chart(canvas, {
      ...config,
      options: {
        ...defaults,
        ...(config.options ?? {}),
        plugins: {
          ...(defaults.plugins ?? {}),
          ...((config.options && (config.options as typeof defaults).plugins) ?? {})
        },
        scales: config.type === 'doughnut' || config.type === 'pie' || config.type === 'radar' ? undefined : {
          ...(defaults.scales ?? {}),
          ...((config.options && (config.options as typeof defaults).scales) ?? {})
        }
      }
    })

    return () => {
      chartRef.current?.destroy()
      chartRef.current = null
    }
  }, [config])

  return (
    <div className="glass-card fade-in-up">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h3 className="glass-card__title">
            <i className={`pi ${icon}`} aria-hidden style={{ color: 'var(--brand-600)' }} />
            {title}
          </h3>
          {subtitle && <div className="glass-card__subtitle">{subtitle}</div>}
        </div>
        {action}
      </div>
      <div className="chart-wrap" style={{ height: `${height}px` }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}

export default ChartCard
