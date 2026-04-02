import { NextResponse } from 'next/server';
import { validateWebhook } from '../../../lib/webhook-validator';
import { handleBuySell, handleTpSl, handleExit } from '../../../lib/trade-manager';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { signal, error } = validateWebhook(body);
    if (!signal) {
      return NextResponse.json({ success: false, error }, { status: 400 });
    }

    let result: { success: boolean; message: string };

    switch (signal.action) {
      case 'buy':
      case 'sell':
        result = await handleBuySell(signal);
        break;
      case 'tp1':
      case 'tp2':
      case 'tp3':
      case 'sl':
        result = await handleTpSl(signal);
        break;
      case 'exit':
        result = await handleExit(signal);
        break;
      default:
        return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
    }

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (e) {
    console.error('Webhook error:', e);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
