import { NextResponse } from 'next/server';
import { query } from '../../../lib/db';

export async function GET() {
  try {
    const result = await query(
      'SELECT * FROM signal_log ORDER BY created_at DESC LIMIT 200'
    );
    return NextResponse.json({ logs: result.rows });
  } catch (e) {
    console.error('Signals fetch error:', e);
    return NextResponse.json({ error: 'Failed to fetch signals' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { id?: number; all?: boolean };
    if (body.all) {
      await query('DELETE FROM signal_log');
    } else if (body.id) {
      await query('DELETE FROM signal_log WHERE id = $1', [body.id]);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('Signals delete error:', e);
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
  }
}
