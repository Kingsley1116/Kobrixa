import { useEffect, useRef, useState } from "react";
import type { DevicePreferences } from "../../shared/device-preferences.js";

export function useDevicePreferences() {
  const [value, setValue] = useState<DevicePreferences>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const failed = useRef<Partial<DevicePreferences> | undefined>(undefined);
  const mounted = useRef(false);
  const generation = useRef(0);
  const load = () => {
    const request = ++generation.current;
    const current = () => mounted.current && request === generation.current;
    setError(false);
    setBusy(true);
    inFlight.current = true;
    void window.kobrixa.device
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
  const change = async (patch: Partial<DevicePreferences>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    failed.current = patch;
    try {
      const next = await window.kobrixa.device.setPreferences(patch);
      failed.current = undefined;
      if (mounted.current) setValue(next);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return {
    value,
    busy,
    error,
    change: (patch: Partial<DevicePreferences>) => {
      void change(patch);
    },
    retry: () => {
      if (failed.current) void change(failed.current);
      else load();
    },
  };
}
