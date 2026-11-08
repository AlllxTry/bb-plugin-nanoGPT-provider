import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, describeAttachedFile, readAttachedImage } from "./attachments.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nano-attach-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe("describeAttachedFile", () => {
  it("drops only incomplete UTF-8 at the truncation boundary", async () => {
    const file = write("boundary.txt", "a".repeat(MAX_ATTACHMENT_BYTES - 1) + "é more");
    const text = await describeAttachedFile({ path: file });
    expect(text).not.toContain("�");
    expect(text).toContain("Only the first");
  });

  it.each(["before", "during"])("propagates cancellation %s a read", async (when) => {
    const controller = new AbortController();
    if (when === "before") controller.abort();
    const pending = describeAttachedFile({ path: write("cancelled.txt", "text") }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("detects image MIME from bytes and rejects spoofed or oversized images", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII=", "base64");
    const result = await readAttachedImage({ path: write("image.jpg", png) });
    expect(result.url).toBe(`data:image/png;base64,${png.toString("base64")}`);
    await expect(readAttachedImage({ path: write("fake.png", "not an image") })).rejects.toThrow(/must contain PNG/);
    await expect(readAttachedImage({ path: write("large.png", Buffer.alloc(MAX_IMAGE_BYTES + 1)) })).rejects.toThrow(/exceeds/);
  });

  it("inlines the contents of a small text file under its name", async () => {
    const file = write("hello-123-abc.txt", "The magic word is: ORCHID-42");
    const text = await describeAttachedFile({ path: file, name: "hello.txt" });
    expect(text).toContain('[Attached file "hello.txt"]');
    expect(text).toContain("The magic word is: ORCHID-42");
    expect(text).toContain('[End of attached file "hello.txt"]');
  });

  it("falls back to the file name from the path when no name is given", async () => {
    const file = write("notes.md", "# Notes");
    expect(await describeAttachedFile({ path: file })).toContain(
      '[Attached file "notes.md"]',
    );
  });

  it("keeps non-ASCII text intact", async () => {
    const file = write("utf8.txt", "caf\u00e9 \u4e2d\u6587");
    expect(await describeAttachedFile({ path: file })).toContain("caf\u00e9 \u4e2d\u6587");
  });

  it("sends only the first part of a long file and says so", async () => {
    const file = write("big.txt", "a".repeat(MAX_ATTACHMENT_BYTES + 500));
    const text = await describeAttachedFile({ path: file });
    expect(text).toContain(
      `Only the first ${MAX_ATTACHMENT_BYTES} of ${MAX_ATTACHMENT_BYTES + 500} bytes`,
    );
    expect(text).not.toContain("a".repeat(MAX_ATTACHMENT_BYTES + 1));
    expect(text).not.toContain("[End of attached file");
  });

  it("describes a binary file instead of dumping it", async () => {
    const file = write("blob.bin", Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04]));
    const text = await describeAttachedFile({ path: file });
    expect(text).toContain("is a binary file");
    expect(text).not.toContain("PK");
  });

  it("says so when the file cannot be read, without claiming contents", async () => {
    const text = await describeAttachedFile({
      path: path.join(dir, "missing.txt"),
      name: "missing.txt",
    });
    expect(text).toContain('"missing.txt" could not be read');
    expect(text).toContain("file not found");
    expect(text).toContain("not available to you");
  });

  it("distinguishes a directory from an unavailable file", async () => {
    expect(await describeAttachedFile({ path: dir, name: "folder" })).toContain("not a regular file");
  });

  it("reports an empty file as empty text, not as unreadable", async () => {
    const file = write("empty.txt", "");
    const text = await describeAttachedFile({ path: file });
    expect(text).toContain('[Attached file "empty.txt"]');
    expect(text).toContain('[End of attached file "empty.txt"]');
    expect(text).toContain("(empty file)");
  });
});
