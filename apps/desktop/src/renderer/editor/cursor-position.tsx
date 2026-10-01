import { useSyncExternalStore } from "react";
import type { CursorStore } from "./documents.js";

export function CursorPosition({
  store,
  lineLabel,
  columnLabel,
}: {
  store: CursorStore;
  lineLabel: string;
  columnLabel: string;
}): React.JSX.Element {
  const cursor = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <span>
      {lineLabel} {cursor.line}, {columnLabel} {cursor.column}
    </span>
  );
}
