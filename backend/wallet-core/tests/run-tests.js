import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { AuthService } from '../services/auth-service.js';
import { TransactionService } from '../services/transaction-service.js';
import { ReconciliationService } from '../services/reconciliation-service.js';
import { WalletService } from '../services/wallet-service.js';
import { States } from '../services/state-machine.js';
import * as db from '../db/index.js';

// Setup environment variables for test execution
process.env.JWT_SECRET = 'test-secret-key';
process.env.PAYSTACK_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.APP_ENV = 'development';

async function runTests() {
  console.log("🧪 Starting Suba Wallet Core verification test suite...\n");
  
  // Make sure DB schema is loaded
  await db.initializeDatabase();

  let testUser = null;
  let testAdmin = null;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: User Registration
    // -------------------------------------------------------------------------
    console.log("1. Testing User Registration...");
    testUser = await AuthService.register({
      email: `test_student_${Date.now()}@suba.edu.ng`,
      phone_number: `080${Math.floor(10000000 + Math.random() * 90000000)}`,
      full_name: 'Test Student',
      password: 'SecurePassword123'
    });
    console.log(`✅ User registered. Email: ${testUser.email}`);
    console.log(`✅ Virtual Account Generated: ${testUser.virtualAccount} (${testUser.bankName})`);
    
    if (testUser.wallet.balance !== 0) {
      throw new Error("Wallet balance must start at ₦0.00");
    }
    console.log("✅ Starting wallet balance is ₦0.00 as expected.");

    // -------------------------------------------------------------------------
    // TEST 2: Admin Registration
    // -------------------------------------------------------------------------
    console.log("\n2. Testing Admin Account Setup...");
    // Manually register then elevate role in database
    const adminUser = await AuthService.register({
      email: `admin_override_${Date.now()}@suba.ng`,
      phone_number: `090${Math.floor(10000000 + Math.random() * 90000000)}`,
      full_name: 'System Administrator',
      password: 'AdminPassword456'
    });
    await db.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminUser.id]);
    
    // Perform login to fetch full credentials
    testAdmin = await AuthService.login({
      email: adminUser.email,
      password: 'AdminPassword456'
    });
    console.log(`✅ Admin logged in. Role is: ${testAdmin.user.role}`);

    // -------------------------------------------------------------------------
    // TEST 3: Wallet Funding Initiation
    // -------------------------------------------------------------------------
    console.log("\n3. Testing Wallet Funding Initiation...");
    const depositAmount = 2500.00;
    const fundingTxn = await TransactionService.initiateFunding(testUser.id, depositAmount);
    console.log(`✅ Funding transaction initiated. Ref: ${fundingTxn.reference}`);
    
    if (fundingTxn.status !== States.PENDING_PAYMENT) {
      throw new Error(`Expected initiated state ${States.PENDING_PAYMENT}, got ${fundingTxn.status}`);
    }
    console.log(`✅ Transaction state is ${fundingTxn.status} (audited).`);

    // -------------------------------------------------------------------------
    // TEST 4: HMAC Signature & Webhook Processing (Bank Transfer)
    // -------------------------------------------------------------------------
    console.log("\n4. Testing Paystack Webhook Settlement (Signature Verification)...");
    
    // Build Paystack charge.success webhook payload
    const webhookPayload = {
      event: 'charge.success',
      data: {
        reference: fundingTxn.reference,
        amount: depositAmount * 100, // in kobo
        channel: 'bank_transfer',
        customer: {
          email: testUser.email
        },
        authorization: {
          channel: 'bank_transfer'
        }
      }
    };
    
    const rawBody = JSON.stringify(webhookPayload);
    const signature = crypto
      .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    // Simulate calling the webhook handler
    const mockReq = {
      headers: { 'x-paystack-signature': signature },
      rawBody: rawBody,
      body: webhookPayload
    };

    let responseCode = 0;
    let responseBody = null;
    const mockRes = {
      status: (code) => {
        responseCode = code;
        return {
          json: (body) => {
            responseBody = body;
          }
        };
      },
      json: (body) => {
        responseCode = 200;
        responseBody = body;
      }
    };

    // Import controller and run
    const { handlePaystackWebhook } = await import('../controllers/webhook-controller.js');
    await handlePaystackWebhook(mockReq, mockRes);

    console.log(`✅ Webhook response code: ${responseCode}`);
    console.log(`✅ Webhook output status: ${responseBody.status}`);

    if (responseCode !== 200 || responseBody.status !== 'ok') {
      throw new Error(`Webhook failed: ${JSON.stringify(responseBody)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Double-Entry Ledger Verification
    // -------------------------------------------------------------------------
    console.log("\n5. Auditing Double-Entry Ledger and Account Balances...");
    
    // Fetch user wallet
    const updatedWallet = await WalletService.getWalletByUserId(testUser.id);
    console.log(`✅ Current cached wallet balance: ₦${updatedWallet.balance}`);
    if (parseFloat(updatedWallet.balance) !== depositAmount) {
      throw new Error(`Expected wallet balance ₦${depositAmount}, got ₦${updatedWallet.balance}`);
    }

    // Compute balance from ledger sum
    const auditedBalance = await WalletService.auditWalletBalance(updatedWallet.id);
    console.log(`✅ Direct ledger-audited balance sum: ₦${auditedBalance}`);
    if (auditedBalance !== depositAmount) {
      throw new Error(`Balance inconsistency: Ledger states ₦${auditedBalance} but wallet cache shows ₦${updatedWallet.balance}`);
    }
    console.log("✅ Ledger matches wallet balance cache exactly.");

    // Check trace for transaction
    const trace = await ReconciliationService.getTransactionTrace(fundingTxn.id);
    console.log(`✅ Status History Transition Trail:`);
    trace.statusHistory.forEach(log => {
      console.log(`   - [${log.created_at}] ${log.from_status || 'NULL'} -> ${log.to_status} (${log.remarks})`);
    });
    
    if (trace.ledgerEntries.length !== 2) {
      throw new Error("Ledger entries must contain exactly 1 DEBIT and 1 CREDIT entry.");
    }
    console.log("✅ Double-entry bookkeeping matches: 2 ledger records created.");

    // -------------------------------------------------------------------------
    // TEST 6: Rule-Based Fraud Detection System
    // -------------------------------------------------------------------------
    console.log("\n6. Testing Fraud Rule Trigger (Sudden large deposit on new user account)...");
    
    const largeDepositAmount = 75000.00;
    const fraudTxn = await TransactionService.initiateFunding(testUser.id, largeDepositAmount);
    
    // Build Paystack charge.success webhook payload for large amount
    const fraudPayload = {
      event: 'charge.success',
      data: {
        reference: fraudTxn.reference,
        amount: largeDepositAmount * 100, // in kobo
        channel: 'bank_transfer',
        customer: {
          email: testUser.email
        },
        authorization: {
          channel: 'bank_transfer'
        }
      }
    };
    
    const rawBodyFraud = JSON.stringify(fraudPayload);
    const signatureFraud = crypto
      .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
      .update(rawBodyFraud)
      .digest('hex');

    const mockReqFraud = {
      headers: { 'x-paystack-signature': signatureFraud },
      rawBody: rawBodyFraud,
      body: fraudPayload
    };

    let fraudCode = 0;
    let fraudResponse = null;
    const mockResFraud = {
      status: (code) => {
        fraudCode = code;
        return {
          json: (body) => {
            fraudResponse = body;
          }
        };
      },
      json: (body) => {
        fraudCode = 200;
        fraudResponse = body;
      }
    };

    await handlePaystackWebhook(mockReqFraud, mockResFraud);
    console.log(`✅ Fraud Webhook status: ${fraudResponse.status}`);
    
    const frozenWallet = await WalletService.getWalletByUserId(testUser.id);
    console.log(`✅ Wallet freeze status: ${frozenWallet.is_frozen}`);
    if (!frozenWallet.is_frozen) {
      throw new Error("Fraud System Error: Wallet must be frozen after triggering fraud flags.");
    }
    console.log("✅ User wallet frozen as expected.");

    const finalFraudTxnRes = await db.query('SELECT status FROM transactions WHERE id = $1', [fraudTxn.id]);
    const finalFraudTxn = finalFraudTxnRes.rows[0];
    console.log(`✅ Transaction state: ${finalFraudTxn.status}`);
    if (finalFraudTxn.status !== States.MANUAL_REVIEW) {
      throw new Error(`Fraud Txn must be in MANUAL_REVIEW, currently ${finalFraudTxn.status}`);
    }
    console.log("✅ Transaction moved to manual review queue.");

    // -------------------------------------------------------------------------
    // TEST 7: Admin Override manual queue
    // -------------------------------------------------------------------------
    console.log("\n7. Testing Admin Override resolution of manual queue...");
    
    const resolveResult = await ReconciliationService.resolveManualReview(
      fraudTxn.id,
      testAdmin.user.id,
      true, // Approve transaction
      "Valid user identity verified after video call verification."
    );
    console.log(`✅ Override complete. Status transitioned to: ${resolveResult.newStatus}`);

    const unfrozenWallet = await WalletService.getWalletByUserId(testUser.id);
    console.log(`✅ Post-override Wallet freeze status: ${unfrozenWallet.is_frozen}`);
    if (unfrozenWallet.is_frozen) {
      throw new Error("Override Error: Wallet must be unfrozen upon admin approval.");
    }
    
    const afterApprovalBalance = await WalletService.auditWalletBalance(unfrozenWallet.id);
    console.log(`✅ New wallet balance audited: ₦${afterApprovalBalance}`);
    if (afterApprovalBalance !== (depositAmount + largeDepositAmount)) {
      throw new Error(`Improper balance. Expected ₦${depositAmount + largeDepositAmount}, got ₦${afterApprovalBalance}`);
    }
    console.log("✅ Balance credited after admin override approval.");

    // -------------------------------------------------------------------------
    // TEST 8: Reconciliation Dashboard Analytics & Ledger Imbalance Checks
    // -------------------------------------------------------------------------
    console.log("\n8. Testing Reconciliation Dashboard Analytics & Ledger Imbalance Checks...");
    const reconMetrics = await ReconciliationService.getDashboardMetrics();
    console.log(`✅ System metrics retrieved:`);
    console.log(`   - Pending Transactions count: ${reconMetrics.pendingCount}`);
    console.log(`   - Failed Transactions count: ${reconMetrics.failedCount}`);
    console.log(`   - Daily Funding settled: ₦${reconMetrics.dailyFunding.total}`);
    console.log(`   - Total Ledger Debits: ₦${reconMetrics.ledgerAudit.totalDebits}`);
    console.log(`   - Total Ledger Credits: ₦${reconMetrics.ledgerAudit.totalCredits}`);
    console.log(`   - Ledger Imbalance detected: ${reconMetrics.ledgerAudit.isImbalanced}`);

    if (reconMetrics.ledgerAudit.isImbalanced) {
      throw new Error("Double-entry constraint failure: Debits and Credits must balance!");
    }
    console.log("✅ Reconciliation verification checks out: Debits match Credits.");

    console.log("\n🌟 All test checks passed successfully! Suba Wallet Core is 100% compliant.");
    
  } catch (error) {
    console.error("\n❌ Verification Test Suite FAILED:", error);
    process.exit(1);
  }
}

runTests();
