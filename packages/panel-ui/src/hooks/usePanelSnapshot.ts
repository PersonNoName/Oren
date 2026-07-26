"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSnapshot } from "@/lib/panel-api";
import type { PanelSnapshot } from "@/lib/panel-types";

export function usePanelSnapshot(pollMs = 2000): {
  snapshot: PanelSnapshot | null;
  error: string | null;
  refresh: () => Promise<void>;
  refreshing: boolean;
} {
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    try {
      const data = await fetchSnapshot();
      if (!mountedRef.current) return;
      setSnapshot(data);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current && isManualRefresh) setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await load(true);
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const id = setInterval(() => void load(), pollMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [load, pollMs]);

  return { snapshot, error, refresh, refreshing };
}
