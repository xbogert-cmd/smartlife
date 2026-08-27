import { useEffect, useState } from 'react';

interface UsageRow {
  providerId: string;
  model: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatCost(n: number): string {
  return `$${n.toFixed(3)}`;
}

export function UsageSection() {
  const [rows, setRows] = useState<UsageRow[] | null>(null);

  useEffect(() => {
    window.smartlife.ai
      .getUsageSummary()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  const totalCost = (rows ?? []).reduce((sum, row) => sum + row.estimatedCostUsd, 0);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        Usage
      </h2>
      {rows === null ? null : rows.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>No usage yet.</p>
      ) : (
        <table className="w-full text-sm" style={{ color: 'var(--color-text)' }}>
          <thead>
            <tr style={{ color: 'var(--color-text-muted)' }}>
              <th className="pb-1 text-left font-normal">Model</th>
              <th className="pb-1 text-right font-normal">Input tokens</th>
              <th className="pb-1 text-right font-normal">Output tokens</th>
              <th className="pb-1 text-right font-normal">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.providerId}:${row.model}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td className="py-1">{row.displayName}</td>
                <td className="py-1 text-right">{formatTokens(row.inputTokens)}</td>
                <td className="py-1 text-right">{formatTokens(row.outputTokens)}</td>
                <td className="py-1 text-right">{formatCost(row.estimatedCostUsd)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid var(--color-border)', fontWeight: 600 }}>
              <td className="py-1">Total</td>
              <td className="py-1" />
              <td className="py-1" />
              <td className="py-1 text-right">{formatCost(totalCost)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
