import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
/** Larger files stay in the agent's own tab; a data URI travels whole over the plugin RPC. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * A host image an agent linked in its chat, as a data URI the console can show. Only image
 * files are read: the path comes from agent output.
 */
export async function imageDataUri(reference: string): Promise<string> {
  const path = reference.startsWith("file:") ? fileURLToPath(reference) : reference;
  if (!isAbsolute(path)) throw new Error("Đường dẫn ảnh phải là đường dẫn tuyệt đối.");
  const type = IMAGE_TYPES[extname(path).slice(1).toLowerCase()];
  if (!type) throw new Error("Chỉ hiển thị ảnh png, jpg, gif hoặc webp.");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Không phải file ảnh.");
  if (info.size > MAX_IMAGE_BYTES) throw new Error("Ảnh lớn hơn 8MB; mở trong tab agent.");
  return `data:${type};base64,${(await readFile(path)).toString("base64")}`;
}
