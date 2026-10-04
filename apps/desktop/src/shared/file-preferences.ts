export const FILE_PREFERENCE_CHOICES = {
  externalChangeInterval: [1000, 2000, 5000, 10000],
  localHistoryDays: [7, 30, 90],
  localHistoryVersions: [20, 50, 100, 200],
  localHistorySnapshotMiB: [1, 2, 5, 10],
  localHistoryWorkspaceMiB: [20, 50, 100, 200],
} as const;

export interface FilePreferences {
  externalChangesEnabled: boolean;
  externalChangeInterval: (typeof FILE_PREFERENCE_CHOICES.externalChangeInterval)[number];
  externalChangeAutoReload: boolean;
  localHistoryEnabled: boolean;
  localHistoryDays: (typeof FILE_PREFERENCE_CHOICES.localHistoryDays)[number];
  localHistoryVersions: (typeof FILE_PREFERENCE_CHOICES.localHistoryVersions)[number];
  localHistorySnapshotMiB: (typeof FILE_PREFERENCE_CHOICES.localHistorySnapshotMiB)[number];
  localHistoryWorkspaceMiB: (typeof FILE_PREFERENCE_CHOICES.localHistoryWorkspaceMiB)[number];
}

export const DEFAULT_FILE_PREFERENCES: FilePreferences = {
  externalChangesEnabled: true,
  externalChangeInterval: 2000,
  externalChangeAutoReload: true,
  localHistoryEnabled: true,
  localHistoryDays: 30,
  localHistoryVersions: 50,
  localHistorySnapshotMiB: 2,
  localHistoryWorkspaceMiB: 50,
};
