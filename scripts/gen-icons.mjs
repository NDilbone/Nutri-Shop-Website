import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const master = path.join(root, "assets", "icon-master.svg");
const outDir = path.join(root, "public", "icons");
const BG = "#0f1411";

if (!existsSync(master)) {
  console.error(`Missing master art: ${master}`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

const from = () => sharp(master, { density: 512 });

// "any" icons (contained on the brand background).
for (const size of [192, 512]) {
  await from()
    .resize(size, size, { fit: "contain", background: BG })
    .flatten({ background: BG })
    .png()
    .toFile(path.join(outDir, `icon-${size}.png`));
}

// Apple touch (opaque, no transparency).
await from()
  .resize(180, 180, { fit: "contain", background: BG })
  .flatten({ background: BG })
  .png()
  .toFile(path.join(outDir, "apple-touch-icon-180.png"));

// Maskable: master in the inner 80% safe zone on a solid 512 canvas.
const inner = Math.round(512 * 0.8);
const masked = await from()
  .resize(inner, inner, { fit: "contain", background: BG })
  .png()
  .toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
  .composite([{ input: masked, gravity: "center" }])
  .png()
  .toFile(path.join(outDir, "icon-maskable-512.png"));

console.log("Generated public/icons: icon-192, icon-512, icon-maskable-512, apple-touch-icon-180");
