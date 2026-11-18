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
        "Windows production safety journal unavailable (ENOTSUP); a working native adapter and supported private profile are required for motion acceptance",
        { cause: error },
      );
    throw error;
  }
}
