import crypto from 'crypto';
import * as db from '../db/index.js';
import { TransactionStateMachine, States } from '../services/state-machine.js';
import { AssetService } from '../services/asset-service.js';
import { FraudService } from '../services/fraud-service.js';
import { GrowthService } from '../services/growth-service.js';
import { WalletService } from '../services/wallet-service.js';
import { sendToUser, broadcastToAdmins } from '../services/websocket-service.js';
import { RewardService } from '../services/reward-service.js';

export async function handlePaystackWebhook(req, res) {
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.rawBody;

  const secret = process.env.PAYSTACK_WEBHOOK_SECRET || 'whsec_paystackwebhooksecrethere';
  const expectedSignature = crypto
    .createHmac('sha512', secret)
    .update(rawBody || '')
    .digest('hex');

  // Verify HMAC-SHA512 Webhook signature (MANDATORY security requirement)
  if (!signature || signature !== expectedSignature) {
    console.error("❌ [WEBHOOK] HMAC Signature verification failed.");
    try {
      await db.query(
        `INSERT INTO webhook_logs (event_type, provider, error_message, signature)
         VALUES ($1, $2, $3, $4)`,
        ['charge.success', 'paystack', 'HMAC Signature verification failed', signature || '']
      );
    } catch (dbErr) {
      console.error("Failed to write to webhook_logs", dbErr.message);
    }
    return res.status(401).json({ status: 'error', message: 'Invalid webhook signature.' });
  }

  const payload = req.body;
  const event = payload.event;

  // We only process charge.success (bank transfer) events
  if (event !== 'charge.success') {
    return res.status(200).json({ status: 'ignored', message: `Event '${event}' not processed.` });
  }

  const data = payload.data;
  const reference = data.reference;
  const amountKobo = data.amount;
  const amountNaira = parseFloat(amountKobo) / 100;
  const customerEmail = data.customer?.email?.toLowerCase()?.trim();
  const channel = data.channel;

  // Strict check: Only accept Bank Transfer payments
  if (channel !== 'bank_transfer' && channel !== 'dedicated_nuban' && data.authorization?.channel !== 'bank_transfer') {
    console.warn(`⚠️ [WEBHOOK] Ignored non-bank-transfer transaction: ${channel}`);
    return res.status(200).json({ status: 'ignored', message: 'Only bank transfers are accepted.' });
  }

  console.log(`📥 [WEBHOOK] Verified Paystack bank transfer. Reference: ${reference}, Amount: ₦${amountNaira}`);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Replay attack verification
    const isReplay = await FraudService.isSignatureReplayed(signature);
    if (isReplay) {
      console.error(`🚨 [WEBHOOK REPLAY] Webhook replay attempt detected for signature: ${signature}`);
      
      const userRes = await client.query('SELECT id FROM users WHERE email = $1', [customerEmail]);
      const user = userRes.rows[0];
      if (user) {
        await FraudService.triggerFraudActions(user.id, null, 'WEBHOOK_REPLAY_ATTEMPT', { reference, signature }, client);
      }
      
      await client.query('COMMIT');
      return res.status(200).json({ status: 'flagged', message: 'Replay attempt flagged.' });
    }

    // 2. Idempotency Check
    const existingTxnRes = await client.query(
      "SELECT * FROM transactions WHERE external_reference = $1",
      [reference]
    );
    const existingTxn = existingTxnRes.rows[0];
    
    if (existingTxn && existingTxn.status === States.SUCCESSFUL) {
      console.log(`ℹ️ [WEBHOOK] Transaction already fulfilled. Ref: ${reference}`);
      await client.query('COMMIT');
      return res.status(200).json({ status: 'ok', message: 'Already processed.' });
    }

    // 3. User lookup
    const userRes = await client.query('SELECT id, full_name, is_active FROM users WHERE email = $1', [customerEmail]);
    const user = userRes.rows[0];
    if (!user) {
      throw new Error(`User with email ${customerEmail} not found.`);
    }
    if (!user.is_active) {
      throw new Error(`User account is suspended.`);
    }

    // 4. Resolve or create transaction record
    let txn = existingTxn;
    if (!txn) {
      // Direct payment to virtual account (wallet funding deposit)
      const insertResult = await client.query(
        `INSERT INTO transactions (user_id, type, provider, amount, status, external_reference)
         VALUES ($1, 'DEPOSIT', 'paystack', $2, 'INITIATED', $3) RETURNING *`,
        [user.id, amountNaira, reference]
      );
      txn = insertResult.rows[0];
      txn = await TransactionStateMachine.transitionTo(txn.id, States.PENDING_PAYMENT, null, 'Direct transfer detected', client);
    }

    // 5. Create Payment Event record (Regulatory Signature verified)
    await client.query(
      `INSERT INTO payment_events (transaction_id, gateway_response, webhook_payload, signature_verified)
       VALUES ($1, $2, $3, true)`,
      [txn.id, JSON.stringify(data), JSON.stringify(payload)]
    );

    // Transition: PENDING_PAYMENT -> PAYMENT_RECEIVED -> VALIDATING
    txn = await TransactionStateMachine.transitionTo(txn.id, States.PAYMENT_RECEIVED, null, 'Payment confirmed by gateway', client);
    txn = await TransactionStateMachine.transitionTo(txn.id, States.VALIDATING, null, 'Processing delivery dispatch', client);

    // 6. Fraud system checks
    const isFraud = await FraudService.evaluateTransaction(
      user.id, 
      txn.id, 
      amountNaira, 
      { reference, signature, isReplay: false }, 
      client
    );

    if (isFraud) {
      console.warn(`🚨 [WEBHOOK] Transaction flagged as fraud. Blocking fulfillment. Ref: ${reference}`);
      await client.query('COMMIT');
      
      broadcastToAdmins({
        type: 'admin_notification',
        category: 'fraud_alert',
        title: 'Fraud Alert Raised',
        message: `Fraud check triggered on deposit of ₦${amountNaira} by user ${user.full_name}. User suspended.`,
        timestamp: new Date().toISOString()
      });

      return res.status(200).json({ status: 'flagged', message: 'Transaction flagged as fraud.' });
    }

    // Find user's wallet
    const walletRes = await client.query('SELECT id FROM wallets WHERE user_id = $1', [user.id]);
    const wallet = walletRes.rows[0];
    if (!wallet) {
      throw new Error(`Wallet not found for user ID: ${user.id}`);
    }

    // 7. Handle transaction based on type (DEPOSIT vs Purchase)
    if (txn.type === 'DEPOSIT') {
      // Credit user's wallet using double-entry bookkeeping ledger (DEBIT system_bank_asset, CREDIT user_wallet)
      await WalletService.postLedgerTransaction(txn.id, 'system_bank_asset', 'user_wallet', wallet.id, amountNaira, client);

      // Transition to SUCCESSFUL
      txn = await TransactionStateMachine.transitionTo(txn.id, States.SUCCESSFUL, null, 'Wallet credited successfully', client);

      await client.query('COMMIT');

      // Real-time WebSocket Alert to update client balance grid
      sendToUser(user.id, {
        type: 'notification',
        title: 'Deposit Successful! 💰',
        message: `Your deposit of ₦${amountNaira} was reconciled. Your wallet has been credited.`,
        timestamp: new Date().toISOString()
      });

      return res.status(200).json({ status: 'ok', message: 'Reconciled successfully.' });
    } else {
      // It's a purchase (AIRTIME / DATA) - Route through wallet
      // 7a. Credit user's wallet (DEBIT system_bank_asset, CREDIT user_wallet)
      await WalletService.postLedgerTransaction(txn.id, 'system_bank_asset', 'user_wallet', wallet.id, amountNaira, client);

      // 7b. Debit user's wallet for purchase (DEBIT user_wallet, CREDIT system_revenue)
      await WalletService.postLedgerTransaction(txn.id, 'user_wallet', 'system_revenue', wallet.id, amountNaira, client);

      // 7c. Call Fulfillment Engine (VTpass)
      const providerSuccess = await callVTUProvider(txn.type, amountNaira);

      // Log fulfillment attempt
      await client.query(
        `INSERT INTO fulfillment_logs (transaction_id, provider_response, success)
         VALUES ($1, $2, $3)`,
        [txn.id, JSON.stringify({ status: providerSuccess ? 'delivered' : 'failed' }), providerSuccess]
      );

      if (providerSuccess) {
        // Create Asset in inventory
        await AssetService.createAsset(
          user.id,
          txn.type === 'DATA' ? 'DATA' : 'AIRTIME',
          amountNaira,
          client
        );

        // Transition to SUCCESSFUL
        txn = await TransactionStateMachine.transitionTo(txn.id, States.SUCCESSFUL, null, 'Fulfillment delivered & Asset allocated', client);

        // Calculate Ambassador Commission (if referred)
        await GrowthService.calculateCommission(user.id, txn.id, amountNaira, client);
        
        // Award SB Points (only on successful completed purchases)
        await RewardService.awardPointsForTransaction(user.id, txn.id, amountNaira, client);
        
        // Settle commission status
        await GrowthService.settleCommissions(txn.id, true, client);

        await client.query('COMMIT');

        // Real-time WebSocket Alert to update client balance grid
        sendToUser(user.id, {
          type: 'notification',
          title: 'Fulfillment Successful! 📦',
          message: `Your payment of ₦${amountNaira} was reconciled. A new ${txn.type} asset is now available in your inventory.`,
          timestamp: new Date().toISOString()
        });

        return res.status(200).json({ status: 'ok', message: 'Reconciled successfully.' });
      } else {
        // Fail and trigger refund: reverse purchase debit (DEBIT system_revenue, CREDIT user_wallet)
        await WalletService.postLedgerTransaction(txn.id, 'system_revenue', 'user_wallet', wallet.id, amountNaira, client);

        // Transition to FAILED and REVERSED
        txn = await TransactionStateMachine.transitionTo(txn.id, States.FAILED, null, 'Fulfillment engine call failed', client);
        txn = await TransactionStateMachine.transitionTo(txn.id, States.REVERSED, null, 'Simulated payment gateway reversal completed', client);

        // Reverse points in case they were logged
        await RewardService.reversePointsForTransaction(user.id, txn.id, client);

        await GrowthService.settleCommissions(txn.id, false, client);

        await client.query('COMMIT');

        sendToUser(user.id, {
          type: 'notification',
          title: 'Fulfillment Failed ❌',
          message: `Your payment of ₦${amountNaira} could not be fulfilled. The funds have been refunded to your wallet.`,
          timestamp: new Date().toISOString()
        });

        return res.status(200).json({ status: 'failed', message: 'Fulfillment failed. Payment reversed.' });
      }
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ [WEBHOOK] Processing error: ${err.message}`);
    try {
      await db.query(
        `INSERT INTO webhook_logs (event_type, provider, error_message, signature)
         VALUES ($1, $2, $3, $4)`,
        ['charge.success', 'paystack', `Processing error: ${err.message}`, signature || '']
      );
    } catch (dbErr) {
      console.error("Failed to write to webhook_logs on error", dbErr.message);
    }
    return res.status(500).json({ status: 'error', message: 'Webhook database processing failed.' });
  } finally {
    client.release();
  }
}

// Simulated provider gateway call
async function callVTUProvider(type, amount) {
  // Simulate network dispatch latency
  await new Promise(resolve => setTimeout(resolve, 500));
  return true;
}
