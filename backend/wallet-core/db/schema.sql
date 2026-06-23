-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Define Enums
DO $$ BEGIN
    CREATE TYPE user_role_enum AS ENUM ('USER', 'ADMIN');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE txn_type_enum AS ENUM ('FUNDING', 'DATA_PURCHASE', 'REFUND');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE txn_status_enum AS ENUM (
        'INITIATED',
        'PENDING_PAYMENT',
        'PAYMENT_RECEIVED',
        'VALIDATING',
        'SUCCESSFUL',
        'FAILED',
        'REVERSED',
        'FLAGGED_FRAUD',
        'MANUAL_REVIEW'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE ledger_entry_type_enum AS ENUM ('DEBIT', 'CREDIT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    phone_number VARCHAR(14) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    password_hash TEXT NOT NULL,
    role user_role_enum NOT NULL DEFAULT 'USER',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);
CREATE INDEX IF NOT EXISTS ix_users_phone_number ON users(phone_number);

-- 2. Wallets Table
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    pin_hash TEXT,
    is_frozen BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0.00)
);

CREATE INDEX IF NOT EXISTS ix_wallets_user_id ON wallets(user_id);

-- 3. Transactions Table (State Machine Bound)
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    type txn_type_enum NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    status txn_status_enum NOT NULL DEFAULT 'INITIATED',
    reference VARCHAR(255) UNIQUE NOT NULL,
    recipient_phone VARCHAR(14),
    network VARCHAR(20),
    plan_code VARCHAR(100),
    narration TEXT,
    provider_response JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_transactions_amount_positive CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS ix_transactions_reference ON transactions(reference);
CREATE INDEX IF NOT EXISTS ix_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS ix_transactions_created_at ON transactions(created_at);

-- 4. Immutable Ledger Entries (Double-Entry Bookkeeping)
CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    wallet_id UUID REFERENCES wallets(id) ON DELETE SET NULL, -- Null for system-wide asset/liability accounts
    account_type VARCHAR(50) NOT NULL, -- 'user_wallet', 'system_bank_asset', 'system_revenue'
    type ledger_entry_type_enum NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS ix_ledger_transaction_id ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS ix_ledger_wallet_id ON ledger_entries(wallet_id);
CREATE INDEX IF NOT EXISTS ix_ledger_created_at ON ledger_entries(created_at);

-- 5. Funding References
CREATE TABLE IF NOT EXISTS funding_references (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    virtual_account_number VARCHAR(50) NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    reference VARCHAR(255) UNIQUE NOT NULL,
    amount NUMERIC(12, 2),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_funding_references_ref ON funding_references(reference);
CREATE INDEX IF NOT EXISTS ix_funding_references_user ON funding_references(user_id);

-- 6. Webhook Logs
CREATE TABLE IF NOT EXISTS webhook_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider VARCHAR(50) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    signature TEXT NOT NULL,
    status VARCHAR(50) NOT NULL, -- 'PROCESSED', 'FAILED', 'IGNORED'
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_webhook_logs_created_at ON webhook_logs(created_at);

-- 7. Admin Overrides
CREATE TABLE IF NOT EXISTS admin_overrides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL,
    type ledger_entry_type_enum NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8. Fraud Flags
CREATE TABLE IF NOT EXISTS fraud_flags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    rule_triggered VARCHAR(255) NOT NULL,
    details JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'RESOLVED'
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_fraud_flags_user_id ON fraud_flags(user_id);

-- 9. Transaction Status History (Audit Trail)
CREATE TABLE IF NOT EXISTS transaction_status_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    from_status txn_status_enum,
    to_status txn_status_enum NOT NULL,
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL, -- Null if system
    remarks TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_status_history_txn_id ON transaction_status_history(transaction_id);
