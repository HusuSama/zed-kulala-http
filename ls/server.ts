/**
 * server.ts — LSP relay server main entry.
 *
 * Responsibilities:
 *   1. Provide a standard LSP (JSON-RPC 2.0) protocol over stdio for Zed.
 *   2. Maintain open document text and version (kulala-core is stateless; each
 *      request needs the full document text).
 *   3. Dispatch LSP requests to bridge.ts and pass results back to Zed.
 *   4. Debounce-publish publishDiagnostics after document changes (.http / .rest only).
 *   5. Provide 9 Code Actions: Send Request / Send All Requests / Copy as cURL /
 *      Paste from cURL / Inspect / Download GraphQL Schema / Clear GraphQL Schema Cache /
 *      Clear Globals / Clear Responses.
 *   6. Optionally auto-write .zed/tasks.json on startup (KULALA_AUTO_CREATE_TASK),
 *      providing the task template for the runnables.scm ▶ button.
 *
 * Run modes:
 *   - LSP mode: `node dist/cli.cjs --stdio` (launched by Zed)
 *   - CLI mode: `node dist/cli.cjs run <file> <line>` (triggered by a Zed task,
 *     prints formatted response to stdout)
 *
 * All bridge calls are async and never block the Node loop (LSP requests can be
 * handled concurrently).
 */

import process from "node:process";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import {
  JsonRpcErrorCodes,
  LspConnection,
  type ApplyWorkspaceEditParams,
  type ApplyWorkspaceEditResponse,
  type CodeAction,
  type CodeActionParams,
  type DocumentFormattingParams,
  type ExecuteCommandParams,
  type InitializeResult,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type KulalaResponseItem,
  type KulalaResponseWrapper,
  type MessageType,
  type Position,
  type PublishDiagnosticsParams,
  type ShowMessageParams,
  type TextEdit,
} from "./protocol";
import {
  clearGlobalsAsync,
  clearGraphqlSchemaAsync,
  ensureCore,
  formatDocumentAsync,
  fromCurlAsync,
  graphqlIntrospectAsync,
  inspectRequestAsync,
  lspCompletionAsync,
  lspDiagnosticsAsync,
  lspHoverAsync,
  lspSymbolsAsync,
  runAllAsync,
  runAsync,
  toCurlAsync,
  uriToFsPath,
  type DocContext,
} from "./bridge";
import { formatInspectLines, formatRunResponse } from "./format";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Completion trigger characters (mirrors kulala.vscode TRIGGER_CHARS). */
const TRIGGER_CHARS = [":", "/", "{", "%", "$", ".", "(", "\"", "'", "-"];

/** Diagnostics debounce duration (ms), matching kulala.vscode. */
const DIAG_DEBOUNCE_MS = 75;

/** HTTP document suffixes — only these get diagnostics / code actions. */
const HTTP_SUFFIXES = [".http", ".rest"];

/** Commands exposed to Zed (must match executeCommandProvider.commands). */
const COMMANDS = [
  "kulala.sendRequest",
  "kulala.sendRequestAll",
  "kulala.copyAsCurl",
  "kulala.pasteFromCurl",
  "kulala.inspectRequest",
  "kulala.downloadGraphqlSchema",
  "kulala.clearGraphqlSchemaCache",
  "kulala.clearGlobals",
  "kulala.clearResponses",
] as const;

/**
 * Global fallback cache dir (used only when the project root can't be derived
 * from the HTTP file path). Falls back to os.tmpdir() only if homedir() is
 * unavailable.
 */
const TMP_DIR_FALLBACK = (() => {
  try {
    return join(homedir(), ".kulala", "responses");
  } catch {
    return join(tmpdir(), "kulala-ls");
  }
})();

/** In-project cache subdirectory (relative to project root). */
const PROJECT_CACHE_SUBDIR = join(".kulala-cache", "response");

/** Temp file retention period: 7 days. Expired files are cleaned on each write. */
const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * runnables.scm task tag — the ▶ button requires a task template with this tag
 * in .zed/tasks.json. Matches `(#set! tag "kulala-http-request")` in
 * languages/kulala_http/runnables.scm.
 */
const KULALA_TASK_TAG = "kulala-http-request";

/* ------------------------------------------------------------------ *
 * Document storage
 * ------------------------------------------------------------------ */

interface DocState {
  text: string;
  version: number;
}

const docs = new Map<string, DocState>();

const diagTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Whether the URI is an HTTP document (determines diagnostics / code action eligibility). */
function isHttpUri(uri: string): boolean {
  const lower = uri.toLowerCase();
  return HTTP_SUFFIXES.some((suf) => lower.endsWith(suf));
}

/** Builds a DocContext from a URI. Throws if the document isn't open. */
function docContext(uri: string): DocContext {
  const doc = docs.get(uri);
  if (!doc) {
    throw new Error(`Document not open: ${uri}`);
  }
  const filepath = uriToFsPath(uri);
  const cwd = filepath ? dirname(filepath) : undefined;
  return { content: doc.text, filepath, cwd };
}

/* ------------------------------------------------------------------ *
 * Diagnostics debounce
 * ------------------------------------------------------------------ */

/** Schedules a debounced diagnostics refresh (called after didOpen / didChange). */
function scheduleDiagnostics(uri: string): void {
  const existing = diagTimers.get(uri);
  if (existing) clearTimeout(existing);

  if (!isHttpUri(uri)) return;

  const timer = setTimeout(() => {
    diagTimers.delete(uri);
    void refreshDiagnostics(uri);
  }, DIAG_DEBOUNCE_MS);
  diagTimers.set(uri, timer);
}

