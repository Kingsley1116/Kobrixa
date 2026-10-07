import { net } from "electron";
import { loadCollabPreferences } from "./preferences.js";
import { CollabService } from "./service.js";
import { CollabTokenStore, removeLegacyTokenFiles } from "./tokens.js";

/** Production wiring: Electron's network stack and process-local room credentials. */
export async function createCollabService(
  userData: string,
  serverUrl: string,
): Promise<CollabService> {
  await removeLegacyTokenFiles(userData);
  return new CollabService({
    serverUrl,
    preferences: await loadCollabPreferences(userData),
    tokens: new CollabTokenStore(),
    fetch: (url, init) => net.fetch(url, init),
  });
}
