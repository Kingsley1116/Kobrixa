import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { roomIdSchema } from "@kobrixa/collab-protocol";
import { z } from "zod";
import type { WorkspaceSummary } from "../../shared/api.js";
import type { WorkspaceService } from "../workspace/workspace.js";

/** Guests mirror shared files to `userData/collab/<roomId>/` so builds keep working. */
export const MIRROR_DIRECTORY = "collab";

const projectNameSchema = z.string().max(120);

type MirrorWorkspaces = Pick<WorkspaceService, "openDirectory" | "closeWithin">;

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class CollabMirrors {
  constructor(
    private readonly workspaces: MirrorWorkspaces,
    private readonly userDataPath: () => string,
  ) {}

  /** Resolves (and creates) the mirror base so symlinked userData paths compare correctly. */
  private async base(): Promise<string> {
    const base = path.join(this.userDataPath(), MIRROR_DIRECTORY);
    await mkdir(base, { recursive: true });
    return realpath(base);
  }

  private async target(roomId: unknown): Promise<{ base: string; target: string }> {
    const id = roomIdSchema.parse(roomId);
    const base = await this.base();
    const target = path.join(base, id);
    if (!inside(base, target)) throw new Error("Invalid collaboration mirror path.");
    return { base, target };
  }

  /**
   * Creates (or reuses) the room's mirror folder and opens it as a workspace. No
   * manifest is written here: `kobrixa.json` only appears if the shared document has one.
   */
  async open(roomId: unknown, projectName: unknown): Promise<WorkspaceSummary> {
    projectNameSchema.parse(projectName);
    const { base, target } = await this.target(roomId);
    await mkdir(target, { recursive: true });
    const resolved = await realpath(target);
    if (!inside(base, resolved)) throw new Error("Invalid collaboration mirror path.");
    return this.workspaces.openDirectory(resolved);
  }

  /** Closes any workspace opened on the mirror and deletes the folder. */
  async remove(roomId: unknown): Promise<void> {
    const { base, target } = await this.target(roomId);
    let resolved: string;
    try {
      resolved = await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!inside(base, resolved)) throw new Error("Invalid collaboration mirror path.");
    await this.workspaces.closeWithin(resolved);
    await rm(resolved, { recursive: true, force: true });
  }
}

type Handle = <T extends unknown[], R>(
  channel: string,
  action: (event: unknown, ...args: T) => R,
) => void;

export function registerCollabMirrorIpc(
  handle: Handle,
  workspaces: MirrorWorkspaces,
  userDataPath: () => string,
): CollabMirrors {
  const mirrors = new CollabMirrors(workspaces, userDataPath);
  handle("collab:open-mirror", (_event, roomId: unknown, projectName: unknown) =>
    mirrors.open(roomId, projectName),
  );
  handle("collab:remove-mirror", (_event, roomId: unknown) => mirrors.remove(roomId));
  return mirrors;
}
