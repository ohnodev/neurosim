import { useState } from 'react';
import { formatEth, safeAmountWei, shortAddr } from '../lib/utils';

export interface RewardsTableEntry {
  address: string;
  amountWei: string;
  timestamp: string;
  txHash?: string;
}

interface RewardsTableProps {
  history: RewardsTableEntry[];
}

export function RewardsTable({ history }: RewardsTableProps) {
  const [copiedTx, setCopiedTx] = useState<string | null>(null);
  const copyTx = async (txHash: string) => {
    try {
      await navigator.clipboard.writeText(txHash);
      setCopiedTx(txHash);
      setTimeout(() => setCopiedTx(null), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="fly-viewer__rewards-table-wrap">
      <div className="fly-viewer__rewards-table">
        {history.length === 0 && <div style={{ color: '#666', padding: 8 }}>No rewards sent yet</div>}
        {history.slice().reverse().map((entry, i) => (
          <div key={`${entry.address}-${entry.timestamp}-${i}`} className="fly-viewer__rewards-row">
            <span className="fly-viewer__rewards-addr" title={entry.address}>{shortAddr(entry.address)}</span>
            <span className="fly-viewer__rewards-amount">{formatEth(safeAmountWei(entry.amountWei))}</span>
            <span className="fly-viewer__rewards-time" title={entry.timestamp}>
              {new Date(entry.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            {entry.txHash ? (
              <span className="fly-viewer__rewards-actions">
                <button
                  type="button"
                  className="fly-viewer__rewards-action"
                  onClick={() => copyTx(entry.txHash!)}
                  aria-label="Copy tx"
                  title="Copy tx hash"
                >
                  {copiedTx === entry.txHash ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  )}
                </button>
                <a
                  href={`https://basescan.org/tx/${entry.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="fly-viewer__rewards-action"
                  aria-label="View on BaseScan"
                  title="View on BaseScan"
                >
                  <img src="/basescan-logo.svg" alt="" width={12} height={12} />
                </a>
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
