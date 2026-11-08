import { open } from "node:fs/promises";
import path from "node:path";

export const MAX_ATTACHMENT_BYTES = 100_000;
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_TOTAL_IMAGE_BYTES = 10_000_000;
const BINARY_SNIFF_BYTES = 8_000;

interface AttachedFile { path: string; name?: string | undefined }

function displayName(file: AttachedFile): string {
  const raw = file.name || file.path;
  return path.basename(raw.replaceAll("\\", "/")) || "attachment";
}

async function readBounded(file: AttachedFile, limit: number, signal?: AbortSignal): Promise<{ bytes: Buffer; size: number }> {
  signal?.throwIfAborted();
  const handle = await open(file.path, "r");
  try {
    signal?.throwIfAborted();
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error("Attachment is not a regular file."), { code: "ENOTFILE" });
    const buffer = Buffer.alloc(Math.min(stat.size, limit + 1));
    let read = 0;
    while (read < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, read, buffer.length - read, read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    signal?.throwIfAborted();
    return { bytes: buffer.subarray(0, read), size: stat.size };
  } finally {
    await handle.close();
  }
}

/** Read only the staged attachment supplied by the host, with a strict byte cap. */
export async function describeAttachedFile(file: AttachedFile, signal?: AbortSignal): Promise<string> {
  const name = displayName(file);
  try {
    const { bytes: raw, size } = await readBounded(file, MAX_ATTACHMENT_BYTES, signal);
    const bytes = raw.subarray(0, MAX_ATTACHMENT_BYTES);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return `[Attached file "${name}" is a binary file; its contents are not available to you.]`;
    }
    const truncated = size > MAX_ATTACHMENT_BYTES || raw.length > MAX_ATTACHMENT_BYTES;
    const text = new TextDecoder().decode(bytes, { stream: truncated });
    return [
      `[Attached file "${name}"]`, text || "(empty file)",
      truncated ? `[Only the first ${MAX_ATTACHMENT_BYTES} of ${size} bytes of "${name}" are shown.]` : `[End of attached file "${name}"]`,
    ].join("\n");
  } catch (error) {
    signal?.throwIfAborted();
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const reason = code === "ENOENT" ? "file not found"
      : code === "EACCES" || code === "EPERM" ? "permission denied"
      : code === "ENOTFILE" || code === "EISDIR" ? "not a regular file"
      : code === "EMFILE" || code === "ENFILE" ? "too many open files"
      : code === "EIO" || code === "ENOSPC" ? "filesystem I/O error" : "unexpected read error";
    return `[Attached file "${name}" could not be read (${reason}); its contents are not available to you.]`;
  }
}

export async function readAttachedImage(file: AttachedFile, signal?: AbortSignal): Promise<{ url: string; byteLength: number }> {
  const { bytes, size } = await readBounded(file, MAX_IMAGE_BYTES, signal);
  if (size > MAX_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Attached image "${displayName(file)}" exceeds the ${MAX_IMAGE_BYTES}-byte limit.`);
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")) ? "image/gif"
    : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;
  if (mime === null) throw new Error(`Attached image "${displayName(file)}" must contain PNG, JPEG, GIF or WebP data.`);
  return { url: `data:${mime};base64,${bytes.toString("base64")}`, byteLength: bytes.length };
}
