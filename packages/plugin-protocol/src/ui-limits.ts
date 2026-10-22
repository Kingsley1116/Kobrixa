export const UI_RESOURCE_VERSION = 1 as const;
export const UI_LIMITS_V1 = Object.freeze({
  resourceBytes: 262144, sourceBytes: 1048576, hostBytes: 8388608,
  nodes: 256, depth: 8, dataSlots: 64, fields: 32,
  stringCodePoints: 4000, labelCodePoints: 200, enumValues: 32, enumCodePoints: 128,
  conditionDepth: 4, conditionNodes: 32, resourceConditionNodes: 256,
  sourcePanels: 4, sourceStatus: 2, hostPanels: 16, hostStatus: 16,
  dataBytes: 65536, formBytes: 16384, statusDataBytes: 16384,
  patchBytes: 65536, patchEntries: 64, patchesPerSecond: 10, pendingPatches: 4,
  argumentBytes: 16384, invokeBytes: 65536, resultBytes: 16384,
  sourcePending: 16, hostPending: 256, sourceSubscriptions: 32,
  eventBytes: 65536, queueBytes: 262144, controlSlots: 8, controlBytes: 16384,
  activeHolds: 1, challengeMs: 100, expiryMs: 350, pendingChallenges: 4,
  sourceReadMs: 5000, initializeMs: 10000, commandMs: 30000,
  queryMs: 5000, shutdownRequestMs: 2000, cursorMs: 30000,
  catalogEntries: 16, catalogBytes: 262144, resourceReplyBytes: 524288,
  detailBytes: 4096, completedInvocations: 64, invocationRetentionMs: 30000,
  hostCompletedInvocations: 256, hostCompletedBytes: 4194304,
} as const);
