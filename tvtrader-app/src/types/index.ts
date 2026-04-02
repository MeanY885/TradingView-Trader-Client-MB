export interface WebhookSignal {
  action: 'buy' | 'sell' | 'tp1' | 'tp2' | 'tp3' | 'sl' | 'exit';
  instrument: string;
  entry?: string;
  tp1?: string;
  sl?: string;
}

export interface Trade {
  id: number;
  broker_trade_id: string;
  broker: string;
  instrument: string;
  direction: 'buy' | 'sell';
  units: string;
  entry_price: string;
  signal_entry: string;
  tp_price: string;
  sl_price: string;
  spread_at_entry: string;
  slippage_pips: string;
  status: 'open' | 'tp_hit' | 'sl_hit' | 'exited' | 'exited_no_tp' | 'exited_no_sl';
  peak_tracking_done: boolean;
  highest_price: string | null;
  lowest_price: string | null;
  highest_price_time: string | null;
  lowest_price_time: string | null;
  peak_pl?: string | null;
  trough_pl?: string | null;
  profit_exit_price?: string | null;
  effective_profit_target?: string | null;
  loss_exit_price?: string | null;
  effective_loss_target?: string | null;
  realized_pl: string | null;
  close_price: string | null;
  closed_at: string | null;
  created_at: string;
  notional_account_ccy: string | null;
  leverage_used: number | null;
}

export interface AppSettings {
  trading_mode: string;
  risk_pct_EUR_USD: string;
  risk_pct_XAU_USD: string;
  risk_pct_NZD_JPY: string;
  profit_target_EUR_USD: string;
  profit_target_XAU_USD: string;
  profit_target_NZD_JPY: string;
  loss_target_EUR_USD: string;
  loss_target_XAU_USD: string;
  loss_target_NZD_JPY: string;
  enabled_EUR_USD: string;
  enabled_XAU_USD: string;
  enabled_NZD_JPY: string;
  leverage: string;
  max_slippage_pips: string;
  max_slippage_pips_EUR_USD: string;
  max_slippage_pips_XAU_USD: string;
  max_slippage_pips_NZD_JPY: string;
  practice_api_key?: string;
  live_api_key?: string;
  practice_account_id: string;
  live_account_id: string;
  hasPracticeKey?: boolean;
  hasLiveKey?: boolean;
  risk_percentage?: string;
  account_currency?: string;
  webhook_domain?: string;
  ip_whitelist_enabled?: string;
  ip_whitelist?: string;
}
