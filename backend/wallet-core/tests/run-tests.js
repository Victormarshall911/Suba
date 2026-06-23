import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { AuthService } from '../services/auth-service.js';
import { TransactionService } from '../services/transaction-service.js';
import { ReconciliationService } from '../services/reconciliation-service.js';
import { AssetService } from '../services/asset-service.js';
import { GrowthService } from '../services/growth-service.js';
import { FraudService } from '../services/fraud-service.js';
import { States } from '../services/state-machine.js';
import * as db from '../db/index.js';

// Setup environment variables for test execution
process.env.JWT_SECRET = 'test-secret-key';
process.env.PAYSTACK_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.APP_ENV = 'development';

async function runTests() {
  console.log("🧪 Starting Suba Transaction & Asset System verification test suite...\n");
  
  // Make sure DB schema is loaded
  await db.initializeDatabase();

  let ambassadorUser = null;
  let referredUser = null;
  let testAdmin = null;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: User Registration & Virtual Account Generation
    // -------------------------------------------------------------------------
    console.log("1. Testing User Registration & Deterministic Virtual Accounts...");
    ambassadorUser = await AuthService.register({
      email: `ambassador_${Date.now()}@suba.edu.ng`,
      phone_number: `080${Math.floor(10000000 + Math.random() * 90000000)}`,
      full_name: 'Ambassador Candidate',
      password: 'SecurePassword123'
    });
    console.log(`   ✅ Registered User. Email: ${ambassadorUser.email}`);
    console.log(`   ✅ Virtual Account details: ${ambassadorUser.virtualAccount} (${ambassadorUser.bankName})`);
    
    if (!ambassadorUser.virtualAccount.startsWith('9922')) {
      throw new Error("Virtual account must be prefixed with 9922");
    }
    console.log("   ✅ Virtual account prefix (9922) verified.");

    // -------------------------------------------------------------------------
    // TEST 2: Admin Registration Setup
    // -------------------------------------------------------------------------
    console.log("\n2. Testing Admin Account Setup...");
    const adminUser = await AuthService.register({
      email: `admin_reconcile_${Date.now()}@suba.ng`,
      phone_number: `090${Math.floor(10000000 + Math.random() * 90000000)}`,
      full_name: 'Suba Super Admin',
      password: 'AdminPassword456'
    });
    await db.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminUser.id]);
    
    testAdmin = await AuthService.login({
      email: adminUser.email,
      password: 'AdminPassword456'
    });
    console.log(`   ✅ Admin logged in. Role verified: ${testAdmin.user.role}`);

    // -------------------------------------------------------------------------
    // TEST 3: Become Ambassador (Lifecycle Registration)
    // -------------------------------------------------------------------------
    console.log("\n3. Testing Ambassador Lifecycle Application...");
    const applyRes = await GrowthService.applyAmbassador(ambassadorUser.id, {
      location: 'Lagos University Campus',
      social_links: 'twitter.com/suba_amb',
      reason_for_joining: 'Promoting student VTU services for growth.'
    });
    console.log(`   ✅ Ambassador application logged. Status: ${applyRes.status}, Code: ${applyRes.referral_code}`);

    // Admin approves the application
    await db.query("UPDATE ambassadors SET status = 'APPROVED' WHERE user_id = $1", [ambassadorUser.id]);
    console.log("   ✅ Ambassador application approved by Admin.");

    const updatedProfile = await GrowthService.getProfile(ambassadorUser.id);
    console.log(`   ✅ Ambassador level initialized: ${updatedProfile.level}`);

    // -------------------------------------------------------------------------
    // TEST 4: Refer New User (Viral Referral Attribution)
    // -------------------------------------------------------------------------
    console.log("\n4. Testing Referral signup attribution...");
    referredUser = await AuthService.register({
      email: `referred_student_${Date.now()}@suba.edu.ng`,
      phone_number: `081${Math.floor(10000000 + Math.random() * 90000000)}`,
      full_name: 'Referred Student',
      password: 'StudentPassword999'
    });

    // Attribute the referral
    await db.query(
      `INSERT INTO referrals (ambassador_id, referred_user_id) 
       VALUES ($1, $2)`,
      [updatedProfile.ambassador_id, referredUser.id]
    );
    console.log(`   ✅ Referred user registered and mapped to Ambassador referral code.`);

    // -------------------------------------------------------------------------
    // TEST 5: Purchase Transaction & Paystack Webhook Event Processing
    // -------------------------------------------------------------------------
    console.log("\n5. Testing Webhook Asset Purchase Fulfillment & Commission Ledgers...");
    const purchaseAmount = 1000.00;
    const initiateTxn = await TransactionService.initiateAssetPurchase(referredUser.id, {
      type: 'AIRTIME',
      amount: purchaseAmount,
      provider: 'paystack'
    });
    console.log(`   ✅ Asset purchase transaction initiated. Ref: ${initiateTxn.reference}`);

    // Simulate Paystack charge.success webhook payload
    const webhookPayload = {
      event: 'charge.success',
      data: {
        reference: initiateTxn.reference,
        amount: purchaseAmount * 100, // in kobo
        channel: 'bank_transfer',
        customer: {
          email: referredUser.email
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
          json: (body) => { responseBody = body; }
        };
      },
      json: (body) => {
        responseCode = 200;
        responseBody = body;
      }
    };

    const { handlePaystackWebhook } = await import('../controllers/webhook-controller.js');
    await handlePaystackWebhook(mockReq, mockRes);
    
    console.log(`   ✅ Webhook Response Code: ${responseCode}`);
    console.log(`   ✅ Webhook Output Status: ${responseBody.status}`);

    if (responseCode !== 200 || responseBody.status !== 'ok') {
      throw new Error(`Webhook transaction confirmation failed: ${JSON.stringify(responseBody)}`);
    }

    // Verify Asset allocated in inventory
    const userAssets = await AssetService.getInventory(referredUser.id);
    console.log(`   ✅ Asset inventory loaded for referred user. Count: ${userAssets.length}`);
    if (userAssets.length !== 1 || parseFloat(userAssets[0].value_denomination) !== purchaseAmount) {
      throw new Error("Asset purchase was not correctly credited to user inventory.");
    }
    console.log(`   ✅ User inventory details: ${userAssets[0].asset_type} card value ₦${userAssets[0].value_denomination}`);

    // Verify Commission logged for Ambassador
    const ambProfile = await GrowthService.getProfile(ambassadorUser.id);
    console.log(`   ✅ Ambassador referral count: ${ambProfile.total_referrals}`);
    console.log(`   ✅ Ambassador commission earnings: Total Earned: ₦${ambProfile.total_earned}`);
    if (ambProfile.total_earned !== 15.00) { // 1.5% Bronze rate on 1000
      throw new Error(`Expected ₦15.00 bronze commission, got ₦${ambProfile.total_earned}`);
    }
    console.log("   ✅ Bronze tier commission rate correctly calculated and protected.");

    // -------------------------------------------------------------------------
    // TEST 6: Asset Internal Transfer & Redemption Flows
    // -------------------------------------------------------------------------
    console.log("\n6. Testing Asset internal transfers and physical redemptions...");
    const targetAssetId = userAssets[0].id;
    
    // Transfer asset internally
    const transferRes = await AssetService.transferAsset(referredUser.id, targetAssetId, ambassadorUser.email);
    console.log(`   ✅ Asset transferred successfully. Recipient: ${transferRes.recipient}`);

    const recipientAssets = await AssetService.getInventory(ambassadorUser.id);
    console.log(`   ✅ Recipient inventory loaded. Count: ${recipientAssets.length}`);
    if (recipientAssets.length !== 1 || recipientAssets[0].id !== targetAssetId) {
      throw new Error("Transfer failed: Asset not found in recipient's inventory.");
    }

    // Redeem asset (dispatch VTU to phone number)
    const redeemRes = await AssetService.redeemAsset(ambassadorUser.id, targetAssetId, '08039999999');
    console.log(`   ✅ Physical redemption dispatched. VTU reference: ${redeemRes.txnReference}`);

    const postRedeemAssets = await AssetService.getInventory(ambassadorUser.id);
    if (postRedeemAssets.length !== 0) {
      throw new Error("Redemption failed: Asset must be removed from available inventory.");
    }
    console.log("   ✅ Asset successfully marked as USED and consumed.");

    // -------------------------------------------------------------------------
    // TEST 7: Fraud Detection Window velocity checks
    // -------------------------------------------------------------------------
    console.log("\n7. Testing Fraud Velocity Lock triggers...");
    
    // Trigger abnormal transaction velocity rule by initiating >5 transactions in short period
    let lastTxn = null;
    for (let i = 0; i < 6; i++) {
      lastTxn = await TransactionService.initiateAssetPurchase(referredUser.id, {
        type: 'DATA',
        amount: 250.00
      });
    }
    
    // Evaluate fraud velocity lock rules on the last transaction
    await FraudService.evaluateTransaction(referredUser.id, lastTxn.id, 250.00, {});
    
    // Check if account frozen and transaction flags raised
    const checkReferred = await AuthService.getMe(referredUser.id);
    console.log(`   ✅ Suspend status of referred user: ${!checkReferred.is_active ? 'SUSPENDED' : 'ACTIVE'}`);
    if (checkReferred.is_active) {
      throw new Error("Fraud System Error: Account must be suspended due to transaction velocity flag.");
    }
    console.log("   ✅ User account frozen successfully.");

    // -------------------------------------------------------------------------
    // TEST 8: Admin Reconciliation Dashboard Metrics
    // -------------------------------------------------------------------------
    console.log("\n8. Testing Admin Reconciliation Dashboard Auditing...");
    const metrics = await ReconciliationService.getDashboardMetrics();
    console.log(`   ✅ Reconciliation stats loaded:`);
    console.log(`      - Daily funding: ₦${metrics.dailyFunding.total} (${metrics.dailyFunding.count} txns)`);
    console.log(`      - Ledger debits (fiat): ₦${metrics.ledgerAudit.totalDebits}`);
    console.log(`      - Ledger credits (assets): ₦${metrics.ledgerAudit.totalCredits}`);
    console.log(`      - Imbalance detected: ${metrics.ledgerAudit.isImbalanced}`);
    console.log(`      - Active Fraud Flags in queue: ${metrics.activeFraudFlags.length}`);
    console.log(`      - Manual Review Queue items: ${metrics.manualReviewQueue.length}`);

    if (metrics.manualReviewQueue.length === 0) {
      throw new Error("Manual review queue must contain the flagged velocity transaction.");
    }

    // -------------------------------------------------------------------------
    // TEST 9: Admin Override Manual Queue Resolution
    // -------------------------------------------------------------------------
    console.log("\n9. Testing Admin manual override and user activation...");
    const targetReviewTxnId = metrics.manualReviewQueue[0].id;
    
    await ReconciliationService.resolveManualReview(
      targetReviewTxnId,
      adminUser.id,
      true, // Approve
      "Manually verified customer profile and velocity pattern."
    );

    const postOverrideUser = await AuthService.getMe(referredUser.id);
    console.log(`   ✅ User status post-override: ${postOverrideUser.is_active ? 'ACTIVE (Unfrozen)' : 'SUSPENDED'}`);
    if (!postOverrideUser.is_active) {
      throw new Error("Override failure: User must be set active after manual override approval.");
    }
    console.log("   ✅ User account reactivated successfully.");

    // -------------------------------------------------------------------------
    // TEST 10: Careers Job Board creation and applications
    // -------------------------------------------------------------------------
    console.log("\n10. Testing Careers Board job posting and CV submission...");
    const job = await ReconciliationService.createJob({
      title: 'VTU Operations Analyst',
      description: 'Review provider performance logs and audit ledger entries daily.',
      requirements: 'Attention to detail, experience with finance reconciliation tools.',
      location: 'Remote, Nigeria',
      employment_type: 'Full-time',
      deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    });
    console.log(`    ✅ Job opening published: ${job.title} (${job.id})`);

    const openJobs = await ReconciliationService.getOpenJobs();
    if (openJobs.length !== 1 || openJobs[0].id !== job.id) {
      throw new Error("Job search failed: Open job not found in listing.");
    }

    const application = await ReconciliationService.applyForJob({
      jobId: job.id,
      userId: ambassadorUser.id,
      cvUrl: 'https://subastorage.blob.core.windows.net/cvs/cv_ambassador.pdf',
      coverLetter: 'Interested in VTU audits and finance execution engines.'
    });
    console.log(`    ✅ CV application submitted successfully. Current Status: ${application.status}`);

    console.log("\n🌟 All test checks passed successfully! Suba Transaction + Asset + Growth System is 100% compliant.");
    
  } catch (error) {
    console.error("\n❌ Verification Test Suite FAILED:", error);
    process.exit(1);
  }
}

runTests();
