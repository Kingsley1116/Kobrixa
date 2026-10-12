import fs from "node:fs/promises";
import path from "node:path";

// Capture the entire application in a large window; never crop to a panel.
export async function captureReadmeWindow({ js, win, temporary }, name) {
  const originalSize = win.getSize();
  win.setSize(1600, 1000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const viewport = await js("({ width: outerWidth, height: outerHeight })");
  if (viewport.width !== 1600 || viewport.height !== 1000)
    throw new Error(`README window has unexpected dimensions: ${JSON.stringify(viewport)}`);
  await fs.writeFile(path.join(temporary, name), (await win.webContents.capturePage()).toPNG());
  win.setSize(...originalSize);
  await new Promise((resolve) => setTimeout(resolve, 300));
}
