import * as db from '../db/index.js';
import { TransactionStateMachine, States } from './state-machine.js';
import { WalletService } from './wallet-service.js';
import { sendToUser } from './websocket-service.js';

export class TransactionService {
  /**
   * Initiates a funding request.
   */
  static async initiateFunding(userId, amount) {
    if (!amount || amount < 100) {
      throw new Error("Validation failed: Minimum funding amount is ₦100.");
    }

    const wallet = await WalletService.getWalletByUserId(userId);
    if (!wallet) {
      throw new Error("Wallet not found.");
    }

    const reference = `REF-FUND-${Math.random().toString(36).substring(2, 12).toUpperCase()}`;
    const narration = `Wallet funding via Bank Transfer — ₦${amount}`;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO transactions (user_id, wallet_id, type, amount, status, reference, narration)
         VALUES ($1, $2, 'FUNDING', $3, 'INITIATED', $4, $5) RETURNING *`,
        [userId, wallet.id, amount, reference, narration]
      );
      const txn = insertResult.rows[0];

      // Transition INITIATED -> PENDING_PAYMENT
      await TransactionStateMachine.transitionTo(
        txn.id, 
        States.PENDING_PAYMENT, 
        null, 
        'Waiting for bank transfer webhook', 
        client
      );

      await client.query('COMMIT');
      
      console.log(`[TRANSACTION SERVICE] Initiated funding: User ${userId}, Ref: ${reference}`);
      return { ...txn, status: States.PENDING_PAYMENT };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Purchase a mobile VTU service (Airtime or Data) using wallet balance.
   */
  static async purchaseVTU(userId, { type, amount, recipient_phone, network, plan_code, narration }) {
    if (!amount || amount <= 0) {
      throw new Error("Validation failed: Transaction amount must be positive.");
    }
    if (!recipient_phone) {
      throw new Error("Validation failed: Recipient phone number is required.");
    }

    const wallet = await WalletService.getWalletByUserId(userId);
    if (!wallet) {
      throw new Error("Wallet not found.");
    }
    if (wallet.is_frozen) {
      throw new Error("Transaction aborted: Wallet is temporarily frozen.");
    }
    if (parseFloat(wallet.balance) < parseFloat(amount)) {
      throw new Error("Transaction rejected: Insufficient wallet balance.");
    }

    const reference = `REF-VTU-${Math.random().toString(36).substring(2, 12).toUpperCase()}`;
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 1. Create Transaction INITIATED
      const insertResult = await client.query(
        `INSERT INTO transactions (user_id, wallet_id, type, amount, status, reference, recipient_phone, network, plan_code, narration)
         VALUES ($1, $2, $3, $4, 'INITIATED', $5, $6, $7, $8, $9) RETURNING *`,
        [userId, wallet.id, type, amount, reference, recipient_phone, network, plan_code, narration]
      );
      let txn = insertResult.rows[0];

      // 2. Transition: INITIATED -> PENDING_PAYMENT -> PAYMENT_RECEIVED -> VALIDATING
      txn = await TransactionStateMachine.transitionTo(txn.id, States.PENDING_PAYMENT, null, 'Processing payment from balance', client);
      txn = await TransactionStateMachine.transitionTo(txn.id, States.PAYMENT_RECEIVED, null, 'Funds deducted from wallet balance', client);
      txn = await TransactionStateMachine.transitionTo(txn.id, States.VALIDATING, null, 'Executing VTU order dispatch', client);

      // 3. Post Ledger Entry: Debit User Wallet, Credit System Revenue
      await WalletService.postLedgerTransaction(
        txn.id,
        'user_wallet',
        'system_revenue',
        wallet.id,
        amount,
        client
      );

      // 4. Simulate integration with external VTU provider (e.g. VTpass)
      const providerSuccess = await this.callExternalVTUProvider(type, amount, recipient_phone, network, plan_code);

      if (providerSuccess) {
        // Success: transition VALIDATING -> SUCCESSFUL
        txn = await TransactionStateMachine.transitionTo(txn.id, States.SUCCESSFUL, null, 'Fulfillment delivered successfully', client);
        await client.query('COMMIT');
        
        // Notify user via WebSocket
        sendToUser(userId, {
          type: 'notification',
          title: 'Order Successful',
          message: `${narration} delivered to ${recipient_phone}.`,
          timestamp: new Date().toISOString()
        });

        return txn;
      } else {
        // Failure: transition VALIDATING -> FAILED, issue automatic refund
        txn = await TransactionStateMachine.transitionTo(txn.id, States.FAILED, null, 'VTU Provider rejected delivery', client);
        
        // Refund: Reverse Ledger entries (Debit system_revenue, Credit user_wallet)
        await WalletService.postLedgerTransaction(
          txn.id,
          'system_revenue',
          'user_wallet',
          wallet.id,
          amount,
          client
        );

        // Transition: FAILED -> REVERSED status
        txn = await TransactionStateMachine.transitionTo(txn.id, States.REVERSED, null, 'Auto-refund: funds credited back to wallet', client);

        await client.query('COMMIT');

        // Notify user of failure & refund via WebSocket
        sendToUser(userId, {
          type: 'notification',
          title: 'Order Failed & Refunded',
          message: `${type} purchase failed. ₦${amount} refunded to wallet.`,
          timestamp: new Date().toISOString()
        });

        return txn;
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Helper to simulate VTU delivery API (100% executable mock fallback/real simulator).
   */
  static async callExternalVTUProvider(type, amount, phone, network, plan) {
    // If testing fail scenarios, we can mock it
    if (phone === '07000000000') {
      return false; // Simulate failure
    }
    // Simulate latency
    await new Promise(resolve => setTimeout(resolve, 800));
    return true;
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
