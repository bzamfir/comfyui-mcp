import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCallLog } from "./call-log.js";

describe("createCallLog", () => {
  let dir: string;
  const fixedNow = () => new Date("2026-11-09T21:00:00Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "call-log-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readEntries() {
    const file = join(dir, "comfyui-mcp-20261109.jsonl");
    return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  }

  it("is disabled and writes nothing without a directory", async () => {
    // Arrange
    const log = createCallLog({ dir: "" });

    // Act
    await log.record("ping_comfyui", {}, { content: [{ text: "ok" }] }, 5);

    // Assert
    expect(log.enabled).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("writes one JSONL entry per call, with secrets redacted and long strings cut", async () => {
    // Arrange
    const log = createCallLog({ dir, now: fixedNow, maxString: 10 });
    const args = { prompt: "a".repeat(50), api_key: "sk-123", nested: { authToken: "t" } };

    // Act
    await log.record("generate_image", args, { content: [{ text: "done" }] }, 42);

    // Assert
    const [entry] = readEntries();
    expect(entry.tool).toBe("generate_image");
    expect(entry.ok).toBe(true);
    expect(entry.durationMs).toBe(42);
    expect(entry.args.api_key).toBe("[redacted]");
    expect(entry.args.nested.authToken).toBe("[redacted]");
    expect(entry.args.prompt).toMatch(/^a{10}\.\.\.\[40 more chars\]$/);
  });

  it("on failure keeps the error stack and ComfyUI's latest history", async () => {
    // Arrange
    const history = { "abc": { status: { status_str: "error", messages: [["execution_error", { node_type: "ControlNetLoader" }]] } } };
    const log = createCallLog({ dir, now: fixedNow, fetchHistory: async () => history });
    const error = new Error("Invalid image file");

    // Act
    await log.record("controlnet_generate", { image: "x.png" }, { content: [{ text: '{"error":"Invalid image file"}' }], isError: true }, 7, error);

    // Assert
    const [entry] = readEntries();
    expect(entry.ok).toBe(false);
    expect(entry.error.message).toBe("Invalid image file");
    expect(entry.error.stack).toContain("Invalid image file");
    expect(entry.comfyuiHistory.abc.status.status_str).toBe("error");
  });

  it("does not fetch history for a successful call", async () => {
    // Arrange
    let fetched = false;
    const log = createCallLog({ dir, now: fixedNow, fetchHistory: async () => { fetched = true; return {}; } });

    // Act
    await log.record("list_models", {}, { content: [{ text: "[]" }] }, 3);

    // Assert
    expect(fetched).toBe(false);
  });

  it("stops at the daily size cap after one marker line", async () => {
    // Arrange
    const log = createCallLog({ dir, now: fixedNow, maxBytes: 1 });

    // Act
    await log.record("a", {}, { content: [{ text: "1" }] }, 1);
    await log.record("b", {}, { content: [{ text: "2" }] }, 1);
    await log.record("c", {}, { content: [{ text: "3" }] }, 1);
    await log.record("d", {}, { content: [{ text: "4" }] }, 1);

    // Assert
    const entries = readEntries();
    expect(entries).toHaveLength(2);
    expect(entries[1].note).toMatch(/cap reached/);
  });

  it("never throws when the directory cannot be written", async () => {
    // Arrange
    const blocker = join(dir, "file-not-dir");
    writeFileSync(blocker, "x");
    const log = createCallLog({ dir: join(blocker, "sub"), now: fixedNow });

    // Act
    const act = log.record("a", {}, { content: [{ text: "1" }] }, 1);

    // Assert
    await expect(act).resolves.toBeUndefined();
    expect(existsSync(join(blocker, "sub"))).toBe(false);
  });
});
