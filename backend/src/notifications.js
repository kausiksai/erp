// Notifications — per-user feed for the topbar bell.
//
//   GET   /api/notifications?unread_only=&limit=&offset=
//   POST  /api/notifications/:notificationId/read       mark one read
//   POST  /api/notifications/read-all                   mark all read for user
//
// Plus a server-side helper `pushNotification(userId, ...)` for background
// jobs (integration runner, validation pipeline, payment-batch scheduler)
// to publish into a user's feed.

import { pool } from './db.js'

/**
 * Insert a notification for one user. Fire-and-forget; never throws into
 * the caller.
 */
export async function pushNotification({ userId, variant, title, body, link, meta }) {
  if (!userId || !title || !variant) return
  if (!['success', 'info', 'warn', 'danger'].includes(variant)) {
    console.warn('pushNotification: invalid variant', variant); return
  }
  try {
    await pool.query(`
      INSERT INTO notifications (user_id, variant, title, body, link, meta)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [userId, variant, title, body || null, link || null, meta ? JSON.stringify(meta) : null])
  } catch (err) {
    console.warn('pushNotification failed (non-fatal):', err.message)
  }
}

/**
 * GET /api/notifications
 */
export async function getNotificationsRoute(req, res) {
  try {
    const userId = req.user?.userId
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const { unread_only } = req.query
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100)
    const offset = parseInt(req.query.offset, 10) || 0

    const where = ['user_id = $1']
    const params = [userId]
    if (unread_only === 'true' || unread_only === '1') {
      where.push('read_at IS NULL')
    }

    let items = []
    let unreadCount = 0
    try {
      const [list, count] = await Promise.all([
        pool.query(`
          SELECT notification_id, ts, variant, title, body, link, read_at, meta
            FROM notifications
           WHERE ${where.join(' AND ')}
           ORDER BY ts DESC
           LIMIT ${limit} OFFSET ${offset}
        `, params),
        pool.query(`
          SELECT COUNT(*)::int AS n
            FROM notifications
           WHERE user_id = $1 AND read_at IS NULL
        `, [userId])
      ])
      items = list.rows
      unreadCount = count.rows[0]?.n || 0
    } catch (err) {
      if (err.code !== '42P01') throw err
    }

    res.json({ items, unread: unreadCount, limit, offset })
  } catch (err) {
    console.error('Error fetching notifications:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

export async function markNotificationReadRoute(req, res) {
  try {
    const userId = req.user?.userId
    if (!userId) return res.status(401).json({ error: 'unauthorized' })
    const { notificationId } = req.params
    const { rowCount } = await pool.query(
      'UPDATE notifications SET read_at = NOW() WHERE notification_id = $1 AND user_id = $2 AND read_at IS NULL',
      [notificationId, userId]
    )
    res.json({ ok: true, marked: rowCount })
  } catch (err) {
    console.error('Error marking notification read:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

export async function markAllNotificationsReadRoute(req, res) {
  try {
    const userId = req.user?.userId
    if (!userId) return res.status(401).json({ error: 'unauthorized' })
    const { rowCount } = await pool.query(
      'UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
      [userId]
    )
    res.json({ ok: true, marked: rowCount })
  } catch (err) {
    console.error('Error marking all notifications read:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
