import * as db from '../db/index.js';

export class RewardService {
  /**
   * Fetch a user's points stats (current, total earned, total redeemed)
   */
  static async getPointsByUser(userId, client = null) {
    const dbClient = client || db;
    const res = await dbClient.query('SELECT * FROM sb_points WHERE user_id = $1', [userId]);
    if (res.rowCount === 0) {
      // Seed default record if not present
      const defaultPoints = {
        user_id: userId,
        current_points: 0,
        total_earned: 0,
        total_redeemed: 0
      };
      await dbClient.query(
        `INSERT INTO sb_points (user_id, current_points, total_earned, total_redeemed)
         VALUES ($1, 0, 0, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
      return defaultPoints;
    }
    return res.rows[0];
  }

  /**
   * Award SB Points based on successful transaction spent value
   */
  static async awardPointsForTransaction(userId, transactionId, amount, client = null) {
    const dbClient = client || (await db.getClient());
    try {
      if (!client) await dbClient.query('BEGIN');

      // Fetch earning rate from system configs
      const rateRes = await dbClient.query(
        "SELECT value FROM system_configs WHERE key = 'points_earning_rate'"
      );
      const earningRate = rateRes.rowCount > 0 ? parseFloat(rateRes.rows[0].value) : 100.00;

      const pointsToAward = Math.floor(amount / earningRate);
      if (pointsToAward > 0) {
        // Ensure points record exists
        await dbClient.query(
          `INSERT INTO sb_points (user_id, current_points, total_earned, total_redeemed)
           VALUES ($1, 0, 0, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId]
        );

        // Credit current and total earned points
        await dbClient.query(
          `UPDATE sb_points 
           SET current_points = current_points + $1,
               total_earned = total_earned + $1,
               updated_at = NOW()
           WHERE user_id = $2`,
          [pointsToAward, userId]
        );

        // Append to immutable point history log
        await dbClient.query(
          `INSERT INTO point_history (user_id, transaction_id, points_earned, points_redeemed, reason)
           VALUES ($1, $2, $3, 0, $4)`,
          [userId, transactionId, pointsToAward, `Points earned from purchase transaction ${transactionId}`]
        );

        console.log(`🎁 [LOYALTY] Awarded ${pointsToAward} SB Points to user ${userId} for transaction ${transactionId}`);
      }

      if (!client) await dbClient.query('COMMIT');
    } catch (err) {
      if (!client) await dbClient.query('ROLLBACK');
      console.error('❌ [LOYALTY ERROR] Failed to award points:', err);
      throw err;
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Reverse/deduct points previously earned from a transaction (e.g. if reversed or cancelled)
   */
  static async reversePointsForTransaction(userId, transactionId, client = null) {
    const dbClient = client || (await db.getClient());
    try {
      if (!client) await dbClient.query('BEGIN');

      // Find if points were earned for this transaction
      const historyRes = await dbClient.query(
        'SELECT points_earned FROM point_history WHERE transaction_id = $1 AND points_earned > 0',
        [transactionId]
      );
      
      if (historyRes.rowCount > 0) {
        const pointsToReverse = historyRes.rows[0].points_earned;

        // Deduct points
        await dbClient.query(
          `UPDATE sb_points 
           SET current_points = GREATEST(0, current_points - $1),
               total_redeemed = total_redeemed + $1,
               updated_at = NOW()
           WHERE user_id = $2`,
          [pointsToReverse, userId]
        );

        // Record reversal log
        await dbClient.query(
          `INSERT INTO point_history (user_id, transaction_id, points_earned, points_redeemed, reason)
           VALUES ($1, $2, 0, $3, $4)`,
          [userId, transactionId, pointsToReverse, `Points reversed due to transaction cancellation/refund`]
        );

        console.log(`↩️ [LOYALTY] Reversed ${pointsToReverse} SB Points from user ${userId} for transaction ${transactionId}`);
      }

      if (!client) await dbClient.query('COMMIT');
    } catch (err) {
      if (!client) await dbClient.query('ROLLBACK');
      console.error('❌ [LOYALTY ERROR] Failed to reverse points:', err);
      throw err;
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Deduct user points on discount redemption
   */
  static async redeemPoints(userId, points, reason = 'Redemption discount', client = null) {
    const dbClient = client || (await db.getClient());
    try {
      if (!client) await dbClient.query('BEGIN');

      // Lock row to prevent race conditions
      const statsRes = await dbClient.query(
        'SELECT current_points FROM sb_points WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      
      const currentPoints = statsRes.rowCount > 0 ? statsRes.rows[0].current_points : 0;
      if (currentPoints < points) {
        throw new Error("Insufficient SB Points for redemption.");
      }

      // Fetch redemption rate from configs
      const rateRes = await dbClient.query(
        "SELECT value FROM system_configs WHERE key = 'points_redemption_rate'"
      );
      const redemptionRate = rateRes.rowCount > 0 ? parseFloat(rateRes.rows[0].value) : 0.05;
      const discountCash = points * redemptionRate;
      console.log(`    🛠️ [REDEEM DEBUG] Points: ${points}, Rate: ${redemptionRate}, DiscountCash: ${discountCash}, User: ${userId}`);

      // Deduct points
      await dbClient.query(
        `UPDATE sb_points 
         SET current_points = current_points - $1,
             total_redeemed = total_redeemed + $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [points, userId]
      );

      // Credit user's wallet with discount cash
      await dbClient.query(
        'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
        [discountCash, userId]
      );

      // Append point log
      await dbClient.query(
        `INSERT INTO point_history (user_id, transaction_id, points_earned, points_redeemed, reason)
         VALUES ($1, NULL, 0, $2, $3)`,
        [userId, points, reason]
      );

      if (!client) await dbClient.query('COMMIT');
      return { success: true, pointsRedeemed: points, discountCash };
    } catch (err) {
      if (!client) await dbClient.query('ROLLBACK');
      console.error('❌ [LOYALTY ERROR] Failed to redeem points:', err);
      throw err;
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Manually award points by admin override
   */
  static async manualAwardPoints(email, points, reason, client = null) {
    const dbClient = client || (await db.getClient());
    try {
      if (!client) await dbClient.query('BEGIN');

      const userRes = await dbClient.query('SELECT id FROM users WHERE email = $1', [email]);
      if (userRes.rowCount === 0) {
        throw new Error("User email not found.");
      }
      const userId = userRes.rows[0].id;

      await dbClient.query(
        `INSERT INTO sb_points (user_id, current_points, total_earned, total_redeemed)
         VALUES ($1, 0, 0, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );

      await dbClient.query(
        `UPDATE sb_points 
         SET current_points = current_points + $1,
             total_earned = total_earned + $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [points, userId]
      );

      await dbClient.query(
        `INSERT INTO point_history (user_id, transaction_id, points_earned, points_redeemed, reason)
         VALUES ($1, NULL, $2, 0, $3)`,
        [userId, points, `Admin Award: ${reason}`]
      );

      if (!client) await dbClient.query('COMMIT');
      return { success: true, userId, points };
    } catch (err) {
      if (!client) await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Manually deduct points by admin override
   */
  static async manualDeductPoints(email, points, reason, client = null) {
    const dbClient = client || (await db.getClient());
    try {
      if (!client) await dbClient.query('BEGIN');

      const userRes = await dbClient.query('SELECT id FROM users WHERE email = $1', [email]);
      if (userRes.rowCount === 0) {
        throw new Error("User email not found.");
      }
      const userId = userRes.rows[0].id;

      const statsRes = await dbClient.query('SELECT current_points FROM sb_points WHERE user_id = $1', [userId]);
      const currentPoints = statsRes.rowCount > 0 ? statsRes.rows[0].current_points : 0;
      if (currentPoints < points) {
        throw new Error("Cannot deduct more points than user currently possesses.");
      }

      await dbClient.query(
        `UPDATE sb_points 
         SET current_points = current_points - $1,
             total_redeemed = total_redeemed + $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [points, userId]
      );

      await dbClient.query(
        `INSERT INTO point_history (user_id, transaction_id, points_earned, points_redeemed, reason)
         VALUES ($1, NULL, 0, $2, $3)`,
        [userId, points, `Admin Deduction: ${reason}`]
      );

      if (!client) await dbClient.query('COMMIT');
      return { success: true, userId, points };
    } catch (err) {
      if (!client) await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Fetch point history for admin log view
   */
  static async getPointHistory(client = null) {
    const dbClient = client || db;
    const res = await dbClient.query(
      `SELECT ph.*, u.email, u.full_name
       FROM point_history ph
       JOIN users u ON ph.user_id = u.id
       ORDER BY ph.created_at DESC`
    );
    return res.rows;
  }

  /**
   * Fetch point history for a specific user
   */
  static async getUserPointHistory(userId, client = null) {
    const dbClient = client || db;
    const res = await dbClient.query(
      `SELECT ph.*, t.external_reference AS reference
       FROM point_history ph
       LEFT JOIN transactions t ON ph.transaction_id = t.id
       WHERE ph.user_id = $1
       ORDER BY ph.created_at DESC`,
      [userId]
    );
    return res.rows;
  }

  /**
   * Fetch Point System analytics
   */
  static async getAnalytics(client = null) {
    const dbClient = client || db;
    
    const sumRes = await dbClient.query(
      `SELECT 
         COALESCE(SUM(current_points), 0) as active_points,
         COALESCE(SUM(total_earned), 0) as total_earned,
         COALESCE(SUM(total_redeemed), 0) as total_redeemed,
         COUNT(DISTINCT user_id) as point_holders
       FROM sb_points`
    );
    
    return sumRes.rows[0];
  }
}
