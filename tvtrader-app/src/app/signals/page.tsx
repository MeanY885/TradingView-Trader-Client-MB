'use client';

import { useState, useEffect } from 'react';
import Header from '../../components/Header';

interface SignalLog {
  id: number;
  action: string;
  instrument: string;
  payload: string;
  result: string;
  success: boolean;
  error: string | null;
  created_at: string;
}

export default function SignalsPage() {
  const [logs, setLogs] = useState<SignalLog[]>([]);

  const load = async () => {
    try {
      const res = await fetch('/api/signals');
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch (e) {
      console.error('Failed to load signals:', e);
    }
  };

  useEffect(() => { load(); }, []);

  const deleteLog = async (id: number) => {
    await fetch('/api/signals', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    load();
  };

  const clearAll = async () => {
    await fetch('/api/signals', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
    load();
  };

  return (
    <>
      <Header />
      <main className="mx-auto px-4 sm:px-6 lg:px-10 2xl:px-16 py-6 lg:py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg lg:text-xl font-semibold">Signal Log</h2>
          {logs.length > 0 && (
            <button onClick={clearAll} className="text-xs text-red hover:text-red/80 transition-colors">Clear All</button>
          )}
        </div>
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          {logs.length === 0 ? (
            <p className="text-muted text-sm text-center py-12">No signals yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted uppercase border-b border-card-border">
                    <th className="text-left py-3 px-4">Time</th>
                    <th className="text-left py-3 px-4">Action</th>
                    <th className="text-left py-3 px-4">Instrument</th>
                    <th className="text-left py-3 px-4">Result</th>
                    <th className="text-left py-3 px-4">Status</th>
                    <th className="text-left py-3 px-4">Error</th>
                    <th className="w-8 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-t border-card-border/30 hover:bg-white/[0.02]">
                      <td className="py-2.5 px-4 text-xs text-muted tabular-nums">
                        {new Date(log.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs">{log.action}</td>
                      <td className="py-2.5 px-4">{log.instrument?.replace('_', '/') || '—'}</td>
                      <td className="py-2.5 px-4 text-xs text-muted">{log.result}</td>
                      <td className="py-2.5 px-4">
                        <span className={`text-xs font-medium ${log.success ? 'text-green' : 'text-red'}`}>
                          {log.success ? 'OK' : 'FAIL'}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-xs text-muted max-w-xs truncate">{log.error || '—'}</td>
                      <td className="py-2.5 text-center">
                        <button onClick={() => deleteLog(log.id)} className="text-muted hover:text-red transition-colors p-0.5" title="Delete">
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
