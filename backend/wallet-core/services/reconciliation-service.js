import * as db from '../db/index.js';
import { TransactionStateMachine, States } from './state-machine.js';
import { WalletService } from './wallet-service.js';
import { sendToUser } from './websocket-service.js';
import { RewardService } from './reward-service.js';

export class ReconciliationService {
  /**
   * Generates summary statistics for the Admin Reconciliation panel.
   * Pulls metrics on transactions, anomalies, assets, and mismatches.
   */
  static async getDashboardMetrics(filters = {}) {
    const { startDate, endDate, userId } = filters;
    let queryParams = [];
    let dateFilterSql = '';
    let userFilterSql = '';

    if (startDate && endDate) {
      queryParams.push(new Date(startDate), new Date(endDate));
      dateFilterSql = `AND created_at BETWEEN $1 AND $2`;
    }

    if (userId) {
      queryParams.push(userId);
      const paramIndex = queryParams.length;
      userFilterSql = `AND user_id = $${paramIndex}`;
    }

    // 1. Fetch pending, failed, and review transactions count
    const pendingRes = await db.query(
      `SELECT COUNT(*) FROM transactions WHERE status IN ('INITIATED', 'PENDING_PAYMENT', 'VALIDATING', 'PAYMENT_RECEIVED') ${userFilterSql} ${dateFilterSql}`,
      queryParams
    );
    const failedRes = await db.query(
      `SELECT COUNT(*) FROM transactions WHERE status = 'FAILED' ${userFilterSql} ${dateFilterSql}`,
      queryParams
    );
    const manualReviewRes = await db.query(
      `SELECT t.*, t.external_reference AS reference, u.full_name, u.email 
       FROM transactions t 
       JOIN users u ON t.user_id = u.id 
       WHERE t.status = 'MANUAL_REVIEW' ${userId ? `AND t.user_id = $1` : ''} 
       ORDER BY t.created_at DESC`,
      userId ? [userId] : []
    );

    // 2. Mismatched webhook entries
    const mismatchedWebhooksRes = await db.query(
      `SELECT * FROM webhook_logs 
       WHERE status = 'FAILED' OR error_message IS NOT NULL 
       ORDER BY created_at DESC LIMIT 50`
    );

    // 3. Daily successful deposits (paid bank transfers)
    const dailyFundingRes = await db.query(
      `SELECT COALESCE(SUM(amount), 0.00) as total, COUNT(*) as count 
       FROM transactions 
       WHERE (type = 'DEPOSIT' OR type = 'AIRTIME') AND status = 'SUCCESSFUL' AND created_at >= CURRENT_DATE`
    );

    // 4. Double-entry ledger imbalance check
    const balanceRes = await db.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN type = 'DEBIT' THEN amount ELSE 0 END), 0.00) AS total_debits,
         COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE 0 END), 0.00) AS total_credits
       FROM ledger_entries`
    );

    const totalDebits = parseFloat(balanceRes.rows[0].total_debits);
    const totalCredits = parseFloat(balanceRes.rows[0].total_credits);
    const imbalanceAmount = Math.abs(totalDebits - totalCredits);
    const isImbalanced = imbalanceAmount > 0.01;

    // 5. Fraud flags
    const activeFraudFlagsRes = await db.query(
      `SELECT f.*, f.reason AS rule_triggered, u.full_name, u.email 
       FROM fraud_flags f
       JOIN users u ON f.user_id = u.id
       WHERE f.status = 'ACTIVE' ORDER BY f.created_at DESC`
    );

    return {
      pendingCount: parseInt(pendingRes.rows[0]?.count || 0),
      failedCount: parseInt(failedRes.rows[0]?.count || 0),
      manualReviewQueue: manualReviewRes.rows,
      mismatchedWebhooks: mismatchedWebhooksRes.rows,
      dailyFunding: {
        total: parseFloat(dailyFundingRes.rows[0]?.total || 0),
        count: parseInt(dailyFundingRes.rows[0]?.count || 0)
      },
      ledgerAudit: {
        totalDebits: totalDebits, // Sum of system debits
        totalCredits: totalCredits, // Sum of system credits
        imbalance: imbalanceAmount,
        isImbalanced
      },
      activeFraudFlags: activeFraudFlagsRes.rows
    };
  }

  /**
   * Retrieves full transaction status log trace.
   */
  static async getTransactionTrace(transactionId) {
    const txnRes = await db.query(
      `SELECT t.*, u.full_name, u.email 
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE t.id = $1`,
      [transactionId]
    );

    const historyRes = await db.query(
      `SELECT h.*, u.full_name as changed_by_name 
       FROM transaction_status_history h
       LEFT JOIN users u ON h.changed_by = u.id
       WHERE h.transaction_id = $1 
       ORDER BY h.created_at ASC`,
      [transactionId]
    );

    const logsRes = await db.query(
      `SELECT * FROM fulfillment_logs 
       WHERE transaction_id = $1 
       ORDER BY created_at ASC`,
      [transactionId]
    );

    return {
      transaction: txnRes.rows[0],
      statusHistory: historyRes.rows,
      fulfillmentLogs: logsRes.rows
    };
  }

  /**
   * Resolves a transaction in MANUAL_REVIEW queue (Admin Override).
   */
  static async resolveManualReview(transactionId, adminId, approve, reason) {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      const txnRes = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transactionId]);
      const txn = txnRes.rows[0];
      if (!txn) {
        throw new Error("Transaction not found.");
      }
      if (txn.status !== States.MANUAL_REVIEW) {
        throw new Error(`Transaction is not in MANUAL_REVIEW status (Current: ${txn.status})`);
      }

      // Log admin override action
      await client.query(
        `INSERT INTO admin_actions (action_type, target_id, performed_by)
         VALUES ($1, $2, $3)`,
        [`OVERRIDE_${approve ? 'APPROVE' : 'DECLINE'}`, transactionId, adminId]
      );

      if (approve) {
        // Reactivate user account upon override approval
        await client.query(
          'UPDATE users SET is_active = true WHERE id = $1',
          [txn.user_id]
        );

        // Transition: MANUAL_REVIEW -> VALIDATING
        await TransactionStateMachine.transitionTo(txn.id, States.VALIDATING, adminId, `Override: ${reason}`, client);

        // Find user's wallet
        const walletRes = await client.query('SELECT id FROM wallets WHERE user_id = $1', [txn.user_id]);
        const wallet = walletRes.rows[0];
        if (!wallet) {
          throw new Error("User wallet not found.");
        }

        // Post double-entry ledger credit (DEBIT system_bank_asset, CREDIT user_wallet)
        await WalletService.postLedgerTransaction(txn.id, 'system_bank_asset', 'user_wallet', wallet.id, txn.amount, client);

        if (txn.type === 'DEPOSIT') {
          // It's just a deposit, we are done
        } else {
          // It's a purchase (AIRTIME / DATA), perform debit and allocate asset
          await WalletService.postLedgerTransaction(txn.id, 'user_wallet', 'system_revenue', wallet.id, txn.amount, client);
          
          await client.query(
            `INSERT INTO assets (user_id, asset_type, value_denomination, status)
             VALUES ($1, $2, $3, 'AVAILABLE')`,
            [txn.user_id, txn.type === 'DATA' ? 'DATA' : 'AIRTIME', txn.amount]
          );
        }

        // Transition: VALIDATING -> SUCCESSFUL
        await TransactionStateMachine.transitionTo(txn.id, States.SUCCESSFUL, adminId, 'Fulfillment override processed', client);

        if (txn.type !== 'DEPOSIT') {
          // Award SB Points (only on successful completed purchases)
          await RewardService.awardPointsForTransaction(txn.user_id, txn.id, txn.amount, client);
        }

        // Notify user via WebSocket
        sendToUser(txn.user_id, {
          type: 'notification',
          title: 'Transaction Approved! 🚀',
          message: `Your pending deposit of ₦${txn.amount} has been approved by administrator override.`,
          timestamp: new Date().toISOString()
        });
      } else {
        // Settle transaction FAILED
        await TransactionStateMachine.transitionTo(txn.id, States.FAILED, adminId, `Decline Override: ${reason}`, client);

        // Reverse points in case they were logged
        await RewardService.reversePointsForTransaction(txn.user_id, txn.id, client);

        sendToUser(txn.user_id, {
          type: 'notification',
          title: 'Transaction Declined ❌',
          message: `Your pending deposit of ₦${txn.amount} has been declined after admin audit.`,
          timestamp: new Date().toISOString()
        });
      }

      // Mark fraud flags as RESOLVED
      await client.query(
        "UPDATE fraud_flags SET status = 'RESOLVED' WHERE transaction_id = $1",
        [transactionId]
      );

      await client.query('COMMIT');
      console.log(`👮 [ADMIN OVERRIDE] Settle manual review completed: ${transactionId}`);
      return { success: true, newStatus: approve ? States.SUCCESSFUL : States.FAILED };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ===========================================================================
  // ADMIN CAREER / JOBS BOARD MANAGEMENT
  // ===========================================================================

  static async createJob({ title, department, employment_type, location, description, responsibilities, requirements, deadline, status }) {
    const result = await db.query(
      `INSERT INTO jobs (title, department, employment_type, location, description, responsibilities, requirements, deadline, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [title, department, employment_type, location, description, responsibilities, requirements, new Date(deadline), status || 'DRAFT']
    );
    return result.rows[0];
  }

  static async updateJob(jobId, { title, department, employment_type, location, description, responsibilities, requirements, deadline, status }) {
    const result = await db.query(
      `UPDATE jobs 
       SET title = $1, department = $2, employment_type = $3, location = $4, description = $5, responsibilities = $6, requirements = $7, deadline = $8, status = $9
       WHERE id = $10 RETURNING *`,
      [title, department, employment_type, location, description, responsibilities, requirements, new Date(deadline), status, jobId]
    );
    return result.rows[0];
  }

  static async deleteJob(jobId) {
    await db.query('DELETE FROM jobs WHERE id = $1', [jobId]);
    return { success: true };
  }

  static async applyForJob({ jobId, userId, cvUrl, coverLetter }) {
    const result = await db.query(
      `INSERT INTO job_applications (job_id, user_id, cv_url, cover_letter, status)
       VALUES ($1, $2, $3, $4, 'RECEIVED') RETURNING *`,
      [jobId, userId, cvUrl, coverLetter]
    );
    return result.rows[0];
  }

  static async getOpenJobs() {
    const result = await db.query("SELECT * FROM jobs WHERE status = 'PUBLISHED' ORDER BY created_at DESC");
    return result.rows;
  }
}
