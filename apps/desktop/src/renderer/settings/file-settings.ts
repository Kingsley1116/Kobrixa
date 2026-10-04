import { useEffect, useRef, useState } from "react";
import type { FilePreferences } from "../../shared/file-preferences.js";

export interface FilePreferencesState {
  value: FilePreferences | undefined;
  busy: boolean;
  error: boolean;
  change(patch: Partial<FilePreferences>): void;
  retry(): void;
}

/** One App-owned instance keeps file behavior and settings on the same acknowledged values. */
export function useFilePreferences(): FilePreferencesState {
  const [value, setValue] = useState<FilePreferences>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const failed = useRef<Partial<FilePreferences> | undefined>(undefined);

  const load = () => {
    const request = ++generation.current;
    const current = () => mounted.current && request === generation.current;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    void window.kobrixa.workspace
      .getPreferences()
      .then((next) => {
        if (current()) setValue(next);
      })
      .catch(() => {
        if (current()) setError(true);
      })
      .finally(() => {
        if (current()) {
          inFlight.current = false;
          setBusy(false);
        }
      });
  };

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  const change = async (patch: Partial<FilePreferences>) => {
    if (inFlight.current || !mounted.current) return;
    const request = ++generation.current;
    const current = () => mounted.current && request === generation.current;
    const pending = { ...patch };
    inFlight.current = true;
    failed.current = pending;
    setBusy(true);
    setError(false);
    try {
      const next = await window.kobrixa.workspace.setPreferences(pending);
      if (current()) {
        failed.current = undefined;
        setValue(next);
      }
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  return {
    value,
    busy,
    error,
    change: (patch) => {
      void change(patch);
    },
    retry: () => {
      if (inFlight.current || !mounted.current) return;
      if (failed.current) void change(failed.current);
      else load();
    },
  };
}
