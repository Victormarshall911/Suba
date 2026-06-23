import * as db from '../db/index.js';
import { TransactionStateMachine, States } from './state-machine.js';
import { WalletService } from './wallet-service.js';
import { sendToUser } from './websocket-service.js';

export class ReconciliationService {
  /**
   * Generates summary statistics and lists for the Admin Reconciliation Dashboard.
   */
  static async getDashboardMetrics(filters = {}) {
    const { startDate, endDate, userId } = filters;
    let queryParams = [];
    let dateFilterSql = '';
    let userFilterSql = '';

    // Apply date range filters if present
    if (startDate && endDate) {
      queryParams.push(new Date(startDate), new Date(endDate));
      dateFilterSql = `AND created_at BETWEEN $1 AND $2`;
    }

    // Apply user ID filter if present
    if (userId) {
      queryParams.push(userId);
      const paramIndex = queryParams.length;
      userFilterSql = `AND user_id = $${paramIndex}`;
    }

    // 1. Fetch pending, failed, and review transactions count
    const pendingRes = await db.query(
      `SELECT COUNT(*) FROM transactions WHERE status IN ('INITIATED', 'PENDING_PAYMENT', 'VALIDATING') ${userFilterSql} ${dateFilterSql}`,
      queryParams
    );
    const failedRes = await db.query(
      `SELECT COUNT(*) FROM transactions WHERE status = 'FAILED' ${userFilterSql} ${dateFilterSql}`,
      queryParams
    );
    const manualReviewRes = await db.query(
      `SELECT t.*, u.full_name, u.email 
       FROM transactions t 
       JOIN users u ON t.user_id = u.id 
       WHERE t.status = 'MANUAL_REVIEW' ${userId ? `AND t.user_id = $1` : ''} 
       ORDER BY t.created_at DESC`,
      userId ? [userId] : []
    );

    // 2. Mismatched webhook entries (logged failures or mismatch errors)
    const mismatchedWebhooksRes = await db.query(
      `SELECT * FROM webhook_logs 
       WHERE status = 'FAILED' OR error_message IS NOT NULL 
       ORDER BY created_at DESC LIMIT 50`
    );

    // 3. Daily funding summary (today's successful virtual account payments)
    const dailyFundingRes = await db.query(
      `SELECT COALESCE(SUM(amount), 0.00) as total, COUNT(*) as count 
       FROM transactions 
       WHERE type = 'FUNDING' AND status = 'SUCCESSFUL' AND created_at >= CURRENT_DATE`
    );

    // 4. Double-entry ledger imbalance detection
    // In strict double entry, sum(debit) - sum(credit) for each transaction must equal 0, 
    // and overall sum(debit) must equal sum(credit).
    const imbalanceRes = await db.query(
      `SELECT type, COALESCE(SUM(amount), 0.00) as total 
       FROM ledger_entries 
       GROUP BY type`
    );

    let debits = 0;
    let credits = 0;
    imbalanceRes.rows.forEach(row => {
      if (row.type === 'DEBIT') debits = parseFloat(row.total);
      if (row.type === 'CREDIT') credits = parseFloat(row.total);
    });

    const imbalanceAmount = Math.abs(debits - credits);
    const isImbalanced = imbalanceAmount > 0.001; // handling floating point comparison

    // 5. Query active fraud flags
    const activeFraudFlagsRes = await db.query(
      `SELECT f.*, u.full_name, u.email 
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
        totalDebits: debits,
        totalCredits: credits,
        imbalance: imbalanceAmount,
        isImbalanced
      },
      activeFraudFlags: activeFraudFlagsRes.rows
    };
  }

  /**
   * Retrieves full transaction audit trace (lifecycle status logs) for tracing.
   */
  static async getTransactionTrace(transactionId) {
    const txnRes = await db.query(
      `SELECT t.*, u.full_name, u.email, w.is_frozen 
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       JOIN wallets w ON t.wallet_id = w.id
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

    const ledgerRes = await db.query(
      `SELECT * FROM ledger_entries 
       WHERE transaction_id = $1 
       ORDER BY created_at ASC`,
      [transactionId]
    );

    return {
      transaction: txnRes.rows[0],
      statusHistory: historyRes.rows,
      ledgerEntries: ledgerRes.rows
    };
  }

  /**
   * Resolves a transaction stuck in MANUAL_REVIEW (Admin override).
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

      const walletRes = await client.query('SELECT id, is_frozen FROM wallets WHERE id = $1', [txn.wallet_id]);
      const wallet = walletRes.rows[0];

      // Insert record into admin overrides
      await client.query(
        `INSERT INTO admin_overrides (admin_id, target_wallet_id, amount, type, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminId, txn.wallet_id, txn.amount, approve ? 'CREDIT' : 'DEBIT', reason]
      );

      if (approve) {
        // Unfreeze the wallet if it was frozen
        if (wallet && wallet.is_frozen) {
          await WalletService.setWalletFreezeStatus(wallet.id, false, client);
        }

        // Post Settlement Ledger Entries: Debit system_bank_asset, Credit user_wallet
        await WalletService.postLedgerTransaction(
          txn.id,
          'system_bank_asset',
          'user_wallet',
          txn.wallet_id,
          txn.amount,
          client
        );

        // Transition: MANUAL_REVIEW -> SUCCESSFUL
        await TransactionStateMachine.transitionTo(
          txn.id,
          States.SUCCESSFUL,
          adminId,
          `Admin Approved Override: ${reason}`,
          client
        );

        // Notify user via WebSocket
        sendToUser(txn.user_id, {
          type: 'notification',
          title: 'Transaction Approved',
          message: `Your pending funding of ₦${txn.amount} was approved by administrator override.`,
          timestamp: new Date().toISOString()
        });

      } else {
        // Transition: MANUAL_REVIEW -> FAILED
        await TransactionStateMachine.transitionTo(
          txn.id,
          States.FAILED,
          adminId,
          `Admin Rejected Override: ${reason}`,
          client
        );

        // Notify user via WebSocket
        sendToUser(txn.user_id, {
          type: 'notification',
          title: 'Transaction Declined',
          message: `Your pending funding of ₦${txn.amount} was declined after administrative review.`,
          timestamp: new Date().toISOString()
        });
      }

      // Mark user fraud flags as RESOLVED
      await client.query(
        "UPDATE fraud_flags SET status = 'RESOLVED' WHERE transaction_id = $1",
        [transactionId]
      );

      await client.query('COMMIT');
      console.log(`👮 [ADMIN OVERRIDE] Transaction ${transactionId} resolved by admin ${adminId}. Approve: ${approve}`);
      return { success: true, newStatus: approve ? States.SUCCESSFUL : States.FAILED };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
