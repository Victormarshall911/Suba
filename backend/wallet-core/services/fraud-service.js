// Fraud detection module for transaction velocity and webhook replay attacks
import * as db from '../db/index.js';
import { TransactionStateMachine, States } from './state-machine.js';

export class FraudService {
  /**
   * Evaluates anomaly checks against transaction parameters.
   */
  static async evaluateTransaction(userId, transactionId, amount, details = {}, client = null) {
    const dbClient = client || (await db.getClient());
    
    try {
      if (!client) await dbClient.query('BEGIN');

      const now = new Date();

      // Rule 1: Multiple failed payments in short time window (>3 in 10 mins)
      const failedResult = await dbClient.query(
        `SELECT COUNT(*) FROM transactions 
         WHERE user_id = $1 AND status = 'FAILED' AND created_at >= $2`,
        [userId, new Date(Date.now() - 10 * 60 * 1000)]
      );
      const failedCount = parseInt(failedResult.rows[0].count);
      if (failedCount > 3) {
        await this.triggerFraudActions(userId, transactionId, 'EXCESSIVE_FAILED_PAYMENTS', { failedCount }, dbClient);
        if (!client) await dbClient.query('COMMIT');
        return true;
      }

      // Rule 2: Webhook replay attempts (duplicate reference signature)
      if (details.isReplay) {
        await this.triggerFraudActions(userId, transactionId, 'WEBHOOK_REPLAY_ATTEMPT', { signature: details.signature }, dbClient);
        if (!client) await dbClient.query('COMMIT');
        return true;
      }

      // Rule 3: Abnormal transaction velocity (>5 transactions in 5 minutes)
      const velocityResult = await dbClient.query(
        `SELECT COUNT(*) FROM transactions 
         WHERE user_id = $1 AND created_at >= $2`,
        [userId, new Date(Date.now() - 5 * 60 * 1000)]
      );
      const txCount = parseInt(velocityResult.rows[0].count);
      if (txCount > 5) {
        await this.triggerFraudActions(userId, transactionId, 'ABNORMAL_TRANSACTION_VELOCITY', { txCount5Mins: txCount }, dbClient);
        if (!client) await dbClient.query('COMMIT');
        return true;
      }

      // Rule 4: Mismatched payment vs product price
      if (details.expectedAmount && parseFloat(details.expectedAmount) !== parseFloat(amount)) {
        await this.triggerFraudActions(userId, transactionId, 'PAYMENT_AMOUNT_MISMATCH', { expected: details.expectedAmount, paid: amount }, dbClient);
        if (!client) await dbClient.query('COMMIT');
        return true;
      }

      // Rule 5: Suspicious IP/Device Patterns
      if (details.suspiciousPattern) {
        await this.triggerFraudActions(userId, transactionId, 'SUSPICIOUS_DEVICE_PATTERN', { pattern: details.suspiciousPattern }, dbClient);
        if (!client) await dbClient.query('COMMIT');
        return true;
      }

      if (!client) await dbClient.query('COMMIT');
      return false;
    } catch (error) {
      if (!client) await dbClient.query('ROLLBACK');
      throw error;
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Action trigger suite when fraud is detected.
   * Freezes user account, flags transaction, and pushes to manual review queue.
   */
  static async triggerFraudActions(userId, transactionId, reason, details, client) {
    console.warn(`🚨 [FRAUD DETECTED] Anomaly flagged for User ${userId}. Reason: ${reason}`);

    // 1. Insert fraud flag record
    await client.query(
      `INSERT INTO fraud_flags (user_id, transaction_id, reason, severity, status, details) 
       VALUES ($1, $2, $3, 'HIGH', 'ACTIVE', $4)`,
      [userId, transactionId, reason, JSON.stringify(details)]
    );

    // 2. Suspend user (freeze user temporarily)
    await client.query(
      'UPDATE users SET is_active = false WHERE id = $1',
      [userId]
    );

    // 3. Move transaction status to FLAGGED_FRAUD and MANUAL_REVIEW
    if (transactionId) {
      await TransactionStateMachine.transitionTo(transactionId, States.FLAGGED_FRAUD, null, `Flagged: ${reason}`, client);
      await TransactionStateMachine.transitionTo(transactionId, States.MANUAL_REVIEW, null, 'Sent to admin override review queue', client);
    }
  }

  /**
   * Check if signature was already logged (Replay prevention).
   */
  static async isSignatureReplayed(signature) {
    if (!signature) return false;
    const result = await db.query(
      "SELECT id FROM payment_events WHERE signature_verified = true AND webhook_payload->>'signature' = $1 LIMIT 1",
      [signature]
    );
    return result.rowCount > 0;
  }
}
