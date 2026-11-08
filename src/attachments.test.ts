import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, describeAttachedFile } from "./attachments.js";

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
  it("inlines the contents of a small text file under its name", () => {
    const file = write("hello-123-abc.txt", "The magic word is: ORCHID-42");
    const text = describeAttachedFile({ path: file, name: "hello.txt" });
    expect(text).toContain('[Attached file "hello.txt"]');
    expect(text).toContain("The magic word is: ORCHID-42");
    expect(text).toContain('[End of attached file "hello.txt"]');
  });

  it("falls back to the file name from the path when no name is given", () => {
    const file = write("notes.md", "# Notes");
    expect(describeAttachedFile({ path: file })).toContain(
      '[Attached file "notes.md"]',
    );
  });

  it("keeps non-ASCII text intact", () => {
    const file = write("utf8.txt", "caf\u00e9 \u4e2d\u6587");
    expect(describeAttachedFile({ path: file })).toContain("caf\u00e9 \u4e2d\u6587");
  });

  it("sends only the first part of a long file and says so", () => {
    const file = write("big.txt", "a".repeat(MAX_ATTACHMENT_BYTES + 500));
    const text = describeAttachedFile({ path: file });
    expect(text).toContain(
      `Only the first ${MAX_ATTACHMENT_BYTES} of ${MAX_ATTACHMENT_BYTES + 500} bytes`,
    );
    expect(text).not.toContain("a".repeat(MAX_ATTACHMENT_BYTES + 1));
    expect(text).not.toContain("[End of attached file");
  });

  it("describes a binary file instead of dumping it", () => {
    const file = write("blob.bin", Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04]));
    const text = describeAttachedFile({ path: file });
    expect(text).toContain("is a binary file");
    expect(text).not.toContain("PK");
  });

  it("says so when the file cannot be read, without claiming contents", () => {
    const text = describeAttachedFile({
      path: path.join(dir, "missing.txt"),
      name: "missing.txt",
    });
    expect(text).toContain('"missing.txt" could not be read');
    expect(text).toContain("not available to you");
  });

  it("reports an empty file as empty text, not as unreadable", () => {
    const file = write("empty.txt", "");
    const text = describeAttachedFile({ path: file });
    expect(text).toContain('[Attached file "empty.txt"]');
    expect(text).toContain('[End of attached file "empty.txt"]');
  });
});
