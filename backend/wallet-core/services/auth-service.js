import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as db from '../db/index.js';
import { WalletService } from './wallet-service.js';
import { EmailService } from './email-service.js';

export class AuthService {
  /**
   * Register a new user and assign their virtual account details.
   */
  static async register({ email, phone_number, full_name, password }) {
    const emailLower = email.toLowerCase().trim();
    
    // Check if user already exists
    const checkUser = await db.query(
      'SELECT id FROM users WHERE email = $1 OR phone_number = $2',
      [emailLower, phone_number]
    );
    if (checkUser.rowCount > 0) {
      throw new Error("Registration failed: Email or phone number is already registered.");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 1. Insert user
      const userResult = await client.query(
        `INSERT INTO users (email, phone_number, full_name, password_hash, role, is_active) 
         VALUES ($1, $2, $3, $4, 'USER', true) RETURNING id, email, phone_number, full_name, role, is_active, created_at`,
        [emailLower, phone_number, full_name, passwordHash]
      );
      const user = userResult.rows[0];

      // 1b. Create wallet for user
      await WalletService.createWallet(user.id, client);

      // 2. Generate deterministic virtual account details
      const lastDigits = user.phone_number.replace(/\D/g, '').slice(-6);
      const virtualAccount = `9922${lastDigits}`;
      const bankName = 'Sterling Bank';
      const reference = `REF-VA-${user.id.substring(0, 8).toUpperCase()}`;

      // 2b. Insert funding reference
      await client.query(
        `INSERT INTO funding_references (user_id, virtual_account, bank_name, reference)
         VALUES ($1, $2, $3, $4)`,
        [user.id, virtualAccount, bankName, reference]
      );

      // 2c. Seed default communication preferences
      await client.query(
        `INSERT INTO communication_preferences (user_id, newsletter, marketing, product_updates, security)
         VALUES ($1, true, true, true, true)`,
        [user.id]
      );

      await client.query('COMMIT');

      // Dispatch automated welcome and verification emails asynchronously
      try {
        await EmailService.sendAutomatedEmail(user.id, 'welcome');
        await EmailService.sendAutomatedEmail(user.id, 'verification', {
          verificationUrl: `https://suba.ng/verify?email=${encodeURIComponent(user.email)}`
        });
      } catch (emailErr) {
        console.warn("⚠️ [REGISTRATION] Automated emails failed to queue:", emailErr.message);
      }
      
      console.log(`[AUTH SERVICE] Registered new user ${emailLower}. Assigned Virtual Account: ${virtualAccount}`);
      return { ...user, virtualAccount, bankName, reference };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Authenticate a user and generate their access token.
   */
  static async login({ email, password }) {
    const emailLower = email.toLowerCase().trim();
    const result = await db.query('SELECT * FROM users WHERE email = $1', [emailLower]);
    const user = result.rows[0];

    if (!user) {
      throw new Error("Authentication failed: Incorrect email or password.");
    }
    if (!user.is_active) {
      throw new Error("Authentication failed: Account has been disabled. Please contact support.");
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      throw new Error("Authentication failed: Incorrect email or password.");
    }

    const fundRefResult = await db.query('SELECT * FROM funding_references WHERE user_id = $1', [user.id]);
    const fundRef = fundRefResult.rows[0];
    const virtual_account_number = fundRef ? fundRef.virtual_account : `9922${user.phone_number.replace(/\D/g, '').slice(-6)}`;
    const bank_name = fundRef ? fundRef.bank_name : 'Sterling Bank';
    const virtual_reference = fundRef ? fundRef.reference : `REF-VA-${user.id.substring(0, 8).toUpperCase()}`;

    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET || 'change-me-to-a-strong-jwt-secret', {
      expiresIn: '24h'
    });

    const walletResult = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [user.id]);
    const balance = walletResult.rowCount > 0 ? parseFloat(walletResult.rows[0].balance) : 0.00;

    const pointsResult = await db.query('SELECT current_points, total_earned, total_redeemed FROM sb_points WHERE user_id = $1', [user.id]);
    const sb_points = pointsResult.rowCount > 0 ? {
      current_points: parseInt(pointsResult.rows[0].current_points),
      total_earned: parseInt(pointsResult.rows[0].total_earned),
      total_redeemed: parseInt(pointsResult.rows[0].total_redeemed)
    } : { current_points: 0, total_earned: 0, total_redeemed: 0 };

    const ambResult = await db.query('SELECT referral_code FROM ambassadors WHERE user_id = $1', [user.id]);
    const referral_code = ambResult.rowCount > 0 ? ambResult.rows[0].referral_code : null;

    return {
      access_token: token,
      user: {
        id: user.id,
        email: user.email,
        phone_number: user.phone_number,
        full_name: user.full_name,
        role: user.role,
        is_frozen: !user.is_active,
        virtual_account_number,
        bank_name,
        virtual_reference,
        referral_code,
        balance,
        sb_points
      }
    };
  }

  /**
   * Get current user profile details.
   */
  static async getMe(userId) {
    const userResult = await db.query(
      'SELECT id, email, phone_number, full_name, role, is_active, created_at FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error("User not found.");
    }

    const fundRefResult = await db.query('SELECT * FROM funding_references WHERE user_id = $1', [user.id]);
    const fundRef = fundRefResult.rows[0];
    const virtual_account_number = fundRef ? fundRef.virtual_account : `9922${user.phone_number.replace(/\D/g, '').slice(-6)}`;
    const bank_name = fundRef ? fundRef.bank_name : 'Sterling Bank';
    const virtual_reference = fundRef ? fundRef.reference : `REF-VA-${user.id.substring(0, 8).toUpperCase()}`;

    const walletResult = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [user.id]);
    const balance = walletResult.rowCount > 0 ? parseFloat(walletResult.rows[0].balance) : 0.00;

    const pointsResult = await db.query('SELECT current_points, total_earned, total_redeemed FROM sb_points WHERE user_id = $1', [user.id]);
    const sb_points = pointsResult.rowCount > 0 ? {
      current_points: parseInt(pointsResult.rows[0].current_points),
      total_earned: parseInt(pointsResult.rows[0].total_earned),
      total_redeemed: parseInt(pointsResult.rows[0].total_redeemed)
    } : { current_points: 0, total_earned: 0, total_redeemed: 0 };

    const ambResult = await db.query('SELECT referral_code FROM ambassadors WHERE user_id = $1', [user.id]);
    const referral_code = ambResult.rowCount > 0 ? ambResult.rows[0].referral_code : null;

    return {
      id: user.id,
      email: user.email,
      phone_number: user.phone_number,
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active,
      created_at: user.created_at,
      is_frozen: !user.is_active,
      virtual_account_number,
      bank_name,
      virtual_reference,
      referral_code,
      balance,
      sb_points
    };
  }
}
