// Synthetic PE-shaped bytes for portable packaging tests, never a runnable addon.
export function journalFixture(arch = "x64", hooks = false) {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80);
  bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 0x84);
  bytes.write("capabilities\0durableReplace\0syncDirectory\0", 0x100);
  if (hooks) bytes.write("replaceCandidate\0", 0x180);
  return bytes;
}
