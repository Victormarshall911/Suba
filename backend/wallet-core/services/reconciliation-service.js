import * as db from '../db/index.js';
import { TransactionStateMachine, States } from './state-machine.js';
import { sendToUser } from './websocket-service.js';

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
      `SELECT COUNT(*) FROM transactions WHERE status IN ('INITIATED', 'PAYMENT_PENDING', 'PROCESSING', 'PAYMENT_CONFIRMED') ${userFilterSql} ${dateFilterSql}`,
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
       WHERE type = 'AIRTIME' AND status = 'FULFILLED' AND created_at >= CURRENT_DATE`
    );

    // 4. Double-entry ledger imbalance check (re-adapted to sum value of total assets allocated vs transactions paid)
    const assetSumRes = await db.query("SELECT COALESCE(SUM(value_denomination), 0.00) as total FROM assets");
    const txnSumRes = await db.query("SELECT COALESCE(SUM(amount), 0.00) as total FROM transactions WHERE status = 'FULFILLED'");

    const totalAssets = parseFloat(assetSumRes.rows[0].total);
    const totalPayments = parseFloat(txnSumRes.rows[0].total);
    const imbalanceAmount = Math.abs(totalAssets - totalPayments);
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
        totalDebits: totalPayments, // Representing total fiat payments
        totalCredits: totalAssets,   // Representing total digital assets delivered
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

        // Transition: MANUAL_REVIEW -> PROCESSING
        await TransactionStateMachine.transitionTo(txn.id, States.PROCESSING, adminId, `Override: ${reason}`, client);

        // Deliver asset
        await client.query(
          `INSERT INTO assets (user_id, asset_type, value_denomination, status)
           VALUES ($1, $2, $3, 'AVAILABLE')`,
          [txn.user_id, txn.type === 'DATA' ? 'DATA' : 'AIRTIME', txn.amount]
        );

        // Settle transaction FULFILLED
        await TransactionStateMachine.transitionTo(txn.id, States.FULFILLED, adminId, 'Fulfillment override processed', client);

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
      return { success: true, newStatus: approve ? States.FULFILLED : States.FAILED };
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

  static async createJob({ title, description, requirements, location, employment_type, deadline }) {
    const result = await db.query(
      `INSERT INTO jobs (title, description, requirements, location, employment_type, deadline, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN') RETURNING *`,
      [title, description, requirements, location, employment_type, new Date(deadline)]
    );
    return result.rows[0];
  }

  static async updateJob(jobId, { status }) {
    const result = await db.query(
      `UPDATE jobs SET status = $1 WHERE id = $2 RETURNING *`,
      [status, jobId]
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
    const result = await db.query("SELECT * FROM jobs WHERE status = 'OPEN' ORDER BY created_at DESC");
    return result.rows;
  }
}
