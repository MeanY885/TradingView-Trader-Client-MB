import { NextResponse } from 'next/server';
import { getBroker } from '../../../lib/brokers/factory';

export async function GET() {
  try {
    const broker = await getBroker();
    const acct = await broker.getAccountSummary();
    return NextResponse.json({
      balance: acct.balance.toString(),
      nav: acct.nav.toString(),
      unrealizedPL: acct.unrealizedPL.toString(),
      marginAvailable: acct.marginAvailable.toString(),
      marginUsed: acct.marginUsed.toString(),
      currency: acct.currency,
      openTradeCount: acct.openTradeCount,
    });
  } catch (e) {
    console.error('Account fetch error:', e);
    return NextResponse.json({ error: 'Failed to fetch account' }, { status: 500 });
  }
}
