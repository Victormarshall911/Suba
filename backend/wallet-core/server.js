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
import { WalletService } from './services/wallet-service.js';

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

// 4. Wallet Endpoint: Initiate Wallet Funding
app.post('/api/v1/wallet/fund/initiate', authenticateJWT, async (req, res) => {
  try {
    const { amount } = req.body;
    const data = await TransactionService.initiateFunding(req.user.userId, amount);
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 5. Wallet Endpoint: Purchase Airtime or Data (VTU)
app.post('/api/v1/wallet/purchase', authenticateJWT, async (req, res) => {
  try {
    const { type, amount, recipient_phone, network, plan_code, narration } = req.body;
    const data = await TransactionService.purchaseVTU(req.user.userId, {
      type,
      amount,
      recipient_phone,
      network,
      plan_code,
      narration
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6. Wallet Endpoint: Get user transaction logs
app.get('/api/v1/wallet/transactions', authenticateJWT, async (req, res) => {
  try {
    const transactions = await TransactionService.getTransactionsByUserId(req.user.userId);
    // Wrap inside pagination-like structure for frontend compatibility
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

// 11. Admin Endpoint: Freeze or unfreeze a wallet
app.post('/api/v1/admin/wallets/:id/freeze', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { is_frozen } = req.body;
    if (is_frozen === undefined) {
      return res.status(400).json({ message: 'Validation failed: is_frozen (boolean) is required.' });
    }
    const data = await WalletService.setWalletFreezeStatus(req.params.id, is_frozen);
    res.status(200).json(data);
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
