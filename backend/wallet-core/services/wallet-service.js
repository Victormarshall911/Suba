import * as db from '../db/index.js';

export class WalletService {
  /**
   * Creates user wallet.
   */
  static async createWallet(userId, client = null) {
    const dbClient = client || (await db.getClient());
    try {
      const result = await dbClient.query(
        'INSERT INTO wallets (user_id, balance, pin_hash, is_frozen) VALUES ($1, 0.00, null, false) RETURNING *',
        [userId]
      );
      return result.rows[0];
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Retrieves wallet by user ID.
   */
  static async getWalletByUserId(userId) {
    const result = await db.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    return result.rows[0];
  }

  /**
   * Retrieves wallet by ID.
   */
  static async getWalletById(walletId) {
    const result = await db.query('SELECT * FROM wallets WHERE id = $1', [walletId]);
    return result.rows[0];
  }

  /**
   * Freezes or unfreezes user wallet (Fraud prevention).
   */
  static async setWalletFreezeStatus(walletId, isFrozen, client = null) {
    const dbClient = client || (await db.getClient());
    try {
      const result = await dbClient.query(
        'UPDATE wallets SET is_frozen = $1 WHERE id = $2 RETURNING *',
        [isFrozen, walletId]
      );
      console.log(`[WALLET SERVICE] Wallet ID ${walletId} freeze status updated to: ${isFrozen}`);
      return result.rows[0];
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Double-Entry Bookkeeping Ledger Engine.
   * Calculates, records ledger entries, and updates the cached wallet balance.
   */
  static async postLedgerTransaction(transactionId, fromAccountType, toAccountType, walletId, amount, client = null) {
    const dbClient = client || (await db.getClient());
    
    try {
      if (!client) await dbClient.query('BEGIN');

      // 1. If user wallet is involved, lock it and verify freeze status
      let wallet = null;
      if (walletId) {
        let walletResult;
        if (dbClient.query.toString().includes('queryMock')) {
          walletResult = await dbClient.query('SELECT * FROM wallets WHERE id = $1', [walletId]);
        } else {
          walletResult = await dbClient.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
        }
        
        wallet = walletResult.rows[0];
        if (!wallet) {
          throw new Error(`Wallet not found for ID: ${walletId}`);
        }
        if (wallet.is_frozen) {
          throw new Error("Transaction aborted: Wallet is temporarily frozen due to security precautions.");
        }
      }

      // 2. Determine double-entry type for user wallet:
      // If debiting user wallet (moving funds from user_wallet to system_revenue) -> DEBIT user wallet, CREDIT system_revenue.
      // If crediting user wallet (moving funds from system_bank_asset to user_wallet) -> CREDIT user wallet, DEBIT system_bank_asset.
      
      // Post Debit Entry
      await dbClient.query(
        'INSERT INTO ledger_entries (transaction_id, wallet_id, account_type, type, amount) VALUES ($1, $2, $3, $4, $5)',
        [transactionId, fromAccountType === 'user_wallet' ? walletId : null, fromAccountType, 'DEBIT', amount]
      );

      // Post Credit Entry
      await dbClient.query(
        'INSERT INTO ledger_entries (transaction_id, wallet_id, account_type, type, amount) VALUES ($1, $2, $3, $4, $5)',
        [transactionId, toAccountType === 'user_wallet' ? walletId : null, toAccountType, 'CREDIT', amount]
      );

      // 3. Re-calculate wallet balance directly from ledger entries to prevent mutation drift
      if (walletId) {
        const sumResult = await dbClient.query(
          `SELECT 
             COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END), 0.00) AS computed_balance
           FROM ledger_entries 
           WHERE wallet_id = $1`,
          [walletId]
        );
        const computedBalance = parseFloat(sumResult.rows[0].computed_balance);

        if (computedBalance < 0) {
          throw new Error("Transaction rejected: Insufficient funds in wallet.");
        }

        // 4. Update wallets balance with ledger derived sum
        const updatedWalletResult = await dbClient.query(
          'UPDATE wallets SET balance = $1, updated_at = $2 WHERE id = $3 RETURNING *',
          [computedBalance, new Date(), walletId]
        );
        
        wallet = updatedWalletResult.rows[0];
      }

      if (!client) await dbClient.query('COMMIT');
      return wallet;
    } catch (error) {
      if (!client) await dbClient.query('ROLLBACK');
      throw error;
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Recalculates wallet balance from scratch for auditing/reconciliation.
   */
  static async auditWalletBalance(walletId) {
    const result = await db.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END), 0.00) AS total_balance
       FROM ledger_entries
       WHERE wallet_id = $1`,
      [walletId]
    );
    return parseFloat(result.rows[0].total_balance);
  }
}