/** Runs a diagnostics request and pushes a publishDiagnostics notification to Zed. */
async function refreshDiagnostics(uri: string): Promise<void> {
  let diagnostics: PublishDiagnosticsParams["diagnostics"] = [];
  try {
    const ctx = docContext(uri);
    diagnostics = await lspDiagnosticsAsync(ctx);
  } catch (err) {
    // On kulala-core failure, clear diagnostics to avoid stale errors.
    console.error(`[kulala-ls] diagnostics failed ${uri}:`, err instanceof Error ? err.message : err);
  }
  conn.notify<PublishDiagnosticsParams>("textDocument/publishDiagnostics", {
    uri,
    diagnostics,
  });
}

/* ------------------------------------------------------------------ *
 * didChange incremental sync
 * ------------------------------------------------------------------ */

/**
 * Applies a contentChange to the current text.
 *
 * With textDocumentSync=1 (Full), changes usually contain one entry with no
 * range and the full new text; incremental changes with range are also supported.
 */
function applyChange(
  text: string,
  change: { range?: { start: Position; end: Position }; rangeLength?: number; text: string },
): string {
  if (change.range) {
    const lines = text.split(/\r?\n/);
    const { start, end } = change.range;
    const startIdx = idx(lines, start.line, start.character);
    const endIdx = idx(lines, end.line, end.character);
    return text.slice(0, startIdx) + change.text + text.slice(endIdx);
  }
  return change.text;
}

/** Converts (line, character) to a character offset within the full text. */
function idx(lines: string[], line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i]!.length + 1;
  }
  return offset + character;
}

/**
 * Computes the LSP Position at the end of the given text (for full-replace TextEdit.end).
 * Splits by `\r?\n`; `line = lineCount - 1`, `character = last line's UTF-16 length`.
 */
function endPositionOfText(text: string): Position {
  const lines = text.split(/\r?\n/);
  const last = lines[lines.length - 1] ?? "";
  return { line: lines.length - 1, character: last.length };
}

/* ------------------------------------------------------------------ *
 * Temp file management
 * ------------------------------------------------------------------ */

/**
 * Ensures the fallback cache dir exists on startup and cleans expired files.
 * The in-project cache dir (.kulala-cache/response/) is created/cleaned by
 * writeTmpFile / writeNamedFile on each write.
 */
function ensureTmpDir(): void {
  try {
    mkdirSync(TMP_DIR_FALLBACK, { recursive: true });
    cleanupOldFiles(TMP_DIR_FALLBACK, "");
  } catch (err) {
    console.error(`[kulala-ls] failed to create temp dir ${TMP_DIR_FALLBACK}:`, err);
  }
}

/**
 * Resolves the response cache dir for the current HTTP file
 * (`<projectRoot>/.kulala-cache/response/`).
 *
 * Priority:
 *   1. `process.env.KULALA_PROJECT_ROOT` (injected by Rust lib.rs via Worktree::root_path())
 *   2. Walk up from filepath to find a `.git` directory as project root
 *   3. The directory containing filepath
 *   4. `TMP_DIR_FALLBACK` (~/.kulala/responses/) — when URI is non-file:// or no filepath
 *
 * Side effect: idempotently creates `.kulala-cache/.gitignore` (content `*\n!.gitignore\n`)
 * for in-project dirs so git ignores the cache contents but keeps .gitignore tracked.
 */
function resolveProjectCacheDir(filepath: string | undefined): string {
  const envRoot = process.env.KULALA_PROJECT_ROOT;
  if (envRoot && envRoot.length > 0) {
    const dir = join(envRoot, PROJECT_CACHE_SUBDIR);
    ensureGitignore(join(envRoot, ".kulala-cache"));
    return dir;
  }

  if (filepath) {
    let dir = dirname(filepath);
    for (let cur = dir; cur && cur !== dirname(cur); cur = dirname(cur)) {
      if (existsSync(join(cur, ".git"))) {
        dir = cur;
        break;
      }
    }
    const cacheDir = join(dir, PROJECT_CACHE_SUBDIR);
    ensureGitignore(join(dir, ".kulala-cache"));
    return cacheDir;
  }

  return TMP_DIR_FALLBACK;
}

/**
 * Idempotently ensures `.kulala-cache/.gitignore` exists with content
 * `*\n!.gitignore\n`. Silently ignores failures — gitignore is a nicety, not critical.
 */
