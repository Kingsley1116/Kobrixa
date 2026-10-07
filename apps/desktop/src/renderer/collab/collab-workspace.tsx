import { useState, useSyncExternalStore } from "react";
import { TabList } from "../components/tab-list.js";
import type { Locale } from "../i18n/copy.js";
import type { CollabApi } from "../../shared/collab.js";
import type { CollabStore } from "./store.js";
import { CollabPanel } from "./collab-panel.js";
import { ChatPanel } from "./chat-panel.js";

type CollabView = "people" | "chat";

/** Content of the "Collaborate" tool tab. Chat is available only inside a room. */
export function CollabWorkspace({
  store,
  api,
  locale,
}: {
  store: CollabStore;
  api: CollabApi;
  locale: Locale;
}): React.JSX.Element {
  const zh = locale === "zh-TW";
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [view, setView] = useState<CollabView>("people");
  const current: CollabView = session ? view : "people";
  return (
    <div className="collab-workspace">
      {session && (
        <TabList<CollabView>
          className="collab-subtabs"
          variant="compact"
          label={zh ? "協作工具" : "Collaboration tools"}
          value={current}
          onChange={setView}
          tabs={(["people", "chat"] as const).map((value) => ({
            value,
            id: `collab-view-${value}`,
            panelId: `collab-page-${value}`,
            label: value === "people" ? (zh ? "成員" : "People") : zh ? "聊天" : "Chat",
          }))}
        />
      )}
      <div
        id="collab-page-people"
        role="tabpanel"
        aria-labelledby="collab-view-people"
        hidden={current !== "people"}
      >
        <CollabPanel store={store} api={api} locale={locale} />
      </div>
      {session && (
        <div
          id="collab-page-chat"
          role="tabpanel"
          aria-labelledby="collab-view-chat"
          hidden={current !== "chat"}
        >
          <ChatPanel session={session} locale={locale} />
        </div>
      )}
    </div>
  );
}
