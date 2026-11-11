import type { JournalFilesystem } from "../../apps/desktop/src/main/device-broker/journal-filesystem.js";

// Probe the same production filesystem before journal.load() absorbs initialization
// errors into journalHealth=unwritable. Never substitute a successful barrier.
export async function requireMotionJournalFilesystem(
  filesystem: Pick<JournalFilesystem, "initialize">,
  platform = process.platform,
) {
  try {
    await filesystem.initialize();
  } catch (error) {
    if (platform === "win32" && (error as NodeJS.ErrnoException)?.code === "ENOTSUP")
      throw new Error(
        "blocked-by-W02b: production safety journal directory durability barrier returned ENOTSUP; motion cannot dispatch until the verified Windows native journal adapter is integrated",
        { cause: error },
      );
    throw error;
  }
}