function ensureGitignore(kulalaCacheDir: string): void {
  const gitignorePath = join(kulalaCacheDir, ".gitignore");
  const EXPECTED = "*\n!.gitignore\n";
  try {
    if (existsSync(gitignorePath)) {
      return;
    }
    mkdirSync(kulalaCacheDir, { recursive: true });
    writeFileSync(gitignorePath, EXPECTED, "utf-8");
  } catch (err) {
    console.error(`[kulala-ls] failed to create ${gitignorePath}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Cleans files older than `TMP_MAX_AGE_MS` in the given directory (by mtime).
 *
 * @param dir    target directory
 * @param prefix only clean files whose names start with this prefix; empty string = all
 */
function cleanupOldFiles(dir: string, prefix: string): void {
  try {
    const now = Date.now();
    const files = readdirSync(dir)
      .filter((name) => prefix === "" || name.startsWith(prefix + "-"));
    for (const name of files) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isFile() && now - st.mtimeMs > TMP_MAX_AGE_MS) {
          rmSync(path, { force: true });
        }
      } catch {
        // stat / rm failure doesn't affect the main flow
      }
    }
  } catch {
    // directory listing failure (permissions / not exists) — ignore
  }
}

/**
 * Writes content to a temp file in the given dir, returns the absolute path.
 * Filename: `<prefix>-<timestamp>-<index>.<ext>`.
 * Also triggers cleanup of expired files with the same prefix.
 */
function writeTmpFile(
  dir: string,
  prefix: string,
  ext: string,
  content: string,
  index = 0,
): string {
  mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const name = index === 0
    ? `${prefix}-${ts}.${ext}`
    : `${prefix}-${ts}-${index}.${ext}`;
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  cleanupOldFiles(dir, prefix);
  return path;
}

/**
 * Sanitizes a blockName into a filename-safe string.
 * Replaces `/ \ : * ? " < > | @` and whitespace with `-`, collapses consecutive
 * `-`, trims, truncates to 40 chars; returns "request" if empty.
 */
function sanitizeBlockName(name: string): string {
  const sanitized = name
    .replace(/[\/\\:*?"<>|@\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) return "request";
  return sanitized.length > 40 ? sanitized.slice(0, 40) : sanitized;
}

/**
 * Derives a status tag from a response item (embedded in filename for easy identification).
 * Success: HTTP status code; Error: code or "ERR"; WebSocket: "WS"; Prompt: "PROMPT"; Skipped: "SKIP".
 */
function statusTag(item: KulalaResponseItem): string {
  if (item.success) {
    if ((item as { skipped?: boolean }).skipped) return "SKIP";
    if ((item as { protocol?: string }).protocol === "websocket") return "WS";
    const r = item as { status?: number };
    return typeof r.status === "number" ? String(r.status) : "OK";
  }
  if ((item as { prompt?: boolean }).prompt) return "PROMPT";
  const r = item as { status?: number };
  return typeof r.status === "number" ? String(r.status) : "ERR";
}

/** Formats local time as `MMDD-HHMMSS` (e.g. `0629-143025`). */
function formatMMddHHmmss(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${mm}${dd}-${hh}${mi}${ss}`;
}

/**
 * Builds a response filename (no directory, with .kulala extension).
 * Format: `resp-<blockName>-<statusTag>-<MMDD-HHMMSS>[-<index>].kulala`
 */
function buildResponseFilename(
  item: KulalaResponseItem,
  index: number,
  total: number,
): string {
  const rawName = (item as { blockName?: string }).blockName ?? `request-${index + 1}`;
  const block = sanitizeBlockName(rawName);
  const status = statusTag(item);
  const time = formatMMddHHmmss(new Date());
  const suffix = total > 1 ? `-${index + 1}` : "";
  return `resp-${block}-${status}-${time}${suffix}.kulala`;
}

/**
 * Writes content to a named file in the given dir, returns the absolute path.
 * The caller controls the filename. Triggers cleanup by prefix (first segment
 * before `-`).
 */
function writeNamedFile(dir: string, filename: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, content, "utf-8");
  const prefix = filename.split("-")[0] ?? "";
  cleanupOldFiles(dir, prefix);
  return path;
}

/* ------------------------------------------------------------------ *
 * Clipboard reading (cross-platform)
 * ------------------------------------------------------------------ */

/** Reads system clipboard text; returns undefined on failure or missing tool. */
function readClipboard(): string | undefined {
  const platform = process.platform;
  let cmd: { exe: string; args: string[] } | undefined;
  if (platform === "darwin") {
    cmd = { exe: "pbpaste", args: [] };
  } else if (platform === "win32") {
    cmd = {
      exe: "powershell",
      args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
    };
  } else if (platform === "linux") {
    if (existsSync("/usr/bin/xclip") || whichSync("xclip")) {
      cmd = { exe: "xclip", args: ["-selection", "clipboard", "-o"] };
    } else if (existsSync("/usr/bin/xsel") || whichSync("xsel")) {
      cmd = { exe: "xsel", args: ["--clipboard", "--output"] };
    }
  }
  if (!cmd) return undefined;
  try {
    const r = spawnSync(cmd.exe, cmd.args, { encoding: "utf-8", timeout: 5_000 });
    if (r.error || r.status !== 0) return undefined;
    return (r.stdout ?? "").replace(/\r\n$/, "\n").replace(/\n$/, "");
  } catch {
    return undefined;
  }
}

/** Finds an executable in PATH (sync, Linux/macOS only). */
function whichSync(exe: string): boolean {
  const path = process.env.PATH;
  if (!path) return false;
  for (const dir of path.split(":")) {
    if (dir && existsSync(join(dir, exe))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Notification helpers
 * ------------------------------------------------------------------ */

/** Convenience wrapper for `window/showMessage`. */
function showMessage(type: MessageType, message: string): void {
  conn.notify<ShowMessageParams>("window/showMessage", { type, message });
}

/* ------------------------------------------------------------------ *
 * LSP Work Done Progress (status bar spinner)
 * ------------------------------------------------------------------ */

/**
 * Wraps an async operation in LSP WorkDoneProgress, showing a spinner + title
 * in Zed's status bar.
 *
 * Flow:
 *   1. server→client `window/workDoneProgress/create` (register token, must precede begin)
 *   2. server→client `$/progress` { kind:"begin", title }
 *   3. (optional) `$/progress` { kind:"report", message?, percentage? }
 *   4. `$/progress` { kind:"end" }
 *
 * If create fails (client unsupported / channel error), degrades to running fn
 * without progress.
 */
async function withProgress<T>(
  title: string,
  fn: (report: (message?: string, percentage?: number) => void) => Promise<T>,
): Promise<T> {
  const token = `kulala-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let active = false;
  try {
    await conn.request("window/workDoneProgress/create", { token });
    active = true;
  } catch (err) {
    console.error(`[kulala-ls] workDoneProgress/create failed, degrading to no-progress:`, err instanceof Error ? err.message : err);
  }

  const report = (message?: string, percentage?: number): void => {
    if (!active) return;
    conn.notify("$/progress", {
      token,
      value: { kind: "report", message, percentage },
    });
  };

  if (active) {
    conn.notify("$/progress", {
      token,
      value: { kind: "begin", title, cancellable: false },
    });
  }

  try {
    return await fn(report);
  } finally {
    if (active) {
      conn.notify("$/progress", { token, value: { kind: "end" } });
    }
  }
}

/**
 * Opens a file in the running Zed instance (non-blocking).
 * Spawns `zed -e <path>` so the Zed CLI forwards the open request via IPC to
 * the current Zed window. `-e/--existing` opens in the existing window.
 * All failures are silent (logged to stderr only).
 */
function openInZed(path: string): void {
  let child;
  try {
    child = spawn("zed", ["-e", path], { stdio: "ignore", detached: true });
  } catch (err) {
    console.error(`[kulala-ls] failed to spawn zed:`, err instanceof Error ? err.message : err);
    return;
  }
  child.on("error", (err) => {
    console.error(`[kulala-ls] zed -e failed (${path}):`, err.message);
  });
  child.unref();
}

/* ------------------------------------------------------------------ *
 * .zed/tasks.json auto-write (task template for runnables.scm ▶ button)
 * ------------------------------------------------------------------ */

/**
 * Ensures a task template tagged `kulala-http-request` exists in .zed/tasks.json
 * (idempotent, safe). Triggered when `KULALA_AUTO_CREATE_TASK=true` (injected by
 * Rust lib.rs from `lsp.kulala-ls.settings.autoCreateTask`; default "false").
 *
 * Behavior:
 *   - A task with the tag already exists → skip (no duplicate, no overwrite)
 *   - File missing / unparseable → create new file with only the kulala task
 *   - File exists without the tag → append (preserve user's other tasks)
 *   - Write failure → log to stderr, don't block LSP startup
 */
function ensureWorkspaceTask(): void {
  const autoCreate = process.env.KULALA_AUTO_CREATE_TASK ?? "false";
  if (autoCreate !== "true") return;

  const root = process.env.KULALA_PROJECT_ROOT;
  if (!root || root.length === 0) {
    console.error("[kulala-ls] ensureWorkspaceTask: KULALA_PROJECT_ROOT not set, skipping task auto-write");
    return;
  }

  const zedDir = join(root, ".zed");
  const tasksPath = join(zedDir, "tasks.json");

  // esbuild outputs CJS; __dirname at runtime is the cli.cjs directory (dist/).
  const cliPath = join(__dirname, "cli.cjs");

  // reveal: "always" pops the terminal after execution for immediate viewing.
  // cliPath is double-quoted: Zed tasks run via shell, and paths with spaces
  // (e.g. "Application Support") would be split without quoting.
  const TASK_TEMPLATE = {
    label: "Kulala: Run in Terminal",
    command: "node",
    args: [`"${cliPath}"`, "run", "$ZED_FILE", "$ZED_ROW"],
    tags: [KULALA_TASK_TAG],
    reveal: "always",
  } as const;

  let existing: unknown = [];
  if (existsSync(tasksPath)) {
    try {
      const raw = readFileSync(tasksPath, "utf-8");
      existing = JSON.parse(raw);
    } catch (err) {
      console.error(
        `[kulala-ls] ensureWorkspaceTask: ${tasksPath} parse failed, skipping auto-write (to avoid corrupting user data):`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
  }

  // Normalize to array (Zed accepts `{}` object or `[]` array)
  let tasks: unknown[];
  if (Array.isArray(existing)) {
    tasks = existing;
  } else if (existing && typeof existing === "object") {
    tasks = [existing];
  } else {
    tasks = [];
  }

  // Idempotent: skip if a task with the tag already exists
  const hasKulalaTask = tasks.some((t) => {
    if (!t || typeof t !== "object") return false;
    const tags = (t as { tags?: unknown }).tags;
    return Array.isArray(tags) && tags.includes(KULALA_TASK_TAG);
  });
  if (hasKulalaTask) return;

  try {
    mkdirSync(zedDir, { recursive: true });
    const next = [...tasks, TASK_TEMPLATE];
    const text = `${JSON.stringify(next, null, 2)}\n`;
    writeFileSync(tasksPath, text, "utf-8");
    console.error(`[kulala-ls] ensureWorkspaceTask: wrote ${tasksPath} (appended ${KULALA_TASK_TAG} task)`);
  } catch (err) {
    console.error(
      `[kulala-ls] ensureWorkspaceTask: failed to write ${tasksPath}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/* ------------------------------------------------------------------ *
 * CLI mode: `node dist/cli.cjs run <file> <line>`
 *
 * Called by the task in .zed/tasks.json: runnables.scm renders a ▶ button bound
 * to the task by tag; clicking runs the task command in a terminal, invoking
 * this CLI mode to execute the request and print the formatted response to stdout.
 *
 * Unlike LSP mode: no cache file is written, no auto-open in Zed; the response
 * is printed directly to the terminal.
 * ------------------------------------------------------------------ */

/**
 * CLI `run` entry: reads file → calls runAsync → prints formatted response to
 * stdout → exits.
 *
 * Line conversion: Zed's `$ZED_ROW` is 1-based, LSP Position.line is 0-based,
 * so `line = row - 1`. kulala-core's cursorPosition filter expects 1-based,
 * handled by bridge.ts's `toKulalaPosition` (+1). character is fixed at 0
 * (LSP 0-based) → kulala-core column 1, enough to hit the request start.
 *
 * Exit codes: 0 = success (response on stdout), 1 = failure (error on stderr).
 */
async function runCli(file: string, row: string): Promise<void> {
  const lineNum = Number.parseInt(row, 10);
  if (!Number.isFinite(lineNum) || lineNum < 1) {
    console.error(`[kulala-ls] CLI run: invalid line number "${row}" (expected 1-based positive integer)`);
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch (err) {
    console.error(
      `[kulala-ls] CLI run: failed to read file ${file}:`,
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  const ctx: DocContext = { content, filepath: file, cwd: dirname(file) };
  const position: Position = { line: lineNum - 1, character: 0 };

  const result = await runAsync(ctx, position);
  if (!result.ok || !result.data) {
    console.error(
      `[kulala-ls] CLI run: request failed: ${result.error ?? "unknown error"}`,
    );
    process.exit(1);
  }

  const texts = formatRunResponse(result.data.wrapper);
  process.stdout.write(texts.join("\n\n"));
  if (texts.length > 0) {
    process.stdout.write("\n");
  }
  process.exit(0);
}

/**
 * CLI argv dispatch: `node dist/cli.cjs run <file> <line>` → CLI mode;
 * `node dist/cli.cjs --stdio` or no args → LSP mode.
 *
 * Runs at module top level (import side effect) so CLI mode doesn't start the
 * LSP connection or read stdin.
 */
function dispatchCliMode(): boolean {
  const argv = process.argv.slice(2);
  if (argv[0] !== "run") return false;
  const file = argv[1];
  const row = argv[2];
  if (!file || !row) {
    console.error("[kulala-ls] CLI run usage: node dist/cli.cjs run <file> <line>");
    process.exit(1);
  }
  void runCli(file, row);
  return true;
}

/* ------------------------------------------------------------------ *
 * LSP connection
 * ------------------------------------------------------------------ */

const conn = new LspConnection(process.stdin, process.stdout);

/** Whether a shutdown request has been received (determines exit code). */
let shutdownRequested = false;

/* ------------------------------------------------------------------ *
 * CodeAction helpers
 * ------------------------------------------------------------------ */

/**
 * Builds a CodeAction (command-only, no edit).
 * arguments are always `[{ uri, position }]`.
 */
function buildCodeAction(
  title: string,
  command: string,
  uri: string,
  position: Position,
): CodeAction {
  return {
    title,
    kind: "source",
    command: {
      title,
      command,
      arguments: [{ uri, position }],
    },
  };
}

/** Extracts { uri, position } from executeCommand arguments[0]. Throws on invalid input. */
function parseCommandArg(args: unknown[] | undefined): { uri: string; position: Position } {
  const arg = args?.[0];
  if (!arg || typeof arg !== "object") {
    throw new Error("executeCommand argument missing or not an object");
  }
  const obj = arg as { uri?: unknown; position?: unknown };
  if (typeof obj.uri !== "string") {
    throw new Error("executeCommand argument uri missing or not a string");
  }
  if (
    !obj.position ||
    typeof obj.position !== "object" ||
    typeof (obj.position as { line?: unknown }).line !== "number" ||
    typeof (obj.position as { character?: unknown }).character !== "number"
  ) {
    throw new Error("executeCommand argument position missing or malformed");
  }
  return {
    uri: obj.uri,
    position: obj.position as Position,
  };
}

/**
 * Extracts only uri from executeCommand arguments[0] (position not required).
 * For commands that only need the project root (e.g. clearResponses).
 */
function parseUriArg(args: unknown[] | undefined): { uri: string } {
  const arg = args?.[0];
  if (!arg || typeof arg !== "object") {
    throw new Error("executeCommand argument missing or not an object");
  }
  const obj = arg as { uri?: unknown };
  if (typeof obj.uri !== "string") {
    throw new Error("executeCommand argument uri missing or not a string");
  }
  return { uri: obj.uri };
}

/**
 * Detects kulala-core error messages and returns an actionable fix hint.
 * Currently covers: `"X" cannot be parsed as a URL.` — URL missing scheme.
 */
function hintForKulalaError(error: string | undefined): string {
  if (!error) return "";
  if (error.includes("cannot be parsed as a URL")) {
    return " (Hint: URL missing scheme; use http:// or https:// prefix)";
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * executeCommand dispatcher
 * ------------------------------------------------------------------ */

/**
 * Handles workspace/executeCommand.
 * Returns result on success (may be null); throws on failure.
 */
async function executeCommand(params: ExecuteCommandParams): Promise<unknown> {
  switch (params.command) {
    case "kulala.sendRequest":
      return await handleSendRequest(params);
    case "kulala.sendRequestAll":
      return await handleSendRequestAll(params);
    case "kulala.copyAsCurl":
      return await handleCopyAsCurl(params);
    case "kulala.pasteFromCurl":
      return await handlePasteFromCurl(params);
    case "kulala.inspectRequest":
      return await handleInspectRequest(params);
    case "kulala.downloadGraphqlSchema":
      return await handleDownloadGraphqlSchema(params);
    case "kulala.clearGraphqlSchemaCache":
      return await handleClearGraphqlSchemaCache();
    case "kulala.clearGlobals":
      return await handleClearGlobals();
    case "kulala.clearResponses":
      return await handleClearResponses(params);
    default:
      throw new Error(`Unknown command: ${params.command}`);
  }
}

/** kulala.sendRequest → run → write temp files + showMessage(Info). */
async function handleSendRequest(params: ExecuteCommandParams): Promise<null> {
  const { uri, position } = parseCommandArg(params.arguments);
  const ctx = docContext(uri);
  const result = await withProgress("Sending HTTP request", () => runAsync(ctx, position));
  if (!result.ok || !result.data) {
    const hint = hintForKulalaError(result.error);
    const msg = `Send Request failed${hint}: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  return writeRunResponsesAndNotify(ctx, result.data.wrapper);
}

/**
 * kulala.sendRequestAll → run (no limit, runs all blocks) → write temp files + showMessage.
 * Uses `parseUriArg` (position ignored); kulala-core `haltOnError: false`.
 */
async function handleSendRequestAll(params: ExecuteCommandParams): Promise<null> {
  const { uri } = parseUriArg(params.arguments);
  const ctx = docContext(uri);
  const result = await withProgress("Sending all HTTP requests", () => runAllAsync(ctx));
  if (!result.ok || !result.data) {
    const hint = hintForKulalaError(result.error);
    const msg = `Send All Requests failed${hint}: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  return writeRunResponsesAndNotify(ctx, result.data.wrapper);
}

/**
 * Writes run / runAll results to `.kulala-cache/response/` and notifies the user.
 *
 * 1. Generates a semantic filename per response item and writes to the cache dir
 * 2. Auto-opens the first response file in Zed
 * 3. Shows a message based on wrapper type (prompt / websocket / error / skipped / success)
 */
async function writeRunResponsesAndNotify(
  ctx: DocContext,
  wrapper: KulalaResponseWrapper,
): Promise<null> {
  const cacheDir = resolveProjectCacheDir(ctx.filepath);
  const texts = formatRunResponse(wrapper);
  const paths: string[] = [];
  texts.forEach((text, idx) => {
    const item = wrapper.data[idx]!;
    const filename = buildResponseFilename(item, idx, texts.length);
    const path = writeNamedFile(cacheDir, filename, text);
    paths.push(path);
  });

  // Auto-open the first response file; failure is silent (logged in openInZed).
  if (paths[0]) {
    openInZed(paths[0]);
  }

  const hasPrompt = wrapper.data.some((d) => "prompt" in d && d.prompt);
  const hasWebSocket = wrapper.data.some(
    (d) => "protocol" in d && d.protocol === "websocket",
  );
  const hasError = wrapper.type === "error" || wrapper.data.some((d) => !d.success);
  const hasSkipped = wrapper.data.some((d) => "skipped" in d && d.skipped);

  if (hasPrompt) {
    showMessage(
      1,
      "Request needs interactive input (OAuth2 etc.). Not supported in Zed; use Neovim + kulala.nvim. See temp file for prompt details.",
    );
  } else if (hasWebSocket) {
    showMessage(
      2,
      "WebSocket requests are not yet supported in Zed. See temp file for plan details.",
    );
  } else if (hasError) {
    const first = paths[0] ?? "(no file)";
    const extra = paths.length > 1 ? ` (+${paths.length - 1} more)` : "";
    const errDetail = wrapper.data.find(
      (d): d is { success: false; error: string } =>
        d.success === false && "error" in d && typeof (d as { error?: unknown }).error === "string",
    );
    const hint = hintForKulalaError(errDetail?.error);
    showMessage(
      1,
      `Request failed.${hint} See: ${first}${extra} (cmd+P search "resp")`,
    );
  } else if (hasSkipped) {
    showMessage(
      3,
      `Request was skipped by pre-request script. See: ${paths[0] ?? "(no file)"}`,
    );
  } else {
    const first = paths[0] ?? "(no file)";
    const extra = paths.length > 1 ? ` (+${paths.length - 1} more)` : "";
    showMessage(
      3,
      `Response saved to: ${first}${extra} (cmd+P search "resp" to open)`,
    );
  }
  return null;
}

/** kulala.copyAsCurl → to_curl → write temp file + showMessage(Info). */
async function handleCopyAsCurl(params: ExecuteCommandParams): Promise<null> {
  const { uri, position } = parseCommandArg(params.arguments);
  const ctx = docContext(uri);
  const result = await toCurlAsync(ctx, position);
  if (!result.ok || !result.data) {
    const hint = hintForKulalaError(result.error);
    const msg = `Copy as cURL failed${hint}: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  const text = `# Generated at ${new Date().toISOString()}\n\n${result.data.curl}\n`;
  const cacheDir = resolveProjectCacheDir(ctx.filepath);
  const path = writeTmpFile(cacheDir, "curl", "kulala", text);
  openInZed(path);
  showMessage(3, `cURL saved to: ${path} (cmd+P search "curl" to open)`);
  return null;
}

/** kulala.pasteFromCurl → read clipboard → from_curl → workspace/applyEdit. */
async function handlePasteFromCurl(params: ExecuteCommandParams): Promise<null> {
  const { uri, position } = parseCommandArg(params.arguments);
  const curlText = readClipboard();
  if (!curlText || curlText.length === 0) {
    const msg = "Clipboard is empty or unreadable; copy a cURL command first";
    showMessage(1, msg);
    throw new Error(msg);
  }
  const result = await fromCurlAsync(curlText);
  if (!result.ok || !result.data) {
    const msg = `Paste from cURL failed: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  const newText = `${result.data.lines.join("\n")}\n\n`;
  const editParams: ApplyWorkspaceEditParams = {
    label: "Paste from cURL",
    edit: {
      documentChanges: [
        {
          textDocument: { uri, version: null },
          edits: [{ range: { start: position, end: position }, newText }],
        },
      ],
    },
  };
  try {
    const resp = await conn.request<ApplyWorkspaceEditResponse>(
      "workspace/applyEdit",
      editParams,
    );
    if (!resp.applied) {
      const reason = resp.failureReason ?? resp.failedChange ?? "(no reason)";
      const msg = `Apply edit rejected: ${reason}`;
      showMessage(1, msg);
      throw new Error(msg);
    }
    showMessage(3, "Pasted cURL as HTTP request");
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showMessage(1, `Paste from cURL applyEdit failed: ${msg}`);
    throw err;
  }
}

/** kulala.inspectRequest → inspect_request → write temp file + showMessage(Info). */
async function handleInspectRequest(params: ExecuteCommandParams): Promise<null> {
  const { uri, position } = parseCommandArg(params.arguments);
  const ctx = docContext(uri);
  const result = await inspectRequestAsync(ctx, position);
  if (!result.ok || !result.data) {
    const hint = hintForKulalaError(result.error);
    const msg = `Inspect failed${hint}: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  const text = formatInspectLines(result.data.lines);
  const cacheDir = resolveProjectCacheDir(ctx.filepath);
  const path = writeTmpFile(cacheDir, "inspect", "kulala", text);
  openInZed(path);
  showMessage(3, `Inspect saved to: ${path} (cmd+P search "inspect" to open)`);
  return null;
}

/** kulala.downloadGraphqlSchema → graphql_introspect → showMessage. */
async function handleDownloadGraphqlSchema(params: ExecuteCommandParams): Promise<null> {
  const { uri, position } = parseCommandArg(params.arguments);
  const ctx = docContext(uri);
  const result = await graphqlIntrospectAsync(ctx, position);
  if (!result.ok || !result.data) {
    const msg = `Download GraphQL Schema failed: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  const from = result.data.fromCache ? " (from cache)" : "";
  showMessage(3, `GraphQL schema downloaded for host: ${result.data.host}${from}`);
  return null;
}

/** kulala.clearGraphqlSchemaCache → clear_graphql_schema → showMessage. */
async function handleClearGraphqlSchemaCache(): Promise<null> {
  const result = await clearGraphqlSchemaAsync();
  if (!result.ok || !result.data) {
    const msg = `Clear GraphQL Schema Cache failed: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  showMessage(3, `Cleared ${result.data.cleared} GraphQL schema cache entries`);
  return null;
}

/** kulala.clearGlobals → clear_globals → showMessage. */
async function handleClearGlobals(): Promise<null> {
  const result = await clearGlobalsAsync();
  if (!result.ok || !result.data) {
    const msg = `Clear Globals failed: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  showMessage(3, "Cleared all global script variables");
  return null;
}

/**
 * kulala.clearResponses → clears all files in the current project's
 * `.kulala-cache/response/`. Non-recursive (files only). Does not clear the
 * fallback dir (~/.kulala/responses/) to avoid cross-project deletion.
 */
async function handleClearResponses(params: ExecuteCommandParams): Promise<null> {
  const { uri } = parseUriArg(params.arguments);
  const filepath = uriToFsPath(uri);
  const cacheDir = resolveProjectCacheDir(filepath);

  let files: string[];
  try {
    files = readdirSync(cacheDir);
  } catch (err) {
    const msg = `Clear Responses failed (cannot read ${cacheDir}): ${
      err instanceof Error ? err.message : err
    }`;
    showMessage(1, msg);
    throw new Error(msg);
  }

  const counts: Record<string, number> = {};
  let cleared = 0;
  for (const name of files) {
    const prefix = name.split("-")[0] ?? "other";
    counts[prefix] = (counts[prefix] ?? 0) + 1;
    const full = join(cacheDir, name);
    try {
      const st = statSync(full);
      if (st.isFile()) {
        rmSync(full, { force: true });
        cleared++;
      }
    } catch {
      try {
        rmSync(full, { force: true });
        cleared++;
      } catch {
        // single file failure doesn't affect others
      }
    }
  }

  const breakdown = Object.entries(counts)
    .filter(([_, n]) => n > 0)
    .map(([p, n]) => `${p}=${n}`)
    .join(", ");
  showMessage(
    3,
    `Cleared ${cleared} file${cleared === 1 ? "" : "s"} from .kulala-cache/response/${breakdown ? ` (${breakdown})` : ""}`,
  );
  return null;
}

/* ------------------------------------------------------------------ *
 * Request / notification dispatch
 * ------------------------------------------------------------------ */

/**
 * Handles a single inbound message. Declared async: for kulala-core requests,
 * awaits ensureCore() first. Errors are caught per-branch and sent back to Zed.
 */
async function handle(msg: JsonRpcMessage): Promise<void> {
  // ---- Requests (have id, must reply) ----
  if ("id" in msg && "method" in msg) {
    const req = msg as JsonRpcRequest;
    const id = req.id;
    try {
      switch (req.method) {
        case "initialize": {
          // initialize doesn't depend on kulala-core; return capabilities immediately.
          // The binary is lazily ensured on first actual request (lazy download).
          ensureTmpDir();
          const result: InitializeResult = {
            capabilities: {
              textDocumentSync: 1, // Full
              completionProvider: { triggerCharacters: TRIGGER_CHARS, resolveProvider: false },
              hoverProvider: true,
              documentSymbolProvider: true,
              codeActionProvider: true,
              executeCommandProvider: { commands: [...COMMANDS] },
              // Supports Zed `formatter: "language_server"` + `format_on_save`:
              // on save (or manual format) Zed sends textDocument/formatting.
              documentFormattingProvider: true,
            },
            serverInfo: { name: "kulala-ls", version: "0.1.0" },
          };
          conn.ok(id, result);
          return;
        }
        case "shutdown": {
          shutdownRequested = true;
          conn.ok(id, null);
          return;
        }
        case "textDocument/completion": {
          ensureCore();
          const params = req.params as { textDocument: { uri: string }; position: Position };
          const uri = params.textDocument.uri;
          const list = await lspCompletionAsync(docContext(uri), params.position, uri);
          conn.ok(id, list);
          return;
        }
        case "textDocument/hover": {
          ensureCore();
          const params = req.params as { textDocument: { uri: string }; position: Position };
          const uri = params.textDocument.uri;
          const hover = await lspHoverAsync(docContext(uri), params.position, uri);
          // LSP spec: return null when hover has no content.
          conn.ok(id, hover ?? null);
          return;
        }
        case "textDocument/documentSymbol": {
          ensureCore();
          const params = req.params as { textDocument: { uri: string } };
          const uri = params.textDocument.uri;
          const symbols = await lspSymbolsAsync(docContext(uri));
          conn.ok(id, symbols);
          return;
        }
        case "textDocument/formatting": {
          // Feed the full document to kulala-core's format action; return a
          // full-replace TextEdit. On failure / no change / non-HTTP doc,
          // return empty edits to avoid blocking save.
          ensureCore();
          const params = req.params as DocumentFormattingParams;
          const uri = params.textDocument.uri;
          if (!isHttpUri(uri)) {
            conn.ok(id, []);
            return;
          }
          const ctx = docContext(uri);
          const result = await formatDocumentAsync(ctx);
          if (!result.ok || !result.data) {
            console.error(
              `[kulala-ls] document formatting failed ${uri}:`,
              result.error ?? "unknown error",
            );
            // Silent degradation: return empty edits (not an error response) to
            // avoid Zed popping an error on format_on_save.
            conn.ok(id, []);
            return;
          }
          if (!result.data.changed) {
            conn.ok(id, []);
            return;
          }
          const end = endPositionOfText(ctx.content);
          const edits: TextEdit[] = [
            {
              range: { start: { line: 0, character: 0 }, end },
              newText: result.data.formatted,
            },
          ];
          conn.ok(id, edits);
          return;
        }
        case "textDocument/codeAction": {
          const params = req.params as CodeActionParams;
          const uri = params.textDocument.uri;
          if (!isHttpUri(uri)) {
            conn.ok(id, []);
            return;
          }
          const position = params.range.start;
          const actions: CodeAction[] = [
            buildCodeAction("Kulala: Send Request", "kulala.sendRequest", uri, position),
            buildCodeAction("Kulala: Send All Requests", "kulala.sendRequestAll", uri, position),
            buildCodeAction("Kulala: Copy as cURL", "kulala.copyAsCurl", uri, position),
            buildCodeAction("Kulala: Paste from cURL", "kulala.pasteFromCurl", uri, position),
            buildCodeAction("Kulala: Inspect Current Request", "kulala.inspectRequest", uri, position),
            buildCodeAction("Kulala: Download GraphQL Schema", "kulala.downloadGraphqlSchema", uri, position),
            buildCodeAction("Kulala: Clear GraphQL Schema Cache", "kulala.clearGraphqlSchemaCache", uri, position),
            buildCodeAction("Kulala: Clear Globals", "kulala.clearGlobals", uri, position),
            buildCodeAction("Kulala: Clear Responses", "kulala.clearResponses", uri, position),
          ];
          conn.ok(id, actions);
          return;
        }
        case "workspace/executeCommand": {
          ensureCore();
          const params = req.params as ExecuteCommandParams;
          const result = await executeCommand(params);
          conn.ok(id, result);
          return;
        }
        default: {
          conn.sendError(id, JsonRpcErrorCodes.MethodNotFound, `Unknown method: ${req.method}`);
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[kulala-ls] request ${req.method} failed:`, message);
      conn.sendError(id, JsonRpcErrorCodes.InternalError, message);
    }
    return;
  }

  // ---- Notifications (no id, no reply) ----
  if ("method" in msg) {
    const note = msg as JsonRpcNotification;
    switch (note.method) {
      case "initialized":
        break;
      case "exit":
        // Exit code: 0 if shutdown was requested, otherwise 1.
        process.exit(shutdownRequested ? 0 : 1);
        break;
      case "textDocument/didOpen": {
        const params = note.params as { textDocument: { uri: string; text: string; version: number } };
        const { uri, text, version } = params.textDocument;
        docs.set(uri, { text, version });
        scheduleDiagnostics(uri);
        break;
      }
      case "textDocument/didChange": {
        const params = note.params as {
          textDocument: { uri: string; version: number };
          contentChanges: Array<{ range?: { start: Position; end: Position }; rangeLength?: number; text: string }>;
        };
        const { uri, version } = params.textDocument;
        const cur = docs.get(uri);
        let text = cur?.text ?? "";
        for (const ch of params.contentChanges) text = applyChange(text, ch);
        docs.set(uri, { text, version });
        scheduleDiagnostics(uri);
        break;
      }
      case "textDocument/didClose": {
        const params = note.params as { textDocument: { uri: string } };
        const uri = params.textDocument.uri;
        docs.delete(uri);
        // Clear published diagnostics on close.
        conn.notify<PublishDiagnosticsParams>("textDocument/publishDiagnostics", {
          uri,
          diagnostics: [],
        });
        break;
      }
      default:
        break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

// CLI mode takes priority: detect `run <file> <line>` argv → CLI mode, exit via process.exit.
// Otherwise fall through to LSP mode (avoid occupying stdin/stdout unnecessarily).
if (dispatchCliMode()) {
  // dispatchCliMode triggered runCli (async); return here to let the main module finish loading.
} else {
  // LSP mode: try auto-writing .zed/tasks.json on startup (controlled by KULALA_AUTO_CREATE_TASK)
  ensureWorkspaceTask();

  // Start the read loop; each inbound message is handled async (fire-and-forget).
  conn.start((msg) => {
    void handle(msg);
  });
}

// Process-level error fallback: log to stderr to avoid silent crashes.
process.on("uncaughtException", (err) => {
  console.error("[kulala-ls] uncaught exception:", err instanceof Error ? err.message : err);
});
process.on("unhandledRejection", (err) => {
  console.error("[kulala-ls] unhandled promise rejection:", err instanceof Error ? err.message : err);
});
