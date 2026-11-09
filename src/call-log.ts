import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface CallLogEntry {
  ts: string;
  tool: string;
  args: unknown;
  durationMs: number;
  ok: boolean;
  result?: string;
  error?: { message: string; stack?: string };
  comfyuiHistory?: unknown;
}

export interface CallLogOptions {
  /** Directory for the daily JSONL files; logging is off when undefined or empty. */
  dir?: string;
  /** Per-day file cap in bytes; further entries that day are dropped after one marker line. */
  maxBytes?: number;
  /** Longest string kept anywhere in an entry; longer ones (base64 images, big JSON) are cut. */
  maxString?: number;
  /** Fetches ComfyUI's most recent execution history after a failed call; optional. */
  fetchHistory?: () => Promise<unknown>;
  now?: () => Date;
}

export interface CallLog {
  readonly enabled: boolean;
  record(tool: string, args: unknown, response: { content?: Array<{ text?: string }>; isError?: boolean }, durationMs: number, error?: unknown): Promise<void>;
}

const SECRET_KEY = /key|token|secret|password|authorization/i;

function sanitize(value: unknown, maxString: number, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > maxString ? `${value.slice(0, maxString)}...[${value.length - maxString} more chars]` : value;
  }
  if (value === null || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, maxString, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : sanitize(v, maxString, depth + 1);
  }
  return out;
}

export function createCallLog(options: CallLogOptions = {}): CallLog {
  const dir = options.dir?.trim();
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxString = options.maxString ?? 2000;
  const now = options.now ?? (() => new Date());
  const capped = new Set<string>();

  if (!dir) {
    return { enabled: false, record: async () => {} };
  }

  return {
    enabled: true,
    async record(tool, args, response, durationMs, error) {
      try {
        const at = now();
        const day = at.toISOString().slice(0, 10).replace(/-/g, "");
        const file = join(dir, `comfyui-mcp-${day}.jsonl`);
        if (capped.has(file)) return;

        await mkdir(dir, { recursive: true });
        const size = await stat(file).then((s) => s.size).catch(() => 0);
        if (size >= maxBytes) {
          capped.add(file);
          await appendFile(file, JSON.stringify({ ts: at.toISOString(), note: "log cap reached for today; further calls not logged" }) + "\n");
          return;
        }

        const failed = Boolean(response.isError) || error !== undefined;
        const entry: CallLogEntry = {
          ts: at.toISOString(),
          tool,
          args: sanitize(args ?? {}, maxString),
          durationMs,
          ok: !failed,
          result: sanitize(response.content?.map((c) => c.text ?? "").join("\n") ?? "", maxString) as string,
        };
        if (error !== undefined) {
          entry.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
        }
        if (failed && options.fetchHistory) {
          entry.comfyuiHistory = sanitize(await options.fetchHistory().catch((e) => ({ unavailable: String(e) })), maxString);
        }
        await appendFile(file, JSON.stringify(entry) + "\n");
      } catch {
        // Logging must never break a tool call.
      }
    },
  };
}
