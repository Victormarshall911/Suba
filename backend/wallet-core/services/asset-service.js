import * as db from '../db/index.js';
import { sendToUser } from './websocket-service.js';

export class AssetService {
  /**
   * Allocate a service asset (Airtime, Data, Voucher) to a user's inventory.
   */
  static async createAsset(userId, assetType, valueDenomination, client = null) {
    const dbClient = client || (await db.getClient());
    try {
      // Data bundles expire after 30 days
      const expiresAt = assetType === 'DATA' 
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) 
        : null;

      const result = await dbClient.query(
        `INSERT INTO assets (user_id, asset_type, value_denomination, status, transferable, expires_at)
         VALUES ($1, $2, $3, 'AVAILABLE', true, $4) RETURNING *`,
        [userId, assetType, valueDenomination, expiresAt]
      );
      
      console.log(`[ASSET SERVICE] Created asset: User ${userId}, Type: ${assetType}, Value: ${valueDenomination}`);
      return result.rows[0];
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Transfer an asset internally to another registered user.
   */
  static async transferAsset(userId, assetId, recipientIdentifier) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // 1. Lock and retrieve asset
      const assetRes = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [assetId]);
      const asset = assetRes.rows[0];
      
      if (!asset) {
        throw new Error("Asset not found.");
      }
      if (asset.user_id !== userId) {
        throw new Error("Unauthorized: You do not own this asset.");
      }
      if (asset.status !== 'AVAILABLE') {
        throw new Error(`Asset is not available for transfer (Status: ${asset.status})`);
      }
      if (!asset.transferable) {
        throw new Error("This asset type is locked and cannot be transferred.");
      }

      // 2. Resolve recipient
      const recRes = await client.query(
        'SELECT id, full_name, email FROM users WHERE email = $1 OR phone_number = $2',
        [recipientIdentifier.toLowerCase().trim(), recipientIdentifier.trim()]
      );
      const recipient = recRes.rows[0];
      if (!recipient) {
        throw new Error("Recipient not found. They must register a Suba account first.");
      }
      if (recipient.id === userId) {
        throw new Error("Invalid transfer: Cannot transfer assets to yourself.");
      }

      // 3. Update asset owner
      await client.query('UPDATE assets SET user_id = $1 WHERE id = $2', [recipient.id, assetId]);

      await client.query('COMMIT');
      
      console.log(`[ASSET SERVICE] Transferred Asset ${assetId} from User ${userId} to ${recipient.email}`);

      // Notify recipient via WebSocket
      sendToUser(recipient.id, {
        type: 'notification',
        title: 'Asset Received! 🎁',
        message: `You received a ${asset.value_denomination} ${asset.asset_type} asset from ${asset.user_id.substring(0, 5)}.`,
        timestamp: new Date().toISOString()
      });

      return { success: true, recipient: recipient.full_name };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Redeems (Fulfils) an asset to a physical telephone number.
   * This calls the external VTpass gateway simulator and updates the status to USED.
   */
  static async redeemAsset(userId, assetId, targetPhone) {
    if (!targetPhone) {
      throw new Error("Validation failed: Target phone number is required for asset redemption.");
    }

    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      const assetRes = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [assetId]);
      const asset = assetRes.rows[0];
      
      if (!asset) {
        throw new Error("Asset not found.");
      }
      if (asset.user_id !== userId) {
        throw new Error("Unauthorized: You do not own this asset.");
      }
      if (asset.status !== 'AVAILABLE') {
        throw new Error(`Asset cannot be redeemed (Status: ${asset.status})`);
      }

      // Check expiration
      if (asset.expires_at && new Date(asset.expires_at) < new Date()) {
        await client.query("UPDATE assets SET status = 'EXPIRED' WHERE id = $1", [assetId]);
        await client.query('COMMIT');
        throw new Error("Asset redemption failed: The asset has expired.");
      }

      // 1. Create a transaction for audit trail representing this redemption
      const reference = `REF-RED-${Math.random().toString(36).substring(2, 12).toUpperCase()}`;
      const narration = `Redeemed ${asset.value_denomination} ${asset.asset_type} to ${targetPhone}`;
      
      const txnResult = await client.query(
        `INSERT INTO transactions (user_id, type, provider, amount, status, external_reference)
         VALUES ($1, $2, 'vtpass', $3, 'VALIDATING', $4) RETURNING *`,
        [userId, asset.asset_type === 'AIRTIME' ? 'AIRTIME' : 'DATA', asset.value_denomination, reference]
      );
      const txn = txnResult.rows[0];

      // 2. Call simulated VTU delivery
      // Let's simulate a standard network call
      await new Promise(resolve => setTimeout(resolve, 600));
      
      // Update asset status to USED
      await client.query("UPDATE assets SET status = 'USED' WHERE id = $1", [assetId]);

      // Insert fulfillment log
      await client.query(
        `INSERT INTO fulfillment_logs (transaction_id, provider_response, success)
         VALUES ($1, $2, true)`,
        [txn.id, JSON.stringify({ status: 'delivered', code: '200', reference })]
      );

      // Transition transaction to SUCCESSFUL
      await client.query(
        `UPDATE transactions SET status = 'SUCCESSFUL', updated_at = NOW() WHERE id = $1`,
        [txn.id]
      );

      await client.query(
        'INSERT INTO transaction_status_history (transaction_id, from_status, to_status, remarks) VALUES ($1, $2, $3, $4)',
        [txn.id, 'VALIDATING', 'SUCCESSFUL', narration]
      );

      await client.query('COMMIT');
      
      console.log(`[ASSET SERVICE] Redeemed Asset ${assetId} successfully to ${targetPhone}.`);

      sendToUser(userId, {
        type: 'notification',
        title: 'Asset Redeemed! 🚀',
        message: `${asset.asset_type} value of ${asset.value_denomination} delivered successfully to ${targetPhone}.`,
        timestamp: new Date().toISOString()
      });

      return { success: true, txnReference: reference };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieve available inventory.
   */
  static async getInventory(userId) {
    const result = await db.query(
      "SELECT * FROM assets WHERE user_id = $1 AND status = 'AVAILABLE' ORDER BY created_at DESC",
      [userId]
    );
    return result.rows;
  }
}
