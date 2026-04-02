import { NextResponse } from 'next/server';
import { getBroker } from '../../../lib/brokers/factory';
import { getSettings } from '../../../lib/db';

// Returns rates as { base, USD, EUR, JPY, NZD, GBP, XAU } where each value = 1 unit in account currency.
// e.g. for GBP base: USD = 0.79 means $1 = £0.79
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    let ccy = searchParams.get('ccy')?.toUpperCase();
    if (!ccy) {
      const settings = await getSettings();
      ccy = settings.account_currency || 'GBP';
    }

    const broker = await getBroker();

    // Build instrument list needed for each base currency
    // We need rates for: USD, EUR, JPY, NZD, GBP relative to ccy, plus XAU_USD
    const pairSets: Record<string, string[]> = {
      GBP: ['GBP_USD', 'GBP_JPY', 'EUR_GBP', 'GBP_NZD', 'XAU_USD'],
      USD: ['GBP_USD', 'EUR_USD', 'USD_JPY', 'NZD_USD', 'XAU_USD'],
      EUR: ['EUR_USD', 'EUR_GBP', 'EUR_JPY', 'EUR_NZD', 'XAU_USD'],
      JPY: ['GBP_JPY', 'EUR_JPY', 'USD_JPY', 'NZD_JPY', 'XAU_USD'],
      AUD: ['AUD_USD', 'AUD_GBP', 'AUD_JPY', 'AUD_NZD', 'XAU_USD'],
      CAD: ['CAD_USD', 'GBP_CAD', 'USD_CAD', 'CAD_JPY', 'XAU_USD'],
      CHF: ['GBP_CHF', 'EUR_CHF', 'USD_CHF', 'CHF_JPY', 'XAU_USD'],
    };

    const pairs = pairSets[ccy] ?? pairSets['GBP'];
    const results = await broker.getPricingMulti(pairs);

    const map: Record<string, number> = {};
    for (const p of results) {
      map[p.instrument] = (p.ask + p.bid) / 2;
    }

    // Convert: for each currency, how many units of ccy = 1 unit of that currency
    const get = (instrument: string) => map[instrument];
    const inv = (instrument: string) => 1 / map[instrument];

    let rates: Record<string, number>;

    if (ccy === 'GBP') {
      rates = {
        GBP: 1,
        USD: inv('GBP_USD'),
        EUR: get('EUR_GBP'),
        JPY: inv('GBP_JPY'),
        NZD: inv('GBP_NZD'),
        XAU: get('XAU_USD') * inv('GBP_USD'),
      };
    } else if (ccy === 'USD') {
      rates = {
        USD: 1,
        GBP: get('GBP_USD'),
        EUR: get('EUR_USD'),
        JPY: inv('USD_JPY'),
        NZD: get('NZD_USD'),
        XAU: get('XAU_USD'),
      };
    } else if (ccy === 'EUR') {
      rates = {
        EUR: 1,
        USD: inv('EUR_USD'),
        GBP: inv('EUR_GBP'),
        JPY: inv('EUR_JPY'),
        NZD: inv('EUR_NZD'),
        XAU: get('XAU_USD') * inv('EUR_USD'),
      };
    } else if (ccy === 'JPY') {
      rates = {
        JPY: 1,
        GBP: inv('GBP_JPY'),
        EUR: inv('EUR_JPY'),
        USD: inv('USD_JPY'),
        NZD: inv('NZD_JPY'),
        XAU: get('XAU_USD') * inv('USD_JPY'),
      };
    } else {
      // AUD, CAD, CHF — best effort
      rates = { [ccy]: 1, USD: 0, GBP: 0, EUR: 0, JPY: 0, NZD: 0, XAU: 0 };
      // Pick up what we can from the fetched pairs
      for (const [inst, val] of Object.entries(map)) {
        const [base, quote] = inst.split('_');
        if (quote === ccy) rates[base] = val;
        if (base === ccy) rates[quote] = 1 / val;
      }
    }

    return NextResponse.json({ base: ccy, ...rates });
  } catch (e) {
    console.error('FX rates fetch error:', e);
    return NextResponse.json({ error: 'Failed to fetch FX rates' }, { status: 500 });
  }
}
