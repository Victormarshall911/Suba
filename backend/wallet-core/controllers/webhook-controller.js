import crypto from 'crypto';
import * as db from '../db/index.js';
import { TransactionStateMachine, States } from '../services/state-machine.js';
import { WalletService } from '../services/wallet-service.js';
import { FraudService } from '../services/fraud-service.js';
import { sendToUser, broadcastToAdmins } from '../services/websocket-service.js';

export async function handlePaystackWebhook(req, res) {
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.rawBody; // Express middleware should populate rawBody for hmac checks

  const secret = process.env.PAYSTACK_WEBHOOK_SECRET || 'whsec_paystackwebhooksecrethere';
  const expectedSignature = crypto
    .createHmac('sha512', secret)
    .update(rawBody || '')
    .digest('hex');

  // Verify HMAC-SHA512 Webhook signature (MANDATORY security requirement)
  if (!signature || signature !== expectedSignature) {
    console.error("❌ [WEBHOOK] HMAC Signature verification failed.");
    
    // Log failed webhook in db
    await db.query(
      `INSERT INTO webhook_logs (provider, event_type, payload, signature, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['paystack', 'unknown', JSON.stringify(req.body || {}), signature || '', 'FAILED', 'Invalid signature']
    );

    return res.status(401).json({ status: 'error', message: 'Invalid webhook signature.' });
  }

  const payload = req.body;
  const event = payload.event;

  // We only process charge.success (bank transfer) events
  if (event !== 'charge.success') {
    await db.query(
      `INSERT INTO webhook_logs (provider, event_type, payload, signature, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['paystack', event, JSON.stringify(payload), signature, 'IGNORED', `Event '${event}' is ignored`]
    );
    return res.status(200).json({ status: 'ignored', message: `Event '${event}' not processed.` });
  }

  const data = payload.data;
  const reference = data.reference;
  const amountKobo = data.amount;
  const amountNaira = parseFloat(amountKobo) / 100;
  const customerEmail = data.customer?.email?.toLowerCase()?.trim();
  const channel = data.channel; // should be bank_transfer or dedicated_nuban

  // Strict check: Only accept Bank Transfer deposits
  if (channel !== 'bank_transfer' && channel !== 'dedicated_nuban' && data.authorization?.channel !== 'bank_transfer') {
    console.warn(`⚠️ [WEBHOOK] Ignored non-bank-transfer transaction: ${channel}`);
    await db.query(
      `INSERT INTO webhook_logs (provider, event_type, payload, signature, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['paystack', event, JSON.stringify(payload), signature, 'IGNORED', 'Non bank-transfer channel']
    );
    return res.status(200).json({ status: 'ignored', message: 'Only bank transfers are accepted.' });
  }

  console.log(`📥 [WEBHOOK] Processing Paystack bank transfer charge.success. Ref: ${reference}, Amount: ₦${amountNaira}`);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Replay attack verification (using webhook_logs + signature check)
    const isReplay = await FraudService.isSignatureReplayed(signature);
    if (isReplay) {
      console.error(`🚨 [WEBHOOK REPLAY] Webhook replay attempt detected for signature: ${signature}`);
      
      // Look up user by email
      const userRes = await client.query('SELECT id FROM users WHERE email = $1', [customerEmail]);
      const user = userRes.rows[0];
      if (user) {
        // Trigger fraud action for webhook replay
        await FraudService.triggerFraudActions(user.id, null, 'WEBHOOK_REPLAY_ATTEMPT', { reference, signature }, client);
      }
      
      await client.query('COMMIT');
      return res.status(200).json({ status: 'flagged', message: 'Replay attempt flagged.' });
    }

    // 2. IDEMPOTENCY CHECK - Ignore if transaction is already SUCCESSFUL
    const existingTxnRes = await client.query(
      "SELECT id, status FROM transactions WHERE reference = $1",
      [reference]
    );
    const existingTxn = existingTxnRes.rows[0];
    
    if (existingTxn && existingTxn.status === States.SUCCESSFUL) {
      console.log(`ℹ️ [WEBHOOK] Transaction already processed successfully. Ref: ${reference}`);
      await client.query('COMMIT');
      return res.status(200).json({ status: 'ok', message: 'Already processed.' });
    }

    // 3. User lookup by email
    const userRes = await client.query('SELECT id, full_name FROM users WHERE email = $1', [customerEmail]);
    const user = userRes.rows[0];
    if (!user) {
      throw new Error(`User with email ${customerEmail} not found.`);
    }

    const walletRes = await client.query('SELECT id FROM wallets WHERE user_id = $1', [user.id]);
    const wallet = walletRes.rows[0];
    if (!wallet) {
      throw new Error(`Wallet not found for user ${user.full_name}.`);
    }

    // 4. Resolve or create transaction record
    let txn = existingTxn;
    if (!txn) {
      // Direct transfer to virtual account (user didn't click fund in UI first)
      const narration = `Wallet funded via Bank Transfer — ₦${amountNaira}`;
      const insertResult = await client.query(
        `INSERT INTO transactions (user_id, wallet_id, type, amount, status, reference, narration, provider_response)
         VALUES ($1, $2, 'FUNDING', $3, 'INITIATED', $4, $5, $6) RETURNING *`,
        [user.id, wallet.id, amountNaira, reference, narration, JSON.stringify(data)]
      );
      txn = insertResult.rows[0];
      
      txn = await TransactionStateMachine.transitionTo(txn.id, States.PENDING_PAYMENT, null, 'Virtual account transfer detected', client);
    }

    // Progress to PAYMENT_RECEIVED -> VALIDATING
    txn = await TransactionStateMachine.transitionTo(txn.id, States.PAYMENT_RECEIVED, null, 'Webhook payment notification received', client);
    txn = await TransactionStateMachine.transitionTo(txn.id, States.VALIDATING, null, 'Initiating deposit checks', client);

    // 5. Fraud system validation
    // Check if the user initiated the payment on the UI with a specific expected amount
    const fundingRefResult = await client.query(
      'SELECT amount FROM funding_references WHERE user_id = $1 LIMIT 1',
      [user.id]
    );
    const expectedAmount = fundingRefResult.rows[0]?.amount || null;

    const isFraud = await FraudService.evaluateTransaction(
      user.id, 
      txn.id, 
      amountNaira, 
      { expectedAmount, reference, signature, isReplay: false }, 
      client
    );

    if (isFraud) {
      console.warn(`🚨 [WEBHOOK] Funding flagged as fraud. Skipping wallet credit. Ref: ${reference}`);
      
      // Update webhook log
      await client.query(
        `INSERT INTO webhook_logs (provider, event_type, payload, signature, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['paystack', event, JSON.stringify(payload), signature, 'PROCESSED', 'Flagged as Fraud']
      );

      await client.query('COMMIT');

      // Send real-time warning to administrator panel via websocket
      broadcastToAdmins({
        type: 'admin_notification',
        category: 'fraud_alert',
        title: 'Fraudulent Funding Blocked',
        message: `User ${user.full_name} (${customerEmail}) deposit of ₦${amountNaira} was flagged and wallet was frozen.`,
        timestamp: new Date().toISOString()
      });

      return res.status(200).json({ status: 'flagged', message: 'Transaction flagged as fraud.' });
    }

    // 6. Deposit Settlement: Credit User Wallet, Debit System Bank Asset
    await WalletService.postLedgerTransaction(
      txn.id,
      'system_bank_asset',
      'user_wallet',
      wallet.id,
      amountNaira,
      client
    );

    // 7. Transition VALIDATING -> SUCCESSFUL
    txn = await TransactionStateMachine.transitionTo(txn.id, States.SUCCESSFUL, null, 'Deposit completed successfully', client);

    // 8. Log processed webhook
    await client.query(
      `INSERT INTO webhook_logs (provider, event_type, payload, signature, status)
       VALUES ($1, $2, $3, $4, $5)`,
      ['paystack', event, JSON.stringify(payload), signature, 'PROCESSED']
    );

    await client.query('COMMIT');

    console.log(`✅ [WEBHOOK] Funding successful. Credited ₦${amountNaira} to ${user.full_name}'s wallet.`);

    // 9. Notify user in real-time via WebSocket (triggers toast and chime sound)
    sendToUser(user.id, {
      type: 'notification',
      title: 'Wallet Funded Successfully!',
      message: `₦${amountNaira} has been credited to your wallet via Bank Transfer.`,
      timestamp: new Date().toISOString()
    });

    return res.status(200).json({ status: 'ok', message: 'Webhook processed successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ [WEBHOOK] Error processing webhook: ${err.message}`);

    await db.query(
      `INSERT INTO webhook_logs (provider, event_type, payload, signature, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['paystack', event, JSON.stringify(payload), signature, 'FAILED', err.message]
    );

    return res.status(500).json({ status: 'error', message: 'Webhook internal processing error.' });
  } finally {
    client.release();
  }
}
