import { useCallback, useEffect, useState } from 'react';
import type { AssignmentDetail, SubmitInput, SubmitOutcome } from './types';

export function useAssignment(id: number) {
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const next = (await window.smartlife.canvas.getAssignment(id)) as AssignmentDetail | null;
    setDetail(next);
    setLoaded(true);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = (await window.smartlife.canvas.getAssignment(id)) as AssignmentDetail | null;
      // Guard against a slow fetch resolving after the route changed id.
      if (cancelled) return;
      setDetail(next);
      setLoaded(true);
    })().catch(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const submit = useCallback(
    async (input: SubmitInput): Promise<SubmitOutcome> => {
      setSubmitting(true);
      setOutcome(null);
      try {
        const result = (await window.smartlife.canvas.submit(id, input)) as SubmitOutcome;
        setOutcome(result);
        // Re-read regardless of ok: the row may have moved either way.
        await reload();
        return result;
      } finally {
        setSubmitting(false);
      }
    },
    [id, reload]
  );

  return { detail, loaded, submitting, outcome, reload, submit };
}
