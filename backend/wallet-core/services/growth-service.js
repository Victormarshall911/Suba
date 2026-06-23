import * as db from '../db/index.js';
import { AssetService } from './asset-service.js';

export class GrowthService {
  /**
   * Submit an application to join the Ambassador Lifecycle program.
   */
  static async applyAmbassador(userId, { location, social_links, reason_for_joining, referral_code }) {
    if (!location || !social_links || !reason_for_joining) {
      throw new Error("Validation failed: All application details are required.");
    }

    // Check if user is active
    const userRes = await db.query('SELECT is_active FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user || !user.is_active) {
      throw new Error("Application rejected: Account is inactive or disabled.");
    }

    // Check if already an ambassador
    const existRes = await db.query('SELECT status FROM ambassadors WHERE user_id = $1', [userId]);
    if (existRes.rowCount > 0) {
      const status = existRes.rows[0].status;
      if (status === 'PENDING') throw new Error("Application pending: Your previous application is under review.");
      if (status === 'APPROVED') throw new Error("Registration error: You are already a Suba Ambassador.");
    }

    // Generate unique referral code (e.g. SUB-XXX)
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const generatedCode = `SUB-${randomSuffix}`;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO ambassadors (user_id, referral_code, status, level)
         VALUES ($1, $2, 'PENDING', 'BRONZE') RETURNING *`,
        [userId, generatedCode]
      );
      const amb = result.rows[0];

      // If they signed up via an ambassador, attribute the referral link
      if (referral_code) {
        const parentAmbResult = await client.query(
          'SELECT id FROM ambassadors WHERE referral_code = $1 AND status = \'APPROVED\'',
          [referral_code.toUpperCase().trim()]
        );
        const parentAmb = parentAmbResult.rows[0];
        if (parentAmb) {
          await client.query(
            `INSERT INTO referrals (ambassador_id, referred_user_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [parentAmb.id, userId]
          );
        }
      }

      await client.query('COMMIT');
      
      console.log(`[GROWTH SERVICE] Ambassador application submitted: User ${userId}, Code: ${generatedCode}`);
      return amb;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieve ambassador statistics and current tier information.
   */
  static async getProfile(userId) {
    const ambResult = await db.query(
      `SELECT a.*, u.full_name, u.email 
       FROM ambassadors a 
       JOIN users u ON a.user_id = u.id 
       WHERE a.user_id = $1`,
      [userId]
    );
    const amb = ambResult.rows[0];
    if (!amb) {
      return null;
    }

    // Query referrals count
    const refCountRes = await db.query(
      'SELECT COUNT(*) FROM referrals WHERE ambassador_id = $1',
      [amb.id]
    );
    
    // Query commissions details
    const commResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0.00) as total_earned,
              COALESCE(SUM(CASE WHEN status = 'PENDING' THEN amount ELSE 0 END), 0.00) as pending,
              COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount ELSE 0 END), 0.00) as paid
       FROM commissions WHERE ambassador_id = $1`,
      [amb.id]
    );

    return {
      ambassador_id: amb.id,
      referral_code: amb.referral_code,
      status: amb.status,
      level: amb.level,
      full_name: amb.full_name,
      email: amb.email,
      total_referrals: parseInt(refCountRes.rows[0].count),
      total_earned: parseFloat(commResult.rows[0].total_earned),
      pending_earnings: parseFloat(commResult.rows[0].pending),
      paid_earnings: parseFloat(commResult.rows[0].paid)
    };
  }

  /**
   * Tracks and assigns a commission transaction to an ambassador based on referred purchases.
   * Enforces loss-proof tiered parameters to protect margins.
   */
  static async calculateCommission(referredUserId, transactionId, transactionAmount, client = null) {
    const dbClient = client || (await db.getClient());
    
    try {
      if (!client) await dbClient.query('BEGIN');

      // Check if user was referred
      const refResult = await dbClient.query(
        'SELECT ambassador_id FROM referrals WHERE referred_user_id = $1 AND status = \'ACTIVE\'',
        [referredUserId]
      );
      const referral = refResult.rows[0];
      if (!referral) {
        if (!client) await dbClient.query('COMMIT');
        return null;
      }

      // Check duplicate commission
      const dupCheck = await dbClient.query(
        'SELECT id FROM commissions WHERE transaction_id = $1',
        [transactionId]
      );
      if (dupCheck.rowCount > 0) {
        if (!client) await dbClient.query('COMMIT');
        return null;
      }

      const ambassadorId = referral.ambassador_id;

      // Lock and fetch ambassador level
      const ambResult = await dbClient.query(
        'SELECT id, level FROM ambassadors WHERE id = $1 FOR UPDATE',
        [ambassadorId]
      );
      const ambassador = ambResult.rows[0];
      if (!ambassador || ambassador.status === 'REJECTED') {
        if (!client) await dbClient.query('COMMIT');
        return null;
      }

      // Tiered payouts preserving margin boundaries (Safe Commission Rules)
      // Bronze: 1.5% of value (Max ₦15 for ₦1,000)
      // Silver: 1.8% of value (Max ₦18 for ₦1,000)
      // Gold: 2.1% of value (Max ₦21 for ₦1,000)
      let percentage = 0.015;
      if (ambassador.level === 'SILVER') percentage = 0.018;
      if (ambassador.level === 'GOLD') percentage = 0.021;

      const commissionAmount = transactionAmount * percentage;

      // Insert commission pending
      const commResult = await dbClient.query(
        `INSERT INTO commissions (ambassador_id, transaction_id, amount, status)
         VALUES ($1, $2, $3, 'PENDING') RETURNING *`,
        [ambassadorId, transactionId, commissionAmount]
      );

      // Increment referral transaction count
      await dbClient.query(
        `UPDATE referrals SET transaction_count = transaction_count + 1 
         WHERE ambassador_id = $1 AND referred_user_id = $2`,
        [ambassadorId, referredUserId]
      );

      // Audit milestone unlocks
      await this.evaluateMilestoneReward(ambassadorId, dbClient);

      if (!client) await dbClient.query('COMMIT');
      console.log(`💸 [COMMISSION GENERATED] Ref: ${transactionId}. Payout ₦${commissionAmount} generated for Ambassador ${ambassadorId}`);
      return commResult.rows[0];
    } catch (err) {
      if (!client) await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Milestone tier unlocks (Bronze -> Silver -> Gold).
   */
  static async evaluateMilestoneReward(ambassadorId, client) {
    const refCountRes = await client.query(
      'SELECT COUNT(*) FROM referrals WHERE ambassador_id = $1',
      [ambassadorId]
    );
    const count = parseInt(refCountRes.rows[0].count);

    let newLevel = 'BRONZE';
    if (count >= 100) {
      newLevel = 'GOLD';
    } else if (count >= 20) {
      newLevel = 'SILVER';
    }

    // Update level if threshold unlocked
    await client.query(
      'UPDATE ambassadors SET level = $1 WHERE id = $2 AND level != $1',
      [newLevel, ambassadorId]
    );
  }

  /**
   * Finalize and settle pending commissions (e.g. upon payment gateway webhook confirmation).
   */
  static async settleCommissions(transactionId, approve = true, client = null) {
    const dbClient = client || (await db.getClient());
    try {
      const status = approve ? 'APPROVED' : 'REVERSED';
      await dbClient.query(
        'UPDATE commissions SET status = $1 WHERE transaction_id = $2',
        [status, transactionId]
      );
    } finally {
      if (!client) dbClient.release();
    }
  }
}
