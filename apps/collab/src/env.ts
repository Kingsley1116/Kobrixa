import type { CollabRoom } from "./room.js";

export type CollabEnv = Omit<Env, "ROOMS"> & {
  ROOMS: DurableObjectNamespace<CollabRoom>;
  COLLAB_SECRET?: string;
};
