import type { Locale } from "../i18n/copy.js";
import type { CollabApi } from "../../shared/collab.js";
import type { CollabStore } from "./store.js";

/**
 * Room lobby and participant management: create/join, invite code, roster,
 * connection status. Placeholder until the collaboration panel UI lands.
 */
export function CollabPanel({
  locale,
}: {
  store: CollabStore;
  api: CollabApi;
  locale: Locale;
}): React.JSX.Element {
  return (
    <p className="collab-placeholder">
      {locale === "zh-TW" ? "多人協作即將推出。" : "Collaboration is coming soon."}
    </p>
  );
}
