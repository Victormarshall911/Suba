import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import http from 'http';
import dotenv from 'dotenv';
import { initializeDatabase } from './db/index.js';
import { initializeWebSocket } from './services/websocket-service.js';
import { AuthService } from './services/auth-service.js';
import { TransactionService } from './services/transaction-service.js';
import { handlePaystackWebhook } from './controllers/webhook-controller.js';
import { ReconciliationService } from './services/reconciliation-service.js';
import { AssetService } from './services/asset-service.js';
import { GrowthService } from './services/growth-service.js';
import * as db from './db/index.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 8000;

// Enable CORS
app.use(cors());

// Limit requests to 100 per 10 minutes per IP
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '600000'), // 10 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, message: 'Too many requests. Please try again later.' }
});
app.use('/api/', apiLimiter);

// Parse JSON request bodies, capture raw body for webhook HMAC checks
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// HTTP Server wrapper
const server = http.createServer(app);

// Authentication Middleware
function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required. Missing authorization token.' });
  }

  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET || 'change-me-to-a-strong-jwt-secret', (err, decoded) => {
    if (err) {
      return res.status(401).json({ message: 'Authentication failed. Token is expired or invalid.' });
    }
    req.user = decoded;
    next();
  });
}

// Admin Authorization Middleware
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'ADMIN') {
    next();
  } else {
    res.status(403).json({ message: 'Access forbidden. Administrator access required.' });
  }
}

// =============================================================================
// API ROUTES
// =============================================================================

