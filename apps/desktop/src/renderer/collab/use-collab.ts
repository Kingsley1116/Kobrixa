import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CollabStore } from "./store.js";
import type { CollabSession, CollabSessionSnapshot } from "./types.js";
import { mergeRoster, type RosterEntry } from "./roster.js";

const noSubscription = (): (() => void) => () => undefined;
const noSnapshot = (): null => null;

export function useCollabSession(store: CollabStore): CollabSession | null {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useSessionSnapshot(session: CollabSession | null): CollabSessionSnapshot | null {
  return useSyncExternalStore(
    session ? session.subscribe : noSubscription,
    session ? session.getSnapshot : noSnapshot,
  );
}

/** Increments whenever any awareness state of `session` changes. */
function useAwarenessVersion(session: CollabSession | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!session) return;
    const changed = (): void => setVersion((value) => value + 1);
    session.awareness.on("change", changed);
    return () => session.awareness.off("change", changed);
  }, [session]);
  return version;
}

/** Server roster merged with live awareness presence; empty without a session. */
export function useRoster(
  session: CollabSession | null,
  snapshot: CollabSessionSnapshot | null,
): RosterEntry[] {
  const version = useAwarenessVersion(session);
  return useMemo(
    () =>
      session && snapshot
        ? mergeRoster(
            snapshot.participants,
            session.awareness.getStates().values(),
            session.connection.participantId,
          )
        : [],
    // `version` tracks awareness changes, which mutate the states map in place.
    [session, snapshot, version],
  );
}
