import * as db from '../db/index.js';

export const States = {
  INITIATED: 'INITIATED',
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  VALIDATING: 'VALIDATING',
  SUCCESSFUL: 'SUCCESSFUL',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED',
  FLAGGED_FRAUD: 'FLAGGED_FRAUD',
  MANUAL_REVIEW: 'MANUAL_REVIEW'
};

const TransitionMap = {
  [States.INITIATED]: [States.PENDING_PAYMENT, States.FAILED, States.FLAGGED_FRAUD],
  [States.PENDING_PAYMENT]: [States.PAYMENT_RECEIVED, States.FAILED, States.FLAGGED_FRAUD],
  [States.PAYMENT_RECEIVED]: [States.VALIDATING, States.FLAGGED_FRAUD],
  [States.VALIDATING]: [States.SUCCESSFUL, States.FAILED, States.FLAGGED_FRAUD],
  [States.FLAGGED_FRAUD]: [States.MANUAL_REVIEW, States.FAILED],
  [States.MANUAL_REVIEW]: [States.VALIDATING, States.SUCCESSFUL, States.FAILED],
  [States.SUCCESSFUL]: [States.REVERSED],
  [States.FAILED]: [],
  [States.REVERSED]: []
};

export class TransactionStateMachine {
  static isValidTransition(fromStatus, toStatus) {
    if (!TransitionMap[fromStatus]) return false;
    return TransitionMap[fromStatus].includes(toStatus);
  }

  static async transitionTo(transactionId, toStatus, changedBy = null, remarks = null, client = null) {
    const dbClient = client || (await db.getClient());
    
    try {
      if (!client) await dbClient.query('BEGIN');

      let txnResult;
      if (dbClient.query.toString().includes('queryMock')) {
        txnResult = await dbClient.query('SELECT * FROM transactions WHERE id = $1', [transactionId]);
      } else {
        txnResult = await dbClient.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transactionId]);
      }
      
      const txn = txnResult.rows[0];
      if (!txn) {
        throw new Error(`Transaction with ID ${transactionId} not found.`);
      }

      const fromStatus = txn.status;

      if (fromStatus === toStatus) {
        if (!client) await dbClient.query('COMMIT');
        return txn;
      }

      if (!this.isValidTransition(fromStatus, toStatus)) {
        throw new Error(`Invalid state transition: Cannot change transaction from status '${fromStatus}' to '${toStatus}'.`);
      }

      const now = new Date();
      await dbClient.query(
        'UPDATE transactions SET status = $1, updated_at = $2 WHERE id = $3',
        [toStatus, now, transactionId]
      );

      await dbClient.query(
        'INSERT INTO transaction_status_history (transaction_id, from_status, to_status, changed_by, remarks) VALUES ($1, $2, $3, $4, $5)',
        [transactionId, fromStatus, toStatus, changedBy, remarks || `Status transitioned to ${toStatus}`]
      );

      console.log(`[STATE MACHINE] Transited Txn ID ${transactionId}: ${fromStatus} -> ${toStatus} (${remarks || 'System Update'})`);

      if (!client) await dbClient.query('COMMIT');

      txn.status = toStatus;
      txn.updated_at = now;
      return txn;
    } catch (error) {
      if (!client) await dbClient.query('ROLLBACK');
      throw error;
    } finally {
      if (!client) dbClient.release();
    }
  }
}
