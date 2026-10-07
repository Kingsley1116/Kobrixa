import type { Locale } from "../i18n/copy.js";
import type { CollabSession } from "./types.js";

/** Room chat. Placeholder until the chat feature lands. */
export function ChatPanel(_props: { session: CollabSession; locale: Locale }): React.JSX.Element {
  return <div className="collab-chat" />;
}
