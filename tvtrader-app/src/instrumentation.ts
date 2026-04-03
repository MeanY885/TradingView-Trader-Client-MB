/**
 * instrumentation.ts
 *
 * Next.js server instrumentation — runs once on server start in the Node.js runtime.
 * Creates all database tables on first boot (self-bootstrapping), then runs any
 * column migrations needed for older deployments, then starts the trade poller.
 */

async function runSchemaSetup() {
  const { query } = await import('./lib/db');

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   VARCHAR(50) PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS trades (
      id                  SERIAL PRIMARY KEY,
      broker_trade_id     VARCHAR(50)  NOT NULL,
      broker              VARCHAR(30)  NOT NULL DEFAULT 'oanda',
      instrument          VARCHAR(20)  NOT NULL,
      direction           VARCHAR(4)   NOT NULL,
      units               VARCHAR(30)  NOT NULL,
      entry_price         VARCHAR(20)  NOT NULL,
      signal_entry        VARCHAR(20)  NOT NULL,
      tp_price            VARCHAR(20)  NOT NULL,
      sl_price            VARCHAR(20)  NOT NULL,
      spread_at_entry     VARCHAR(20),
      status              VARCHAR(20)  NOT NULL DEFAULT 'open',
      close_price         VARCHAR(20),
      realized_pl         VARCHAR(20),
      closed_at           TIMESTAMPTZ,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      slippage_pips       VARCHAR(20),
      highest_price       VARCHAR(20),
      lowest_price        VARCHAR(20),
      highest_price_time  TIMESTAMPTZ,
      lowest_price_time   TIMESTAMPTZ,
      notional_account_ccy TEXT,
      leverage_used       INTEGER,
      peak_tracking_done  BOOLEAN NOT NULL DEFAULT false
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS signal_log (
      id          SERIAL PRIMARY KEY,
      action      VARCHAR(30)  NOT NULL,
      instrument  VARCHAR(20),
      payload     JSONB        NOT NULL,
      result      VARCHAR(50)  NOT NULL,
      success     BOOLEAN      NOT NULL DEFAULT true,
      error       TEXT,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id                   SERIAL PRIMARY KEY,
      user_id              INTEGER,
      "timestamp"          TIMESTAMP    NOT NULL,
      raw_payload          TEXT         NOT NULL,
      source_ip            VARCHAR(50),
      broker               VARCHAR(20)  NOT NULL,
      symbol               VARCHAR(20),
      original_symbol      VARCHAR(20),
      action               VARCHAR(10),
      order_type           VARCHAR(20),
      quantity             DOUBLE PRECISION,
      price                DOUBLE PRECISION,
      stop_loss            DOUBLE PRECISION,
      take_profit          DOUBLE PRECISION,
      trailing_stop_pct    DOUBLE PRECISION,
      leverage             DOUBLE PRECISION,
      metadata_json        TEXT,
      trade_group_id       VARCHAR(50),
      trade_direction      VARCHAR(10),
      tp_level             VARCHAR(10),
      position_size_after  DOUBLE PRECISION,
      entry_price          DOUBLE PRECISION,
      realized_pnl_percent DOUBLE PRECISION,
      realized_pnl_absolute DOUBLE PRECISION,
      current_stop_loss    DOUBLE PRECISION,
      current_take_profit  DOUBLE PRECISION,
      exit_trail_price     DOUBLE PRECISION,
      exit_trail_offset    DOUBLE PRECISION,
      sl_changed           BOOLEAN,
      tp_changed           BOOLEAN,
      status               VARCHAR(20)  NOT NULL,
      broker_order_id      VARCHAR(50),
      client_order_id      VARCHAR(32),
      error_message        TEXT,
      created_at           TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id                          SERIAL PRIMARY KEY,
      email                       VARCHAR(255) NOT NULL,
      username                    VARCHAR(100) NOT NULL,
      password_hash               VARCHAR(255) NOT NULL,
      webhook_token               VARCHAR(64)  NOT NULL,
      role                        VARCHAR(20),
      is_active                   BOOLEAN,
      webhook_ip_whitelist_enabled BOOLEAN,
      webhook_ip_whitelist        TEXT,
      created_at                  TIMESTAMP,
      updated_at                  TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      id                    SERIAL PRIMARY KEY,
      user_id               INTEGER      NOT NULL,
      broker                VARCHAR(20)  NOT NULL,
      api_key_encrypted     TEXT         NOT NULL,
      secret_key_encrypted  TEXT,
      passphrase_encrypted  TEXT,
      account_id_encrypted  TEXT,
      is_active             BOOLEAN,
      label                 VARCHAR(100),
      created_at            TIMESTAMP,
      updated_at            TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS symbol_configs (
      id                    SERIAL PRIMARY KEY,
      user_id               INTEGER      NOT NULL,
      symbol                VARCHAR(20)  NOT NULL,
      broker                VARCHAR(20)  NOT NULL,
      tp_count              INTEGER,
      sl_count              INTEGER,
      display_name          VARCHAR(50),
      position_size_type    VARCHAR(10),
      position_size_value   DOUBLE PRECISION,
      margin_allocation_pct DOUBLE PRECISION,
      profit_exit_target    DOUBLE PRECISION,
      is_active             BOOLEAN,
      created_at            TIMESTAMP,
      updated_at            TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function runMigrations() {
  const { query } = await import('./lib/db');
  // Safety nets for deployments that pre-date runSchemaSetup
  await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS leverage_used integer`);
  await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS peak_tracking_done boolean NOT NULL DEFAULT false`);

  // Multi-broker migration: rename oanda_trade_id → broker_trade_id, add broker column
  // Also rename notional_gbp → notional_account_ccy for clarity
  const colCheck = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'oanda_trade_id'`
  );
  if (colCheck.rows.length > 0) {
    await query(`ALTER TABLE trades RENAME COLUMN oanda_trade_id TO broker_trade_id`);
  }
  await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS broker VARCHAR(30) NOT NULL DEFAULT 'oanda'`);

  const notionalCheck = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'notional_gbp'`
  );
  if (notionalCheck.rows.length > 0) {
    await query(`ALTER TABLE trades RENAME COLUMN notional_gbp TO notional_account_ccy`);
  } else {
    await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS notional_account_ccy text`);
  }

  await query(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS broker VARCHAR(30) DEFAULT 'oanda'`);
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await runSchemaSetup();
    await runMigrations();
    // Pre-warm the broker adapter (connects if needed, e.g. IB keepalive)
    const { getBroker } = await import('./lib/brokers/factory');
    await getBroker().catch((e) => console.error('[STARTUP] Broker init error:', e));
    const { startTradePoller } = await import('./lib/trade-poller');
    startTradePoller();
  }
}