// 1. Auth Endpoint: Register
app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, phone_number, full_name, password } = req.body;
    if (!email || !phone_number || !full_name || !password) {
      return res.status(400).json({ message: 'Validation failed: All fields are required.' });
    }
    const data = await AuthService.register({ email, phone_number, full_name, password });
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 2. Auth Endpoint: Login
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Validation failed: Email and password are required.' });
    }
    const data = await AuthService.login({ email, password });
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 3. Auth Endpoint: Retrieve Current User Profile
app.get('/api/v1/auth/me', authenticateJWT, async (req, res) => {
  try {
    const data = await AuthService.getMe(req.user.userId);
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 4. Transactions: Initiate Payment for Asset Purchase
app.post('/api/v1/transactions/payment/initiate', authenticateJWT, async (req, res) => {
  try {
    const { type, amount, provider } = req.body;
    const data = await TransactionService.initiateAssetPurchase(req.user.userId, { type, amount, provider });
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 4b. Wallet Funding Endpoint (Map to Asset Purchase for backward compatibility)
app.post('/api/v1/wallet/fund/initiate', authenticateJWT, async (req, res) => {
  try {
    const { amount } = req.body;
    const data = await TransactionService.initiateAssetPurchase(req.user.userId, { type: 'AIRTIME', amount });
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 5. Assets: Get User Available Inventory
app.get('/api/v1/assets/inventory', authenticateJWT, async (req, res) => {
  try {
    const assets = await AssetService.getInventory(req.user.userId);
    res.status(200).json(assets);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 5b. Assets: Transfer Asset Internally
app.post('/api/v1/assets/transfer', authenticateJWT, async (req, res) => {
  try {
    const { assetId, recipientIdentifier } = req.body;
    if (!assetId || !recipientIdentifier) {
      return res.status(400).json({ message: 'Validation failed: assetId and recipientIdentifier are required.' });
    }
    const data = await AssetService.transferAsset(req.user.userId, assetId, recipientIdentifier);
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 5c. Assets: Redeem (VTU dispatch)
app.post('/api/v1/assets/redeem', authenticateJWT, async (req, res) => {
  try {
    const { assetId, targetPhone } = req.body;
    if (!assetId || !targetPhone) {
      return res.status(400).json({ message: 'Validation failed: assetId and targetPhone are required.' });
    }
    const data = await AssetService.redeemAsset(req.user.userId, assetId, targetPhone);
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6. User Transactions: Get logs
app.get('/api/v1/wallet/transactions', authenticateJWT, async (req, res) => {
  try {
    const transactions = await TransactionService.getTransactionsByUserId(req.user.userId);
    res.status(200).json({ items: transactions, total: transactions.length });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 7. Webhook Endpoint: Paystack deposit confirmation
app.post('/api/v1/webhooks/paystack', handlePaystackWebhook);

// 8. Admin Endpoint: Reconciliation dashboard summary
app.get('/api/v1/admin/reconciliation/dashboard', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      userId: req.query.userId
    };
    const data = await ReconciliationService.getDashboardMetrics(filters);
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 9. Admin Endpoint: Full Transaction status history trace
app.get('/api/v1/admin/transactions/:id/trace', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const data = await ReconciliationService.getTransactionTrace(req.params.id);
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 10. Admin Endpoint: Resolve manual review override queue
app.post('/api/v1/admin/transactions/:id/resolve', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { approve, reason } = req.body;
    if (approve === undefined || !reason) {
      return res.status(400).json({ message: 'Validation failed: approve (boolean) and reason (string) are required.' });
    }
    const data = await ReconciliationService.resolveManualReview(req.params.id, req.user.userId, approve, reason);
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6b. Ambassador: Apply
app.post('/api/v1/ambassador/apply', authenticateJWT, async (req, res) => {
  try {
    const { location, social_links, reason_for_joining, referral_code } = req.body;
    const data = await GrowthService.applyAmbassador(req.user.userId, { location, social_links, reason_for_joining, referral_code });
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6c. Ambassador: Profile statistics
app.get('/api/v1/ambassador/profile', authenticateJWT, async (req, res) => {
  try {
    const data = await GrowthService.getProfile(req.user.userId);
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6d. Ambassador: Referrals
app.get('/api/v1/ambassador/referrals', authenticateJWT, async (req, res) => {
  try {
    const profile = await GrowthService.getProfile(req.user.userId);
    if (!profile) {
      return res.status(400).json({ message: 'User is not an active ambassador.' });
    }
    const result = await db.query(
      `SELECT r.*, u.full_name, u.email 
       FROM referrals r
       JOIN users u ON r.referred_user_id = u.id
       WHERE r.ambassador_id = $1`,
      [profile.ambassador_id]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6e. Ambassador: Earnings
app.get('/api/v1/ambassador/earnings', authenticateJWT, async (req, res) => {
  try {
    const profile = await GrowthService.getProfile(req.user.userId);
    if (!profile) {
      return res.status(400).json({ message: 'User is not an active ambassador.' });
    }
    const result = await db.query(
      `SELECT c.*, t.type AS txn_type, t.amount AS txn_amount
       FROM commissions c
       JOIN transactions t ON c.transaction_id = t.id
       WHERE c.ambassador_id = $1
       ORDER BY c.created_at DESC`,
      [profile.ambassador_id]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6f. Careers: Public jobs listing
app.get('/api/v1/careers', async (req, res) => {
  try {
    const data = await ReconciliationService.getOpenJobs();
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6g. Careers: Apply for job
app.post('/api/v1/jobs/apply', authenticateJWT, async (req, res) => {
  try {
    const { jobId, cvUrl, coverLetter } = req.body;
    if (!jobId || !cvUrl) {
      return res.status(400).json({ message: 'Validation failed: jobId and cvUrl are required.' });
    }
    const data = await ReconciliationService.applyForJob({ jobId, userId: req.user.userId, cvUrl, coverLetter });
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Admin GET: Retrieve all job postings (both OPEN and CLOSED)
app.get('/api/v1/admin/jobs', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM jobs ORDER BY created_at DESC');
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Admin GET: Retrieve all candidate job applications
app.get('/api/v1/admin/jobs/applications', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ja.*, j.title AS job_title, u.full_name AS applicant_name, u.email AS applicant_email 
       FROM job_applications ja
       JOIN jobs j ON ja.job_id = j.id
       JOIN users u ON ja.user_id = u.id
       ORDER BY ja.created_at DESC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6h. Admin: Post job opening
app.post('/api/v1/admin/jobs', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { title, description, requirements, location, employment_type, deadline } = req.body;
    if (!title || !description || !requirements || !location || !employment_type || !deadline) {
      return res.status(400).json({ message: 'Validation failed: All job details are required.' });
    }
    const data = await ReconciliationService.createJob({ title, description, requirements, location, employment_type, deadline });
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6i. Admin: Update job opening
app.patch('/api/v1/admin/jobs/:id', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ message: 'Validation failed: status is required.' });
    }
    const data = await ReconciliationService.updateJob(req.params.id, { status });
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6j. Admin: Delete job opening
app.delete('/api/v1/admin/jobs/:id', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const data = await ReconciliationService.deleteJob(req.params.id);
    res.status(200).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 11. Admin Endpoint: Freeze or unfreeze a wallet (Map to suspend user account)
app.post('/api/v1/admin/wallets/:id/freeze', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { is_frozen } = req.body;
    if (is_frozen === undefined) {
      return res.status(400).json({ message: 'Validation failed: is_frozen (boolean) is required.' });
    }
    await db.query(
      'UPDATE users SET is_active = $1 WHERE id = $2',
      [!is_frozen, req.params.id]
    );
    res.status(200).json({ id: req.params.id, is_frozen });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 12. Admin Endpoint: Get all system transactions
app.get('/api/v1/admin/transactions', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const txns = await TransactionService.getAllTransactions();
    res.status(200).json(txns);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// =============================================================================
// SERVER INITIALIZATION
// =============================================================================

async function startServer() {
  // Initialize Database Schema
  await initializeDatabase();

  // Bind WebSocket server to HTTP port
  initializeWebSocket(server);

  server.listen(port, () => {
    console.log(`🚀 Suba Wallet Core backend listening at http://localhost:${port}`);
  });
}

startServer().catch(err => {
  console.error("❌ Failed to start application server:", err);
});
export default server;
