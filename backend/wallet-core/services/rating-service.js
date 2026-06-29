/**
 * SUBA Rating Service
 * Handles all user rating & review logic including smart popup control,
 * spam prevention, analytics aggregation, and admin settings management.
 */

import * as db from '../db/index.js';

export class RatingService {

  /**
   * Get popup configuration from system_configs
   */
  static async getPopupSettings() {
    try {
      const res = await db.query(
        `SELECT key, value FROM system_configs
         WHERE key IN ('rating_popup_enabled', 'rating_popup_cooldown_days',
                       'rating_popup_min_transactions', 'rating_popup_remind_days')`
      );
      const cfg = {};
      res.rows.forEach(row => { cfg[row.key] = row.value; });
      return {
        enabled: cfg['rating_popup_enabled'] !== 'false',
        cooldownDays: parseInt(cfg['rating_popup_cooldown_days'] || '30'),
        minTransactions: parseInt(cfg['rating_popup_min_transactions'] || '3'),
        remindDays: parseInt(cfg['rating_popup_remind_days'] || '7')
      };
    } catch {
      return { enabled: true, cooldownDays: 30, minTransactions: 3, remindDays: 7 };
    }
  }

  /**
   * Save popup configuration to system_configs
   */
  static async savePopupSettings({ enabled, cooldownDays, minTransactions, remindDays }) {
    const upsert = async (key, value) => {
      await db.query(
        `INSERT INTO system_configs (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(value)]
      );
    };
    if (enabled !== undefined) await upsert('rating_popup_enabled', enabled);
    if (cooldownDays !== undefined) await upsert('rating_popup_cooldown_days', cooldownDays);
    if (minTransactions !== undefined) await upsert('rating_popup_min_transactions', minTransactions);
    if (remindDays !== undefined) await upsert('rating_popup_remind_days', remindDays);
    return { success: true };
  }

  /**
   * Get rating status for a user (used to decide whether to show popup)
   */
  static async getRatingStatus(userId) {
    const [ratingRes, popupRes, txnRes, settings] = await Promise.all([
      db.query('SELECT * FROM user_ratings WHERE user_id = $1', [userId]),
      db.query(
        `SELECT * FROM rating_popup_history WHERE user_id = $1 ORDER BY shown_at DESC LIMIT 5`,
        [userId]
      ),
      db.query(
        `SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND status = 'SUCCESSFUL'`,
        [userId]
      ).catch(() => ({ rows: [{ count: '0' }] })),
      RatingService.getPopupSettings()
    ]);

    const existingRating = ratingRes.rows[0] || null;
    const popupHistory = popupRes.rows;
    const txnCount = parseInt(txnRes.rows[0]?.count || '0');

    // Check if user permanently dismissed
    const neverShow = popupHistory.some(p => p.action === 'never_show');
    if (neverShow) {
      return { shouldShow: false, existingRating, reason: 'never_show', settings };
    }

    // Check if user rated within cooldown
    if (existingRating) {
      const daysSinceRating = (Date.now() - new Date(existingRating.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceRating < settings.cooldownDays) {
        return { shouldShow: false, existingRating, reason: 'cooldown', settings };
      }
    }

    // Check remind-later cooldown
    const lastRemind = popupHistory.find(p => p.action === 'remind_later');
    if (lastRemind) {
      const daysSinceRemind = (Date.now() - new Date(lastRemind.shown_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceRemind < settings.remindDays) {
        return { shouldShow: false, existingRating, reason: 'remind_snooze', settings };
      }
    }

    // Check popup-enabled setting
    if (!settings.enabled) {
      return { shouldShow: false, existingRating, reason: 'disabled', settings };
    }

    // Check minimum transactions requirement
    if (txnCount < settings.minTransactions) {
      return { shouldShow: false, existingRating, reason: 'min_transactions', txnCount, settings };
    }

    return { shouldShow: true, existingRating, txnCount, settings };
  }

  /**
   * Log that the rating popup was shown to a user
   */
  static async logPopupShown(userId, triggerEvent = 'manual') {
    const result = await db.query(
      `INSERT INTO rating_popup_history (user_id, trigger_event)
       VALUES ($1, $2) RETURNING *`,
      [userId, triggerEvent]
    );
    return result.rows[0];
  }

  /**
   * Record a user's action on the popup (rate_now / remind_later / never_show)
   */
  static async logPopupAction(userId, action) {
    const validActions = ['rate_now', 'remind_later', 'never_show'];
    if (!validActions.includes(action)) throw new Error('Invalid action value.');

    await db.query(
      `UPDATE rating_popup_history
       SET action = $1
       WHERE user_id = $2
         AND id = (SELECT id FROM rating_popup_history WHERE user_id = $2 ORDER BY shown_at DESC LIMIT 1)`,
      [action, userId]
    );
    return { success: true };
  }

  /**
   * Submit or update a user's rating (one per user per cooldown period)
   */
  static async submitRating(userId, { rating, title, comment, improvementFeedback, deviceType, appVersion }) {
    // Validate rating range
    const ratingInt = parseInt(rating);
    if (!ratingInt || ratingInt < 1 || ratingInt > 5) {
      throw new Error('Rating must be an integer between 1 and 5.');
    }

    // Check cooldown
    const status = await RatingService.getRatingStatus(userId);
    if (status.existingRating) {
      const daysSince = (Date.now() - new Date(status.existingRating.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < status.settings.cooldownDays) {
        // Allow update (upsert) — update the existing row
      }
    }

    // Upsert the rating
    const result = await db.query(
      `INSERT INTO user_ratings
         (user_id, rating, title, comment, improvement_feedback, device_type, app_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE
         SET rating = EXCLUDED.rating,
             title = EXCLUDED.title,
             comment = EXCLUDED.comment,
             improvement_feedback = EXCLUDED.improvement_feedback,
             device_type = EXCLUDED.device_type,
             app_version = EXCLUDED.app_version,
             updated_at = NOW()
       RETURNING *`,
      [userId, ratingInt, title || null, comment || null, improvementFeedback || null, deviceType || null, appVersion || null]
    );

    // Refresh analytics cache
    await RatingService.refreshAnalyticsCache();

    return result.rows[0];
  }

  /**
   * Recompute and persist analytics cache from live user_ratings data
   */
  static async refreshAnalyticsCache() {
    try {
      const res = await db.query(
        `SELECT
           COALESCE(AVG(rating), 0)::NUMERIC(4,2) AS avg_rating,
           COUNT(*) AS total_ratings,
           COUNT(CASE WHEN rating = 1 THEN 1 END) AS star_1,
           COUNT(CASE WHEN rating = 2 THEN 1 END) AS star_2,
           COUNT(CASE WHEN rating = 3 THEN 1 END) AS star_3,
           COUNT(CASE WHEN rating = 4 THEN 1 END) AS star_4,
           COUNT(CASE WHEN rating = 5 THEN 1 END) AS star_5
         FROM user_ratings`
      );
      const row = res.rows[0];
      await db.query(
        `INSERT INTO rating_analytics_cache
           (id, avg_rating, total_ratings, star_1, star_2, star_3, star_4, star_5, last_updated)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (id) DO UPDATE
           SET avg_rating = EXCLUDED.avg_rating,
               total_ratings = EXCLUDED.total_ratings,
               star_1 = EXCLUDED.star_1,
               star_2 = EXCLUDED.star_2,
               star_3 = EXCLUDED.star_3,
               star_4 = EXCLUDED.star_4,
               star_5 = EXCLUDED.star_5,
               last_updated = NOW()`,
        [
          parseFloat(row.avg_rating) || 0,
          parseInt(row.total_ratings) || 0,
          parseInt(row.star_1) || 0,
          parseInt(row.star_2) || 0,
          parseInt(row.star_3) || 0,
          parseInt(row.star_4) || 0,
          parseInt(row.star_5) || 0
        ]
      );
    } catch (err) {
      console.warn('⚠️ [RATING SERVICE] Analytics cache refresh failed:', err.message);
    }
  }

  /**
   * Get aggregated analytics for admin dashboard
   */
  static async getAnalytics() {
    // Get cache
    const cacheRes = await db.query('SELECT * FROM rating_analytics_cache WHERE id = 1');
    const cache = cacheRes.rows[0] || {
      avg_rating: 0, total_ratings: 0,
      star_1: 0, star_2: 0, star_3: 0, star_4: 0, star_5: 0
    };

    // Get monthly trend (last 6 months)
    let monthlyTrend = [];
    try {
      const trendRes = await db.query(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', updated_at), 'Mon YYYY') AS month,
           ROUND(AVG(rating)::NUMERIC, 2) AS avg_rating,
           COUNT(*) AS total_ratings
         FROM user_ratings
         WHERE updated_at >= NOW() - INTERVAL '6 months'
         GROUP BY DATE_TRUNC('month', updated_at)
         ORDER BY DATE_TRUNC('month', updated_at) ASC`
      );
      monthlyTrend = trendRes.rows;
    } catch {
      monthlyTrend = [];
    }

    return {
      avgRating: parseFloat(cache.avg_rating) || 0,
      totalRatings: parseInt(cache.total_ratings) || 0,
      distribution: {
        star5: parseInt(cache.star_5) || 0,
        star4: parseInt(cache.star_4) || 0,
        star3: parseInt(cache.star_3) || 0,
        star2: parseInt(cache.star_2) || 0,
        star1: parseInt(cache.star_1) || 0
      },
      monthlyTrend,
      positiveCount: (parseInt(cache.star_4) || 0) + (parseInt(cache.star_5) || 0),
      negativeCount: (parseInt(cache.star_1) || 0) + (parseInt(cache.star_2) || 0) + (parseInt(cache.star_3) || 0)
    };
  }

  /**
   * Get paginated ratings list for admin, with optional filters
   */
  static async getAllRatings({ rating, startDate, endDate, search, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    let pIdx = 1;

    if (rating) {
      conditions.push(`ur.rating = $${pIdx++}`);
      params.push(parseInt(rating));
    }
    if (startDate) {
      conditions.push(`ur.updated_at >= $${pIdx++}`);
      params.push(new Date(startDate));
    }
    if (endDate) {
      conditions.push(`ur.updated_at <= $${pIdx++}`);
      params.push(new Date(endDate));
    }
    if (search) {
      conditions.push(`(u.full_name ILIKE $${pIdx} OR u.email ILIKE $${pIdx})`);
      params.push(`%${search}%`);
      pIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const res = await db.query(
      `SELECT ur.*, u.full_name, u.email
       FROM user_ratings ur
       JOIN users u ON ur.user_id = u.id
       ${whereClause}
       ORDER BY ur.updated_at DESC
       LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
      params
    );

    return res.rows;
  }
}
