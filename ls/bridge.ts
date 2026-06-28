/**
 * bridge.ts — kulala-core bridging layer.
 *
 * Responsibilities:
 *   1. Validate kulala-core binary availability (path injected by Rust via
 *      KULALA_CORE_BIN; install/download managed by Rust).
 *   2. Invoke kulala-core in "one-shot spawn" mode: send JSON payload to stdin,
 *      read JSON result from stdout.
 *   3. Translate LSP requests (completion / hover / symbols / diagnostics) into
 *      kulala-core actions.
 *   4. Translate Code Action requests (run / to_curl / from_curl / inspect_request /
 *      graphql_introspect / clear_graphql_schema / clear_globals) into kulala-core
 *      actions.
 *   5. Coordinate conversion: LSP is 0-based, kulala-core is 1-based (vim style).
 *
 * All calls go through `invokeAsync` (async spawn) and never block the Node loop.
 * LSP requests may arrive concurrently; kulala-core calls usually take <50ms,
 * while run / graphql_introspect may take seconds to minutes.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CompletionList,
  Diagnostic,
  DocumentSymbol,
  Hover,
  KulalaResponseWrapper,
  Position,
} from "./protocol";

/* ------------------------------------------------------------------ *
 * Binary location
 *
 * LSP mode: path injected by Rust via KULALA_CORE_BIN; relay only validates.
 * CLI mode (`node dist/cli.cjs run ...`, no Rust injection): resolve relative
 * to `__dirname` under `node_modules/@mistweaverco/kulala-core/dist/bin/`.
 * ------------------------------------------------------------------ */

/** Platform-specific kulala-core binary name (Windows adds `.exe`). */
function kulalaCoreBinaryName(): string {
  return process.platform === "win32" ? "kulala-core.exe" : "kulala-core";
}

/**
 * Resolves the kulala-core binary path.
 *
 * Lookup order:
 *   1. `KULALA_CORE_BIN` env (injected by Rust lib.rs; preferred in LSP mode)
 *   2. `__dirname/../node_modules/@mistweaverco/kulala-core/dist/bin/` (CLI fallback)
 *   3. `__dirname/../../node_modules/@mistweaverco/kulala-core/dist/bin/` (deeper dir fallback)
 */
