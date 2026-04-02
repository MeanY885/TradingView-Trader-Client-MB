import { Pool } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('Unexpected pool error', err);
    });
  }
  return pool;
}

export async function query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
  const result = await getPool().query(text, params as unknown[]);
  return result as unknown as { rows: T[] };
}

export async function getSettings(): Promise<Record<string, string>> {
  const result = await query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const settings: Record<string, string> = {};
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

export async function updateSetting(key: string, value: string): Promise<void> {
  await query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, value]
  );
}
