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
      department: 'Engineering',
      description: 'Review provider performance logs and audit ledger entries daily.',
      responsibilities: 'Monitor API health metrics and resolve daily ledger imbalances.',
      requirements: 'Attention to detail, experience with finance reconciliation tools.',
      location: 'Remote, Nigeria',
      employment_type: 'Full-time',
      deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      status: 'PUBLISHED'
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

    // -------------------------------------------------------------------------
    // TEST 11: SB Points System & Loyalty Actions
    // -------------------------------------------------------------------------
    console.log("\n11. Testing SB Points Loyalty Earning, Reversal, and Redemption...");
    const { RewardService } = await import('../services/reward-service.js');

    // Reset referred user points state
    await db.query('DELETE FROM sb_points WHERE user_id = $1', [referredUser.id]);
    await db.query('DELETE FROM point_history WHERE user_id = $1', [referredUser.id]);



    // Make sure configs are seeded in the database
    await db.query(
      `INSERT INTO system_configs (key, value, updated_at) VALUES ('points_earning_rate', '100', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    );
    await db.query(
      `INSERT INTO system_configs (key, value, updated_at) VALUES ('points_redemption_rate', '0.5', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    );

    // Initial check (should be 0)
    let pointsStats = await RewardService.getPointsByUser(referredUser.id);
    console.log(`    ✅ Initial points for referred user: ${pointsStats.current_points}`);

    // Award points for transaction (Naira transaction value 1000 => 10 points)
    await RewardService.awardPointsForTransaction(referredUser.id, initiateTxn.id, purchaseAmount);
    pointsStats = await RewardService.getPointsByUser(referredUser.id);
    console.log(`    ✅ Awarded points for transaction: ${pointsStats.current_points} (expected: 10)`);
    if (pointsStats.current_points !== 10) {
      throw new Error(`Expected 10 points, got ${pointsStats.current_points}`);
    }

    // Reverse points
    await RewardService.reversePointsForTransaction(referredUser.id, initiateTxn.id);
    pointsStats = await RewardService.getPointsByUser(referredUser.id);
    console.log(`    ✅ Reversed points for transaction: ${pointsStats.current_points} (expected: 0)`);
    if (pointsStats.current_points !== 0) {
      throw new Error(`Expected 0 points after reversal, got ${pointsStats.current_points}`);
    }

    // Manual award
    await RewardService.manualAwardPoints(referredUser.email, 100, 'Test manual award');
    pointsStats = await RewardService.getPointsByUser(referredUser.id);
    console.log(`    ✅ Manually awarded points: ${pointsStats.current_points} (expected: 100)`);
    if (pointsStats.current_points !== 100) {
      throw new Error(`Expected 100 points, got ${pointsStats.current_points}`);
    }

    // Load initial wallet balance
    const walletRes = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [referredUser.id]);
    const initialBalance = parseFloat(walletRes.rows[0]?.balance || 0);

    // Redeem points (100 points * 0.5 = 50 Naira cashback discount)
    await RewardService.redeemPoints(referredUser.id, 100, 'Test redemption');
    pointsStats = await RewardService.getPointsByUser(referredUser.id);
    console.log(`    ✅ Points after redemption: ${pointsStats.current_points} (expected: 0)`);
    if (pointsStats.current_points !== 0) {
      throw new Error(`Expected 0 points after redemption, got ${pointsStats.current_points}`);
    }

    const postRedeemWallet = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [referredUser.id]);
    const finalBalance = parseFloat(postRedeemWallet.rows[0]?.balance || 0);
    console.log(`    ✅ User wallet balance: Initial ₦${initialBalance} -> Final ₦${finalBalance} (cashback: ₦${finalBalance - initialBalance})`);
    if (finalBalance - initialBalance !== 50.00) {
      throw new Error(`Expected ₦50.00 wallet cashback, got ₦${finalBalance - initialBalance}`);
    }

    // TEST 12: Communication System (Campaigns, Queue Workers, Preferences & Notifications)
    // -------------------------------------------------------------------------
    console.log("\n12. Testing Suba Communication Campaigns, Queue worker, and Preferences filtering...");
    const { EmailService } = await import('../services/email-service.js');
    const { NotificationService } = await import('../services/notification-service.js');

    // Register user A (newsletter = true) and user B (newsletter = false)
    const userA = await AuthService.register({
      email: 'suba_subscribed@suba.ng',
      phone_number: '08111111111',
      full_name: 'Subscriber User',
      password: 'Password123'
    });

    const userB = await AuthService.register({
      email: 'suba_opted_out@suba.ng',
      phone_number: '08222222222',
      full_name: 'Opt-out User',
      password: 'Password123'
    });

    // Update User B preference to opt-out
    await db.query(
      `UPDATE communication_preferences 
       SET newsletter = false, marketing = false, product_updates = false 
       WHERE user_id = $1`,
      [userB.id]
    );

    // Create Newsletter subscriber records
    await db.query(
      `INSERT INTO newsletter_subscribers (email, is_user, user_id, status)
       VALUES ('suba_subscribed@suba.ng', true, $1, 'SUBSCRIBED')`,
      [userA.id]
    );
    await db.query(
      `INSERT INTO newsletter_subscribers (email, is_user, user_id, status)
       VALUES ('suba_opted_out@suba.ng', true, $2, 'UNSUBSCRIBED')`,
      [userB.id]
    );

    // Insert Campaign row of type 'newsletter'
    const campaignRes = await db.query(
      `INSERT INTO email_campaigns (subject, body, email_type, recipient_segment, status)
       VALUES ('Weekly Digest Test', 'Hello {{fullName}}, welcome to weekly updates!', 'newsletter', 'ALL', 'PENDING')
       RETURNING id`
    );
    const campaignId = campaignRes.rows[0].id;

    // Queue Campaign
    await EmailService.queueCampaign(campaignId);

    // Poll database for background queue completion
    let campaignStatus = 'PENDING';
    for (let i = 0; i < 100; i++) {
      const statusRes = await db.query('SELECT status FROM email_campaigns WHERE id = $1', [campaignId]);
      campaignStatus = statusRes.rows[0]?.status;
      if (campaignStatus === 'COMPLETED' || campaignStatus === 'FAILED') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`    ✅ Campaign status after queue worker execution: ${campaignStatus}`);
    if (campaignStatus !== 'COMPLETED') {
      throw new Error(`Campaign processing failed or timed out. Status: ${campaignStatus}`);
    }

    // Verify User A received the email log
    const logARes = await db.query("SELECT id FROM email_logs WHERE campaign_id = $1 AND recipient = $2", [campaignId, 'suba_subscribed@suba.ng']);
    console.log(`    ✅ User A (Subscribed) email delivery logs rowCount: ${logARes.rowCount} (expected: 1)`);
    if (logARes.rowCount !== 1) {
      throw new Error(`Expected 1 email log for subscribed user, got ${logARes.rowCount}`);
    }

    // Verify User B did NOT receive the email log (since newsletter = false)
    const logBRes = await db.query("SELECT id FROM email_logs WHERE campaign_id = $1 AND recipient = $2", [campaignId, 'suba_opted_out@suba.ng']);
    console.log(`    ✅ User B (Opted-out) email delivery logs rowCount: ${logBRes.rowCount} (expected: 0)`);
    if (logBRes.rowCount !== 0) {
      throw new Error(`Expected 0 email logs for opted-out user, got ${logBRes.rowCount}`);
    }

    // Test In-App Notification Center triggers
    // Create direct notifications
    const notif = await NotificationService.createNotification(userA.id, 'Test Alert Title', 'Test Alert Message text', 'announcement');
    let unreadCount = await NotificationService.getUnreadCount(userA.id);
    console.log(`    ✅ Unread notifications count for User A: ${unreadCount} (expected: 1)`);
    if (unreadCount !== 1) {
      throw new Error(`Expected 1 unread notification, got ${unreadCount}`);
    }

    // Mark all as read
    await NotificationService.markAllAsRead(userA.id);
    unreadCount = await NotificationService.getUnreadCount(userA.id);
    console.log(`    ✅ Unread count after marking read: ${unreadCount} (expected: 0)`);
    if (unreadCount !== 0) {
      throw new Error(`Expected 0 unread notifications after markAllAsRead, got ${unreadCount}`);
    }

    // Delete notification
    const deleted = await NotificationService.deleteNotification(userA.id, notif.id);
    console.log(`    ✅ Notification deleted successfully: ${deleted.success}`);
    if (!deleted.success) {
      throw new Error("Failed to delete notification");
    }

    console.log("\n🌟 All test checks passed successfully! Suba Transaction + Asset + Growth + Communication System is 100% compliant.");
    
  } catch (error) {
    console.error("\n❌ Verification Test Suite FAILED:", error);
    process.exit(1);
  }
}

runTests();
