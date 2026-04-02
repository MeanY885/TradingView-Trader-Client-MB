'use client';

import { useState } from 'react';

interface Props {
  mode: string;
  onToggle: (mode: string) => void;
}

export default function ModeToggle({ mode, onToggle }: Props) {
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <span className={`text-sm font-medium ${mode === 'practice' ? 'text-accent' : 'text-muted'}`}>
        Paper
      </span>
      <button
        onClick={() => { mode === 'practice' ? setShowConfirm(true) : onToggle('practice'); }}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          mode === 'live' ? 'bg-red' : 'bg-card-border'
        }`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
          mode === 'live' ? 'translate-x-6' : 'translate-x-1'
        }`} />
      </button>
      <span className={`text-sm font-medium ${mode === 'live' ? 'text-red' : 'text-muted'}`}>
        Live
      </span>
      {showConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-card border border-card-border rounded-lg p-6 max-w-sm mx-4">
            <h3 className="text-lg font-semibold text-red mb-2">Switch to LIVE Trading?</h3>
            <p className="text-sm text-muted mb-4">
              You are switching to LIVE trading. Real money will be used. Make sure your live API key is configured.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 text-sm rounded bg-card-border hover:bg-card-border/80 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowConfirm(false); onToggle('live'); }}
                className="px-4 py-2 text-sm rounded bg-red text-white font-medium hover:bg-red/90 transition-colors"
              >
                Confirm Live
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
