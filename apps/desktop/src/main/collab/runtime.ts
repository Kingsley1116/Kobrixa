import { net, safeStorage } from "electron";
import { loadCollabPreferences } from "./preferences.js";
import { CollabService } from "./service.js";
import { CollabTokenStore } from "./tokens.js";

/** Production wiring: Electron's network stack (system proxy/certificates) and OS keychain. */
export async function createCollabService(
  userData: string,
  serverUrl: string,
): Promise<CollabService> {
  return new CollabService({
    serverUrl,
    preferences: await loadCollabPreferences(userData),
    tokens: new CollabTokenStore(userData, safeStorage),
    fetch: (url, init) => net.fetch(url, init),
  });
}
