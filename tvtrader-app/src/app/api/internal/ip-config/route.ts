import { NextResponse } from 'next/server';
import { getSettings } from '../../../../lib/db';

export async function GET() {
  try {
    const settings = await getSettings();
    const enabled = settings.ip_whitelist_enabled === 'true';
    let ips: string[] = [];
    try { ips = JSON.parse(settings.ip_whitelist || '[]'); } catch {}
    return NextResponse.json({ enabled, ips });
  } catch {
    return NextResponse.json({ enabled: false, ips: [] });
  }
}
