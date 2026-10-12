import { useLayoutEffect, useRef } from "react";
import type { Theme } from "../settings/theme.js";

export function useWindowChrome(theme: Theme) {
  const ref = useRef<HTMLElement>(null);
  const chrome = window.kobrixa?.windowChrome;
  useLayoutEffect(() => {
    const toolbar = ref.current;
    if (!toolbar || !chrome) return;
    let previousHeight = 0;
    const update = () => {
      const height = Math.ceil(toolbar.getBoundingClientRect().height);
      if (height < 1 || height === previousHeight) return;
      previousHeight = height;
      // A queued update may lose its renderer while the window is closing.
      void chrome.setAppearance({ theme, height }).catch(() => undefined);
    };
    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    update();
    return () => observer.disconnect();
  }, [chrome, theme]);
  return { ref, hasWindowControls: Boolean(chrome) };
}
