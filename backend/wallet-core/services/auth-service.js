import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as db from '../db/index.js';
import { WalletService } from './wallet-service.js';

export class AuthService {
  /**
   * Register a new user, create their wallet, and assign their virtual account details.
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

      // 2. Create wallet
      const wallet = await WalletService.createWallet(user.id, client);

      // 3. Assign unique bank transfer virtual account (Sterling Bank mock)
      const lastDigits = Math.floor(100000 + Math.random() * 900000); // 6 random digits
      const virtualAccount = `9922${lastDigits}`; // unique virtual account number
      const bankName = 'Sterling Bank';
      const reference = `REF-VA-${user.id.substring(0, 8).toUpperCase()}`;

      await client.query(
        `INSERT INTO funding_references (user_id, virtual_account_number, bank_name, reference)
         VALUES ($1, $2, $3, $4)`,
        [user.id, virtualAccount, bankName, reference]
      );

      await client.query('COMMIT');
      
      console.log(`[AUTH SERVICE] Registered new user ${emailLower}. Assigned Virtual Account: ${virtualAccount}`);
      return { ...user, wallet: { id: wallet.id, balance: wallet.balance }, virtualAccount, bankName, reference };
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

    const wallet = await WalletService.getWalletByUserId(user.id);
    const virtualAccountResult = await db.query(
      'SELECT virtual_account_number, bank_name, reference FROM funding_references WHERE user_id = $1',
      [user.id]
    );
    const va = virtualAccountResult.rows[0] || {};

    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET || 'change-me-to-a-strong-jwt-secret', {
      expiresIn: '24h'
    });

    return {
      access_token: token,
      user: {
        id: user.id,
        email: user.email,
        phone_number: user.phone_number,
        full_name: user.full_name,
        role: user.role,
        balance: wallet ? parseFloat(wallet.balance) : 0,
        is_frozen: wallet ? wallet.is_frozen : false,
        virtual_account_number: va.virtual_account_number,
        bank_name: va.bank_name,
        virtual_reference: va.reference
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

    const wallet = await WalletService.getWalletByUserId(userId);
    const virtualAccountResult = await db.query(
      'SELECT virtual_account_number, bank_name, reference FROM funding_references WHERE user_id = $1',
      [userId]
    );
    const va = virtualAccountResult.rows[0] || {};

    return {
      id: user.id,
      email: user.email,
      phone_number: user.phone_number,
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active,
      created_at: user.created_at,
      balance: wallet ? parseFloat(wallet.balance) : 0,
      is_frozen: wallet ? wallet.is_frozen : false,
      virtual_account_number: va.virtual_account_number,
      bank_name: va.bank_name,
      virtual_reference: va.reference
    };
  }
}
