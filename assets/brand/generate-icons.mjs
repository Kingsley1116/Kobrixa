import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "assets/brand/kobrixa-mark.svg");
const webIcons = path.join(root, "apps/web/public/icons");
const desktopIcons = path.join(root, "apps/desktop/resources/icons");

async function renderPng(size, destination) {
  await sharp(source, { density: 144 }).resize(size, size).ensureAlpha().png().toFile(destination);
}

await mkdir(webIcons, { recursive: true });
await mkdir(path.join(desktopIcons, "png"), { recursive: true });
await cp(source, path.join(webIcons, "kobrixa-mark.svg"));

for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  await renderPng(size, path.join(desktopIcons, "png", `${size}x${size}.png`));
}

await renderPng(16, path.join(webIcons, "favicon-16.png"));
await renderPng(32, path.join(webIcons, "favicon-32.png"));
await renderPng(180, path.join(webIcons, "apple-touch-icon.png"));
await renderPng(192, path.join(webIcons, "icon-192.png"));
await renderPng(512, path.join(webIcons, "icon-512.png"));
execFileSync(
  "sips",
  [
    "-s",
    "format",
    "ico",
    path.join(desktopIcons, "png", "256x256.png"),
    "--out",
    path.join(desktopIcons, "kobrixa.ico"),
  ],
  { stdio: "inherit" },
);
await cp(path.join(desktopIcons, "kobrixa.ico"), path.join(webIcons, "favicon.ico"));
execFileSync(
  "sips",
  [
    "-s",
    "format",
    "icns",
    path.join(desktopIcons, "png", "512x512.png"),
    "--out",
    path.join(desktopIcons, "kobrixa.icns"),
  ],
  { stdio: "inherit" },
);
