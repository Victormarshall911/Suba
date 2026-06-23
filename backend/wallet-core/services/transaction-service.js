import * as db from '../db/index.js';
import { TransactionStateMachine, States } from './state-machine.js';
import { WalletService } from './wallet-service.js';
import { sendToUser } from './websocket-service.js';

export class TransactionService {
  /**
   * Initiates direct purchase of a service asset (e.g. Airtime, Data) using bank transfer.
   */
  static async initiateAssetPurchase(userId, { type, amount, provider }) {
    if (!amount || amount < 100) {
      throw new Error("Validation failed: Minimum transaction amount is ₦100.");
    }
    if (!type || !['AIRTIME', 'DATA', 'BILL_PAYMENT'].includes(type)) {
      throw new Error("Validation failed: Invalid transaction type.");
    }

    const reference = `REF-PURCHASE-${Math.random().toString(36).substring(2, 12).toUpperCase()}`;
    const narration = `Direct purchase of ${type} — ₦${amount}`;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO transactions (user_id, type, provider, amount, status, external_reference)
         VALUES ($1, $2, $3, $4, 'INITIATED', $5) RETURNING *`,
        [userId, type, provider || 'paystack', amount, reference]
      );
      let txn = insertResult.rows[0];

      // Transition INITIATED -> PAYMENT_PENDING
      txn = await TransactionStateMachine.transitionTo(
        txn.id, 
        States.PAYMENT_PENDING, 
        null, 
        'Awaiting gateway callback or webhook confirmation', 
        client
      );

      await client.query('COMMIT');
      
      console.log(`[TRANSACTION SERVICE] Initiated asset purchase: User ${userId}, Ref: ${reference}`);
      return { 
        id: txn.id,
        reference: reference, 
        amount: amount, 
        status: States.PAYMENT_PENDING,
        bankName: 'Sterling Bank',
        virtualAccountNumber: '9922' + Math.floor(100000 + Math.random() * 900000), // simulate NUBAN
        paymentFlow: 'bank_transfer'
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieve transactions for user.
   */
  static async getTransactionsByUserId(userId) {
    const result = await db.query(
      `SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Retrieve all transactions for admin.
   */
  static async getAllTransactions() {
    const result = await db.query(
      `SELECT t.*, u.full_name as user_name, u.email as user_email 
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       ORDER BY t.created_at DESC`
    );
    return result.rows;
  }
}
