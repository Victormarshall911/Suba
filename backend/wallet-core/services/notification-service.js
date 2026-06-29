import * as db from '../db/index.js';

export class NotificationService {
  /**
   * Create an in-app notification and dispatch it in real-time
   */
  static async createNotification(userId, title, message, category = 'announcement') {
    const res = await db.query(
      `INSERT INTO in_app_notifications (user_id, title, message, category, is_read)
       VALUES ($1, $2, $3, $4, false) RETURNING *`,
      [userId, title, message, category]
    );

    const notification = res.rows[0];

    // Push real-time WS notification
    if (global.sendWebSocketNotification) {
      global.sendWebSocketNotification(userId, {
        type: 'notification',
        id: notification.id,
        title: title,
        message: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
        timestamp: new Date().toISOString()
      });
    }

    return notification;
  }

  /**
   * Fetch all notifications for a specific user
   */
  static async getUserNotifications(userId) {
    const res = await db.query(
      `SELECT * FROM in_app_notifications 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );
    return res.rows;
  }

  /**
   * Mark all notifications as read for a specific user
   */
  static async markAllAsRead(userId) {
    await db.query(
      `UPDATE in_app_notifications 
       SET is_read = true 
       WHERE user_id = $1`,
      [userId]
    );
    return { success: true };
  }

  /**
   * Delete a notification
   */
  static async deleteNotification(userId, notificationId) {
    const res = await db.query(
      `DELETE FROM in_app_notifications 
       WHERE id = $1 AND user_id = $2`,
      [notificationId, userId]
    );
    return { success: res.rowCount > 0 };
  }

  /**
   * Fetch count of unread notifications
   */
  static async getUnreadCount(userId) {
    const res = await db.query(
      `SELECT COUNT(*) FROM in_app_notifications 
       WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
    return parseInt(res.rows[0]?.count || 0);
  }
}