function resolveCoreBinary(): string {
  const envPath = process.env.KULALA_CORE_BIN;
  if (envPath && envPath.length > 0) {
    if (existsSync(envPath)) return envPath;
    throw new Error(`KULALA_CORE_BIN points to a non-existent binary: ${envPath}`);
  }

  const binName = kulalaCoreBinaryName();
  const candidates = [
    join(__dirname, "..", "node_modules", "@mistweaverco", "kulala-core", "dist", "bin", binName),
    join(__dirname, "..", "..", "node_modules", "@mistweaverco", "kulala-core", "dist", "bin", binName),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  throw new Error(
    "kulala-core binary not found. Tried the following paths:\n" +
      candidates.map((c) => `  - ${c}`).join("\n") +
      "\nStart the relay via the Zed extension (lib.rs), or ensure kulala-core is installed in node_modules.",
  );
}

/** Validates binary availability (sync). Install is handled by Rust; here we only check existence. */
export function ensureCore(): string {
  return resolveCoreBinary();
}

/* ------------------------------------------------------------------ *
 * Low-level invocation: spawn kulala-core binary
 * ------------------------------------------------------------------ */

/** kulala-core invocation result. */
interface InvokeResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Max retry count (including the first call) for kulala-core's intermittent
 * empty-stdout bug. Retries only trigger on "empty stdout + exit code 0";
 * successful calls incur no extra latency.
 */
const INVOKE_MAX_RETRIES = 3;

/**
 * Sync kulala-core call (only for parsing actions <50ms: completion/symbols/diagnostics).
 *
 * Long-running actions (run / graphql_introspect) must use `invokeAsync` to
 * avoid blocking the Node loop. server.ts has switched to the async path; this
 * function is retained for compatibility and may be removed in the future.
 */
function invoke(payload: Record<string, unknown>, cwd?: string): InvokeResult {
  const payloadStr = `${JSON.stringify(payload)}\n`;
  let lastResult: InvokeResult | undefined;

  for (let attempt = 0; attempt < INVOKE_MAX_RETRIES; attempt++) {
    lastResult = invokeSyncOnce(payloadStr, cwd);
    if (lastResult.stdout.trim().length > 0) return lastResult;
    if (lastResult.code !== 0) return lastResult;
  }
  return lastResult!;
}

/** Single sync call (no retry). stdout is redirected to a temp file. */
function invokeSyncOnce(payloadStr: string, cwd?: string): InvokeResult {
  const exe = resolveCoreBinary();
  const tmpFile = join(
    tmpdir(),
    `kulala-stdout-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`,
  );
  let fdOut: number | undefined;
  try {
    fdOut = openSync(tmpFile, "w");
    const result = spawnSync(exe, [], {
      input: payloadStr,
      encoding: "utf-8",
      stdio: ["pipe", fdOut, "pipe"],
      maxBuffer: 50 * 1024 * 1024,
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      env: process.env,
    });
    let stdout = "";
    try { closeSync(fdOut); fdOut = undefined; } catch { /* ignore */ }
    try { stdout = readFileSync(tmpFile, "utf-8"); } catch { /* ignore */ }
    if (result.error) {
      throw result.error;
    }
    return {
      stdout,
      stderr: result.stderr ?? "",
      code: result.status,
    };
  } finally {
    if (fdOut !== undefined) {
      try { closeSync(fdOut); } catch { /* ignore */ }
    }
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/**
 * Async kulala-core call: spawns a child process, writes payload to stdin,
 * reads stdout from a temp file.
 *
 * stdout uses a temp file rather than a pipe because kulala-core in pipe mode
 * only writes up to the OS pipe buffer size (macOS 16KB / Linux 64KB) and exits,
 * truncating large outputs (Auth header completion, large Send Request
 * responses) into unparseable JSON. File mode is not bound by pipe buffer limits.
 *
 * Retries on "empty stdout + exit code 0" (kulala-core's intermittent bug),
 * up to `INVOKE_MAX_RETRIES` times. Default timeout 90s — 30s earlier than
 * Zed's 120s LSP timeout to surface a clear error; on timeout SIGTERM (2s
 * grace) → SIGKILL.
 */
async function invokeAsync(
  payload: Record<string, unknown>,
  cwd?: string,
  timeoutMs = 90_000,
): Promise<InvokeResult> {
  const payloadStr = `${JSON.stringify(payload)}\n`;
  let lastResult: InvokeResult | undefined;

  for (let attempt = 0; attempt < INVOKE_MAX_RETRIES; attempt++) {
    lastResult = await invokeAsyncOnce(payloadStr, payload, cwd, timeoutMs);
    if (lastResult.stdout.trim().length > 0) return lastResult;
    if (lastResult.code !== 0) return lastResult;
  }
  return lastResult!;
}

/**
 * Single async call (no retry). stdout redirected to a temp file.
 *
 * stdin uses write-callback mode (`write(cb) → end()`) rather than `end(str)`
 * to ensure the payload is flushed to the pipe before closing the write end,
 * reducing the chance of kulala-core's intermittent empty-stdout bug.
 */
function invokeAsyncOnce(
  payloadStr: string,
  payload: Record<string, unknown>,
  cwd?: string,
  timeoutMs = 90_000,
): Promise<InvokeResult> {
  return new Promise((resolve, reject) => {
    const exe = resolveCoreBinary();
    const tmpFile = join(
      tmpdir(),
      `kulala-stdout-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`,
    );
    let fdOut: number | undefined;
    try {
      fdOut = openSync(tmpFile, "w");
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const child = spawn(exe, [], {
      stdio: ["pipe", fdOut, "pipe"],
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      env: process.env,
    });

    const stderrChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanupTmp = (): void => {
      if (fdOut !== undefined) {
        try { closeSync(fdOut); } catch { /* ignore */ }
        fdOut = undefined;
      }
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    };

    const cleanupTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanupTimer();
      let stdout = "";
      if (fdOut !== undefined) {
        try { closeSync(fdOut); } catch { /* ignore */ }
        fdOut = undefined;
        try { stdout = readFileSync(tmpFile, "utf-8"); } catch { /* ignore */ }
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }
      resolve({
        stdout,
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code,
      });
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanupTimer();
      cleanupTmp();
      reject(err);
    };

    child.on("error", (err) => {
      fail(err);
    });

    child.on("close", (code) => {
      finish(code);
    });

    // Under custom stdio config, child.stderr / child.stdin may be typed as
    // null (conservative TS inference); the 'pipe' option guarantees non-null.
    if (child.stderr) {
      child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    }

    timer = setTimeout(() => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
      fail(
        new Error(
          `kulala-core call timed out (${timeoutMs}ms); payload.action=${String(payload.action)}`,
        ),
      );
    }, timeoutMs);

    // Write payload and close stdin to trigger kulala-core processing.
    if (child.stdin) {
      child.stdin.write(payloadStr, () => {
        child.stdin?.end();
      });
    } else {
      fail(new Error("child.stdin unavailable, cannot deliver payload"));
    }
  });
}

/** Parses kulala-core stdout as JSON; throws a readable error on failure. */
function parseStdout<T>(job: InvokeResult, action: string): T {
  const raw = job.stdout.trim();
  if (!raw) {
    throw new Error(
      `kulala-core ${action} produced no output (exit code=${job.code})${job.stderr ? `: ${job.stderr.trim()}` : ""}`,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const head = raw.slice(0, 200);
    const tail = raw.slice(-200);
    throw new Error(
      `kulala-core ${action} output is not JSON (${raw.length} bytes, ${msg}): head=${head} ... tail=${tail}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Utilities: URI → filesystem path, filetype inference
 * ------------------------------------------------------------------ */

/** Parses a file:// URI into a local filesystem path; returns undefined for non-file schemes. */
export function uriToFsPath(uri: string): string | undefined {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/** Infers kulala-core filetype from file extension (.rest → rest, otherwise http). */
function filetypeFromUri(uri: string): "http" | "rest" {
  return uri.toLowerCase().endsWith(".rest") ? "rest" : "http";
}

/* ------------------------------------------------------------------ *
 * LSP ↔ kulala-core action mapping
 * ------------------------------------------------------------------ */

/**
 * Common request params: full document content, file path, working directory.
 * kulala-core is a stateless one-shot CLI, so each LSP request must feed it the
 * full document text; the relay assembles this payload in server.ts.
 */
export interface DocContext {
  content: string;
  filepath?: string;
  /** Working directory: used by kulala-core to resolve http-client.env.json and relative resources. */
  cwd?: string;
}

/**
 * Coordinate conversion: LSP 0-based → kulala-core 1-based (line / character both +1).
 * kulala-core uses vim-style 1-based line/column numbers — a key difference between the two sides.
 */
function toKulalaPosition(p: Position): { line: number; column: number } {
  return { line: p.line + 1, column: p.character + 1 };
}

/* ------------------------------------------------------------------ *
 * Async bridging (LSP semantic actions)
 * ------------------------------------------------------------------ */

/** textDocument/completion → action: lsp_completion (async). */
export function lspCompletionAsync(
  ctx: DocContext,
  position: Position,
  uri: string,
): Promise<CompletionList> {
  return lspCompletionAsyncImpl(ctx, position, uri);
}

async function lspCompletionAsyncImpl(
  ctx: DocContext,
  position: Position,
  uri: string,
): Promise<CompletionList> {
  const kulalaPos = toKulalaPosition(position);
  const job = await invokeAsync(
    {
      action: "lsp_completion",
      content: ctx.content,
      filepath: ctx.filepath,
      env: "default",
      filetype: filetypeFromUri(uri),
      line: kulalaPos.line,
      column: kulalaPos.column,
    },
    ctx.cwd,
  );
  return parseStdout<CompletionList>(job, "lsp_completion");
}

/** textDocument/hover → action: lsp_hover (async). */
export async function lspHoverAsync(
  ctx: DocContext,
  position: Position,
  uri: string,
): Promise<Hover | undefined> {
  const kulalaPos = toKulalaPosition(position);
  const job = await invokeAsync(
    {
      action: "lsp_hover",
      content: ctx.content,
      filepath: ctx.filepath,
      env: "default",
      filetype: filetypeFromUri(uri),
      line: kulalaPos.line,
      column: kulalaPos.column,
    },
    ctx.cwd,
  );
  const raw = job.stdout.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Hover;
  } catch {
    return undefined;
  }
}

/** textDocument/documentSymbol → action: lsp_symbols (async). */
export async function lspSymbolsAsync(
  ctx: DocContext,
): Promise<DocumentSymbol[]> {
  const job = await invokeAsync(
    {
      action: "lsp_symbols",
      content: ctx.content,
      filepath: ctx.filepath,
    },
    ctx.cwd,
  );
  return parseStdout<DocumentSymbol[]>(job, "lsp_symbols");
}

/** Diagnostics (debounced on didOpen/didChange) → action: lsp_diagnostics (async). */
export async function lspDiagnosticsAsync(
  ctx: DocContext,
): Promise<Diagnostic[]> {
  const job = await invokeAsync(
    {
      action: "lsp_diagnostics",
      content: ctx.content,
      filepath: ctx.filepath,
    },
    ctx.cwd,
  );
  return parseStdout<Diagnostic[]>(job, "lsp_diagnostics");
}

/* ------------------------------------------------------------------ *
 * Async bridging (formatting) — textDocument/formatting
 * ------------------------------------------------------------------ */

/** format action result type. `changed=false` means the formatted output equals the original. */
export interface FormatResult {
  formatted: string;
  changed: boolean;
}

/**
 * Document formatting → action: format (async).
 *
 * Returns `{ formatted, changed }` on success; the caller builds a TextEdit if
 * `changed` is true. Returns `{ ok: false, error }` on failure.
 */
export async function formatDocumentAsync(
  ctx: DocContext,
): Promise<BridgeResult<FormatResult>> {
  try {
    const job = await invokeAsync(
      {
        action: "format",
        content: ctx.content,
        filepath: ctx.filepath,
      },
      ctx.cwd,
    );
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core format produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`,
      );
    }
    const parsed = JSON.parse(raw) as {
      success?: boolean;
      formatted?: string;
      error?: string;
    };
    if (parsed.success === true && typeof parsed.formatted === "string") {
      // kulala-core CLI doesn't return a `changed` field; compute it ourselves.
      const changed = parsed.formatted !== ctx.content;
      return ok<FormatResult>({ formatted: parsed.formatted, changed });
    }
    return fail<FormatResult>(
      typeof parsed.error === "string" ? parsed.error : "format failed (unknown error)",
    );
  } catch (err) {
    return fail<FormatResult>(err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------------------------------------------ *
 * Async bridging (Code Action types)
 * ------------------------------------------------------------------ */

/**
 * Unified result: `ok: true` + `data` on success; `ok: false` + `error` on failure.
 * server.ts's executeCommand dispatcher handles this uniformly.
 */
export interface BridgeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function ok<T>(data: T): BridgeResult<T> {
  return { ok: true, data };
}

function fail<T>(error: string): BridgeResult<T> {
  return { ok: false, error };
}

/** run action result type. */
export interface RunResult {
  wrapper: KulalaResponseWrapper;
}

/**
 * Send request → action: run (cursorPosition limit).
 *
 * Must pass `limit: [{ filter: "cursorPosition", line, column }]`, otherwise
 * kulala-core runs every block in the document.
 */
export async function runAsync(
  ctx: DocContext,
  cursor: Position,
  env = "default",
): Promise<BridgeResult<RunResult>> {
  try {
    const pos = toKulalaPosition(cursor);
    const job = await invokeAsync(
      {
        action: "run",
        content: ctx.content,
        filepath: ctx.filepath,
        env,
        limit: [
          { filter: "cursorPosition", line: pos.line, column: pos.column },
        ],
        responseFormat: { indent: 2, sort_keys: true },
        haltOnError: true,
      },
      ctx.cwd,
    );
    const wrapper = parseStdout<KulalaResponseWrapper>(job, "run");
    return ok<RunResult>({ wrapper });
  } catch (err) {
    return fail<RunResult>(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Send every request in the document → action: run (no limit).
 *
 * Unlike `runAsync`: no `limit` field (kulala-core runs all blocks in order),
 * and `haltOnError: false` so a single block failure doesn't block the rest.
 */
export async function runAllAsync(
  ctx: DocContext,
  env = "default",
): Promise<BridgeResult<RunResult>> {
  try {
    const job = await invokeAsync(
      {
        action: "run",
        content: ctx.content,
        filepath: ctx.filepath,
        env,
        responseFormat: { indent: 2, sort_keys: true },
        haltOnError: false,
      },
      ctx.cwd,
    );
    const wrapper = parseStdout<KulalaResponseWrapper>(job, "run");
    return ok<RunResult>({ wrapper });
  } catch (err) {
    return fail<RunResult>(err instanceof Error ? err.message : String(err));
  }
}

/** to_curl action result type. */
export interface ToCurlResult {
  curl: string;
  prompt?: string;
}

/** Copy as cURL → action: to_curl. */
export async function toCurlAsync(
  ctx: DocContext,
  cursor: Position,
): Promise<BridgeResult<ToCurlResult>> {
  try {
    const pos = toKulalaPosition(cursor);
    const job = await invokeAsync(
      {
        action: "to_curl",
        content: ctx.content,
        filepath: ctx.filepath,
        line: pos.line,
        column: pos.column,
        env: "default",
      },
      ctx.cwd,
    );
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core to_curl produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`,
      );
    }
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      curl?: string;
      error?: string;
      prompt?: string;
    };
    if (parsed.ok && typeof parsed.curl === "string") {
      return ok<ToCurlResult>({ curl: parsed.curl, prompt: parsed.prompt });
    }
    return fail<ToCurlResult>(
      typeof parsed.error === "string" ? parsed.error : "to_curl failed (unknown error)",
    );
  } catch (err) {
    return fail<ToCurlResult>(err instanceof Error ? err.message : String(err));
  }
}

/** from_curl action result type. */
export interface FromCurlResult {
  lines: string[];
}

/** Paste from cURL → action: from_curl. */
export async function fromCurlAsync(
  curlText: string,
): Promise<BridgeResult<FromCurlResult>> {
  try {
    const job = await invokeAsync({
      action: "from_curl",
      curl: curlText,
    });
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core from_curl produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`,
      );
    }
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      lines?: string[];
      error?: string;
    };
    if (parsed.ok && Array.isArray(parsed.lines)) {
      return ok<FromCurlResult>({ lines: parsed.lines });
    }
    return fail<FromCurlResult>(
      typeof parsed.error === "string" ? parsed.error : "from_curl failed (unknown error)",
    );
  } catch (err) {
    return fail<FromCurlResult>(err instanceof Error ? err.message : String(err));
  }
}

/** inspect_request action result type. */
export interface InspectResult {
  lines: string[];
}

/** Inspect request → action: inspect_request. */
export async function inspectRequestAsync(
  ctx: DocContext,
  cursor: Position,
): Promise<BridgeResult<InspectResult>> {
  try {
    const pos = toKulalaPosition(cursor);
    const job = await invokeAsync(
      {
        action: "inspect_request",
        content: ctx.content,
        filepath: ctx.filepath,
        line: pos.line,
        column: pos.column,
        env: "default",
      },
      ctx.cwd,
    );
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core inspect_request produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`,
      );
    }
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      lines?: string[];
      error?: string;
      prompt?: string;
    };
    if (parsed.ok && Array.isArray(parsed.lines)) {
      return ok<InspectResult>({ lines: parsed.lines });
    }
    return fail<InspectResult>(
      typeof parsed.error === "string"
        ? parsed.error
        : "inspect_request failed (unknown error)",
    );
  } catch (err) {
    return fail<InspectResult>(err instanceof Error ? err.message : String(err));
  }
}

/** graphql_introspect action result type. */
export interface GraphqlIntrospectResult {
  host: string;
  fromCache?: boolean;
}

/** Download GraphQL Schema → action: graphql_introspect. */
export async function graphqlIntrospectAsync(
  ctx: DocContext,
  cursor: Position,
): Promise<BridgeResult<GraphqlIntrospectResult>> {
  try {
    const pos = toKulalaPosition(cursor);
    const job = await invokeAsync(
      {
        action: "graphql_introspect",
        content: ctx.content,
        filepath: ctx.filepath,
        line: pos.line,
        column: pos.column,
        env: "default",
      },
      ctx.cwd,
    );
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core graphql_introspect produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`,
      );
    }
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      host?: string;
      fromCache?: boolean;
      error?: string;
    };
    if (parsed.ok && typeof parsed.host === "string") {
      return ok<GraphqlIntrospectResult>({
        host: parsed.host,
        fromCache: parsed.fromCache,
      });
    }
    return fail<GraphqlIntrospectResult>(
      typeof parsed.error === "string"
        ? parsed.error
        : "graphql_introspect failed (unknown error)",
    );
  } catch (err) {
    return fail<GraphqlIntrospectResult>(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** clear_graphql_schema action result type. */
export interface ClearGraphqlSchemaResult {
  cleared: number;
  hosts?: string[];
}

/** Clear GraphQL Schema cache → action: clear_graphql_schema. Clears all hosts when `host` is omitted. */
export async function clearGraphqlSchemaAsync(
  host?: string,
): Promise<BridgeResult<ClearGraphqlSchemaResult>> {
  try {
    const payload: Record<string, unknown> = {
      action: "clear_graphql_schema",
    };
    if (host) payload.host = host;
    const job = await invokeAsync(payload);
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core clear_graphql_schema produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`,
      );
    }
    const parsed = JSON.parse(raw) as {
      success?: boolean;
      cleared?: number;
      hosts?: string[];
      error?: string;
    };
    if (parsed.success && typeof parsed.cleared === "number") {
      return ok<ClearGraphqlSchemaResult>({
        cleared: parsed.cleared,
        hosts: parsed.hosts,
      });
    }
    return fail<ClearGraphqlSchemaResult>(
      typeof parsed.error === "string"
        ? parsed.error
        : "clear_graphql_schema failed (unknown error)",
    );
  } catch (err) {
    return fail<ClearGraphqlSchemaResult>(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** clear_globals action result type. */
export interface ClearGlobalsResult {
  cleared: true;
}

/** Clear global script variables → action: clear_globals. Clears all globals when `names` is omitted. */
export async function clearGlobalsAsync(
  names?: string[],
): Promise<BridgeResult<ClearGlobalsResult>> {
  try {
    const payload: Record<string, unknown> = {
      action: "clear_globals",
    };
    if (names && names.length > 0) payload.names = names;
    const job = await invokeAsync(payload);
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core clear_globals produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`,
      );
    }
    const parsed = JSON.parse(raw) as {
      type?: string;
      success?: boolean;
      error?: string;
    };
    if (parsed.success === true) {
      return ok<ClearGlobalsResult>({ cleared: true });
    }
    return fail<ClearGlobalsResult>(
      typeof parsed.error === "string" ? parsed.error : "clear_globals failed (unknown error)",
    );
  } catch (err) {
    return fail<ClearGlobalsResult>(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Sync versions (LSP semantic actions only) — retained for compatibility;
 * server.ts has switched to async. May be removed in the future.
 * ------------------------------------------------------------------ */

/** textDocument/completion → action: lsp_completion (sync, legacy entry). */
export function lspCompletion(
  ctx: DocContext,
  position: Position,
  uri: string,
): CompletionList {
  const kulalaPos = toKulalaPosition(position);
  const job = invoke(
    {
      action: "lsp_completion",
      content: ctx.content,
      filepath: ctx.filepath,
      env: "default",
      filetype: filetypeFromUri(uri),
      line: kulalaPos.line,
      column: kulalaPos.column,
    },
    ctx.cwd,
  );
  return parseStdout<CompletionList>(job, "lsp_completion");
}

/** textDocument/hover → action: lsp_hover (sync, legacy entry). */
export function lspHover(
  ctx: DocContext,
  position: Position,
  uri: string,
): Hover | undefined {
  const kulalaPos = toKulalaPosition(position);
  const job = invoke(
    {
      action: "lsp_hover",
      content: ctx.content,
      filepath: ctx.filepath,
      env: "default",
      filetype: filetypeFromUri(uri),
      line: kulalaPos.line,
      column: kulalaPos.column,
    },
    ctx.cwd,
  );
  const raw = job.stdout.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Hover;
  } catch {
    return undefined;
  }
}

/** textDocument/documentSymbol → action: lsp_symbols (sync, legacy entry). */
export function lspSymbols(ctx: DocContext): DocumentSymbol[] {
  const job = invoke(
    {
      action: "lsp_symbols",
      content: ctx.content,
      filepath: ctx.filepath,
    },
    ctx.cwd,
  );
  return parseStdout<DocumentSymbol[]>(job, "lsp_symbols");
}

/** Diagnostics → action: lsp_diagnostics (sync, legacy entry). */
export function lspDiagnostics(ctx: DocContext): Diagnostic[] {
  const job = invoke(
    {
      action: "lsp_diagnostics",
      content: ctx.content,
      filepath: ctx.filepath,
    },
    ctx.cwd,
  );
  return parseStdout<Diagnostic[]>(job, "lsp_diagnostics");
}
