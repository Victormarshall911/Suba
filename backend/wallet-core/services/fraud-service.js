import * as db from '../db/index.js';
import { WalletService } from './wallet-service.js';
import { TransactionStateMachine, States } from './state-machine.js';

export class FraudService {
  /**
   * Evaluates rules against a user transaction to check for anomalies.
   * If an anomaly is found, it automatically flags the transaction,
   * freezes the wallet, logs a fraud entry, and shifts the transaction status to FLAGGED_FRAUD.
   */
  static async evaluateTransaction(userId, transactionId, amount, details = {}, client = null) {
    const dbClient = client || (await db.getClient());
    
    try {
      if (!client) await dbClient.query('BEGIN');

      const now = new Date();

      // Rule 1: Sudden high-value deposits from new accounts
      // Check if user is younger than 24 hours and amount > 50,000
      const userResult = await dbClient.query('SELECT created_at FROM users WHERE id = $1', [userId]);
      const user = userResult.rows[0];
      if (user) {
        const ageHours = (now - new Date(user.created_at)) / (1000 * 60 * 60);
        if (ageHours < 24 && amount > 50000) {
          await this.triggerFraudActions(
            userId, 
            transactionId, 
            'NEW_USER_HIGH_VALUE_DEPOSIT', 
            { amount, accountAgeHours: ageHours }, 
            dbClient
          );
          if (!client) await dbClient.query('COMMIT');
          return true;
        }
      }

      // Rule 2: Multiple failed funding attempts (> 3 in 10 mins)
      const failedResult = await dbClient.query(
        `SELECT COUNT(*) FROM transactions 
         WHERE user_id = $1 AND status = 'FAILED' AND created_at >= $2`,
        [userId, new Date(Date.now() - 10 * 60 * 1000)]
      );
      const failedCount = parseInt(failedResult.rows[0].count);
      if (failedCount > 3) {
        await this.triggerFraudActions(
          userId, 
          transactionId, 
          'EXCESSIVE_FAILED_ATTEMPTS', 
          { failedCount10Mins: failedCount }, 
          dbClient
        );
        if (!client) await dbClient.query('COMMIT');
        return true;
      }

      // Rule 3: Repeated small test transfers (< 100 Naira, > 3 in 10 mins)
      const smallResult = await dbClient.query(
        `SELECT COUNT(*) FROM transactions 
         WHERE user_id = $1 AND amount < 100.00 AND created_at >= $2`,
        [userId, new Date(Date.now() - 10 * 60 * 1000)]
      );
      const smallCount = parseInt(smallResult.rows[0].count);
      if (amount < 100.00 && smallCount > 3) {
        await this.triggerFraudActions(
          userId, 
          transactionId, 
          'REPEATED_SMALL_TEST_TRANSFERS', 
          { smallCount10Mins: smallCount, currentAmount: amount }, 
          dbClient
        );
        if (!client) await dbClient.query('COMMIT');
        return true;
      }

      // Rule 4: Mismatch between expected and received amount
      if (details.expectedAmount && parseFloat(details.expectedAmount) !== parseFloat(amount)) {
        await this.triggerFraudActions(
          userId, 
          transactionId, 
          'DEPOSIT_AMOUNT_MISMATCH', 
          { expected: details.expectedAmount, received: amount }, 
          dbClient
        );
        if (!client) await dbClient.query('COMMIT');
        return true;
      }

      // Rule 5: Repeated webhook replay attempts (checked separately in Webhook Controller)
      if (details.isReplay) {
        await this.triggerFraudActions(
          userId, 
          transactionId, 
          'WEBHOOK_REPLAY_ATTEMPT', 
          { reference: details.reference, signature: details.signature }, 
          dbClient
        );
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
   */
  static async triggerFraudActions(userId, transactionId, ruleTriggered, details, client) {
    console.warn(`🚨 [FRAUD TRIGGERED] User ${userId} triggered rule ${ruleTriggered}. executing security actions...`);

    // 1. Create fraud flag entry in the database
    await client.query(
      'INSERT INTO fraud_flags (user_id, transaction_id, rule_triggered, details, status) VALUES ($1, $2, $3, $4, $5)',
      [userId, transactionId, ruleTriggered, JSON.stringify(details), 'ACTIVE']
    );

    // 2. Fetch user's wallet
    const walletResult = await client.query('SELECT id FROM wallets WHERE user_id = $1', [userId]);
    const wallet = walletResult.rows[0];
    if (wallet) {
      // Freeze the wallet immediately
      await WalletService.setWalletFreezeStatus(wallet.id, true, client);
    }

    // 3. Move transaction to FLAGGED_FRAUD and then PUSH to MANUAL_REVIEW
    if (transactionId) {
      await TransactionStateMachine.transitionTo(
        transactionId, 
        States.FLAGGED_FRAUD, 
        null, 
        `System Auto-Flagged: ${ruleTriggered}`, 
        client
      );
      await TransactionStateMachine.transitionTo(
        transactionId, 
        States.MANUAL_REVIEW, 
        null, 
        'Moved to queue for administrator review', 
        client
      );
    }
  }

  /**
   * Check if a webhook signature was already processed (Replay protection).
   */
  static async isSignatureReplayed(signature) {
    if (!signature) return false;
    const result = await db.query(
      "SELECT id FROM webhook_logs WHERE signature = $1 AND status = 'PROCESSED' LIMIT 1",
      [signature]
    );
    return result.rowCount > 0;
  }
}
