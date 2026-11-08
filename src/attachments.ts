import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

/** Most bytes of one attached text file that are sent to the model. */
export const MAX_ATTACHMENT_BYTES = 100_000;

/** How many leading bytes are checked for a NUL, which marks a binary file. */
const BINARY_SNIFF_BYTES = 8_000;

interface AttachedFile {
  path: string;
  name?: string | undefined;
}

function displayName(file: AttachedFile): string {
  const raw = file.name !== undefined && file.name !== "" ? file.name : file.path;
  const base = path.basename(raw.replaceAll("\\", "/"));
  return base === "" ? "attachment" : base;
}

/**
 * Turns an attached file into text for the model. NanoGPT models have no file
 * tools in bb, so a bare file name would make a model guess at the contents.
 * Text files are inlined (up to MAX_ATTACHMENT_BYTES); binary, unreadable and
 * over-long files are described honestly instead, so the model can say it
 * cannot see them.
 */
export function describeAttachedFile(file: AttachedFile): string {
  const name = displayName(file);
  let fd: number | null = null;
  try {
    fd = openSync(file.path, "r");
    const size = fstatSync(fd).size;
    const wanted = Math.min(size, MAX_ATTACHMENT_BYTES);
    const buffer = Buffer.alloc(wanted);
    const read = readSync(fd, buffer, 0, wanted, 0);
    const bytes = buffer.subarray(0, read);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return `[Attached file "${name}" is a binary file; its contents are not available to you.]`;
    }
    const text = bytes.toString("utf8");
    const truncated = size > MAX_ATTACHMENT_BYTES;
    return [
      `[Attached file "${name}"]`,
      text,
      truncated
        ? `[Only the first ${MAX_ATTACHMENT_BYTES} of ${size} bytes of "${name}" are shown.]`
        : `[End of attached file "${name}"]`,
    ].join("\n");
  } catch {
    return `[Attached file "${name}" could not be read; its contents are not available to you.]`;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}
