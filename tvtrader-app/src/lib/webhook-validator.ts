import { WebhookSignal } from '../types';

const VALID_ACTIONS = ['buy', 'sell', 'tp1', 'tp2', 'tp3', 'sl', 'exit'];
const INSTRUMENT_WITH_SEP = /^[A-Z]{3}_[A-Z]{3}$/;
const INSTRUMENT_NO_SEP = /^[A-Z]{6}$/;

function normalizeInstrument(raw: string): string | null {
  const upper = raw.toUpperCase().trim();
  if (INSTRUMENT_WITH_SEP.test(upper)) return upper;
  if (INSTRUMENT_NO_SEP.test(upper)) return `${upper.slice(0, 3)}_${upper.slice(3)}`;
  return null;
}

export function validateWebhook(body: unknown): { signal: WebhookSignal | null; error: string | null } {
  if (!body || typeof body !== 'object') return { signal: null, error: 'Invalid payload' };

  const payload = body as Record<string, unknown>;

  if (!payload.action || typeof payload.action !== 'string') return { signal: null, error: 'Missing action' };
  const action = payload.action.toLowerCase();
  if (!VALID_ACTIONS.includes(action)) return { signal: null, error: `Invalid action: ${action}` };

  if (!payload.instrument || typeof payload.instrument !== 'string') return { signal: null, error: 'Missing instrument' };
  const instrument = normalizeInstrument(payload.instrument);
  if (!instrument) return { signal: null, error: `Invalid instrument format: ${payload.instrument}` };

  const signal: WebhookSignal = { action: action as WebhookSignal['action'], instrument };

  if (action === 'buy' || action === 'sell') {
    if (!payload.entry || !payload.tp1 || !payload.sl) {
      return { signal: null, error: 'Buy/sell signals require entry, tp1, and sl' };
    }
    if (isNaN(Number(payload.entry)) || isNaN(Number(payload.tp1)) || isNaN(Number(payload.sl))) {
      return { signal: null, error: 'entry, tp1, sl must be numeric strings' };
    }
    signal.entry = String(payload.entry);
    signal.tp1 = String(payload.tp1);
    signal.sl = String(payload.sl);
  }

  if (action === 'tp1' || action === 'sl') {
    if (payload.entry) signal.entry = String(payload.entry);
    if (payload.tp1) signal.tp1 = String(payload.tp1);
    if (payload.sl) signal.sl = String(payload.sl);
  }

  return { signal, error: null };
}
