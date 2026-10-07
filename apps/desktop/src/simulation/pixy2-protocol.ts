import type { Pixy2Block } from "../shared/simulator.js";

/**
 * Pixy2's LEGO I2C register interface, in original unsigned wire order.
 * Reference: charmedlabs/pixy2 src/device/main_m4/src/serial.cpp, lego_getData.
 * Blocks are already scaled to LEGO's 0..255 image coordinates by the world.
 * Their order is descending native image area, with deterministic ties.
 */
export class Pixy2Protocol {
  private lampEnabled = false;

  get lamp(): boolean {
    return this.lampEnabled;
  }

  exchange(request: readonly number[], readBytes: number, blocks: readonly Pixy2Block[]): number[] {
    if (!Number.isInteger(readBytes) || readBytes < 0 || readBytes > 32)
      throw new Error("Pixy2 I2C read length must be an integer from 0 through 32.");
    if (
      request.length < 1 ||
      request.length > 31 ||
      request.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    )
      throw new Error("Pixy2 I2C requests must contain 1–31 unsigned bytes.");

    const register = request[0]!;
    const label = `0x${register.toString(16).padStart(2, "0")}`;
    if (register === 0x62) {
      if (request.length !== 2 || readBytes > 1)
        throw new Error("Pixy2 lamp register 0x62 requires one data byte and returns one byte.");
      this.lampEnabled = request[1] !== 0;
      return readBytes === 0 ? [] : [1];
    }
    if (
      register !== 0 &&
      register !== 8 &&
      register !== 16 &&
      register !== 0x42 &&
      register !== 0x60 &&
      (register < 0x50 || register > 0x57)
    )
      throw new Error(
        `Pixy2 register ${label} is unavailable in the local simulator. Only LEGO I2C single-signature CCC, identity, port view and lamp commands are supported; color codes, line tracking, RGB and standard Pixy2 packets are not simulated.`,
      );
    if (request.length !== 1 || readBytes === 0)
      throw new Error(`Pixy2 register ${label} is read-only and takes no data bytes.`);

    const largest = blocks[0];
    let reply: number[];
    if (register === 0)
      reply = [86, 48, 46, 52, 0]; // "V0.4\0"
    else if (register === 8 || register === 16)
      reply = [80, 105, 120, 121, 50, 0]; // "Pixy2\0"
    else if (register === 0x42) reply = [largest?.x ?? 0];
    else if (register === 0x60)
      reply = [0]; // Single signatures do not have a color-code angle.
    else if (register === 0x50)
      reply = largest
        ? [largest.signature & 255, largest.signature >> 8, ...this.bounds(largest)]
        : [0, 0, 0, 0, 0, 0];
    else {
      const matching = blocks.filter((block) => block.signature === register - 0x50);
      reply = matching[0]
        ? [Math.min(255, matching.length), ...this.bounds(matching[0])]
        : [0, 0, 0, 0, 0];
    }
    // Partial reads expose a prefix. Extra bytes have no specified firmware value;
    // reject them rather than fabricate padding or adjacent-register contents.
    if (readBytes > reply.length)
      throw new Error(`Pixy2 register ${label} returns ${reply.length} bytes, not ${readBytes}.`);
    return reply.slice(0, readBytes);
  }

  private bounds(block: Pixy2Block): number[] {
    return [block.x, block.y, block.width, block.height];
  }
}
