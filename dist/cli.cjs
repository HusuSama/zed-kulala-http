#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ls/server.ts
var import_node_process = __toESM(require("node:process"), 1);
var import_node_path2 = require("node:path");
var import_node_fs2 = require("node:fs");
var import_node_child_process2 = require("node:child_process");
var import_node_os2 = require("node:os");

// ls/protocol.ts
var LspConnection = class {
  constructor(input, output) {
    this.input = input;
    this.output = output;
  }
  // Must use Buffer (bytes) rather than string (characters).
  // LSP base protocol Content-Length is measured in **bytes**, while string
  // length/slice counts **characters**. When the body contains multi-byte UTF-8
  // chars (e.g. CJK, emoji), bytes ≠ chars; using string would misalign frame
  // boundaries and cascade-parse-fail all subsequent frames. Buffer operates on
  // bytes, matching Content-Length semantics.
  buffer = Buffer.alloc(0);
  nextRequestId = 0;
  pendingRequests = /* @__PURE__ */ new Map();
  /** Starts the read loop; calls onMessage for each inbound message (responses excluded). */
  start(onMessage) {
    this.input.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      this.buffer = Buffer.concat([this.buffer, buf]);
      this.tryConsume(onMessage);
    });
  }
  /** Parses as many complete messages as possible from the buffer. */
  tryConsume(onMessage) {
    const sep = Buffer.from("\r\n\r\n");
    const headerEnd = this.buffer.indexOf(sep);
    if (headerEnd === -1) return;
    const headerBlock = this.buffer.subarray(0, headerEnd).toString("utf-8");
    const bodyStart = headerEnd + 4;
    const m = headerBlock.match(/content-length:\s*(\d+)/i);
    if (!m || !m[1]) return;
    const length = Number.parseInt(m[1], 10);
    if (Number.isNaN(length)) return;
    if (this.buffer.length - bodyStart < length) return;
    const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
    this.buffer = this.buffer.subarray(bodyStart + length);
    try {
      const msg = JSON.parse(body);
      if ("id" in msg && !("method" in msg)) {
        const resp = msg;
        const key = resp.id;
        if (key !== null && key !== void 0) {
          const pending = this.pendingRequests.get(key);
          if (pending) {
            this.pendingRequests.delete(key);
            if (resp.error) {
              pending.reject(
                new Error(
                  `${resp.error.message} (code=${resp.error.code}${resp.error.data !== void 0 ? ` data=${JSON.stringify(resp.error.data)}` : ""})`
                )
              );
            } else {
              pending.resolve(resp.result);
            }
          }
        }
      } else {
        onMessage(msg);
      }
    } catch {
      console.error(
        `[kulala-ls] Failed to parse JSON-RPC message body: ${body.slice(0, 200)}`
      );
    }
    if (this.buffer.length > 0) this.tryConsume(onMessage);
  }
  /** Writes a JSON-RPC message (auto-adds Content-Length header). */
  send(message) {
    const json = JSON.stringify(message);
    const bodyBuf = Buffer.from(json, "utf-8");
    const header = `Content-Length: ${bodyBuf.length}\r
\r
`;
    this.output.write(Buffer.concat([Buffer.from(header, "utf-8"), bodyBuf]));
  }
  /** Sends a notification (no id). */
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  /**
   * Sends a server → client request (with id), returns a Promise.
   * Resolves/rejects when the client replies with the matching id.
   *
   * Timeout handling is the caller's responsibility (LSP spec doesn't mandate
   * server-side timeouts).
   */
  request(method, params) {
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (r) => resolve(r),
        reject
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  /** Sends a success response for a request. */
  ok(id, result) {
    if (id === null) return;
    this.send({ jsonrpc: "2.0", id, result });
  }
  /**
   * Sends an error response for a request.
   *
   * When `id: null`, the error is swallowed (no response sent) — Zed's
   * `RequestId` is an `untagged enum { Int, Str }`; `null` matches neither and
   * would make the whole response fail to deserialize. JSON-RPC permits null id
   * for "unrecognized request" errors, but Zed doesn't tolerate this. So parse
   * errors / unknown ids must be silently dropped.
   */
  sendError(id, code, message) {
    if (id === null) return;
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }
};

// ls/bridge.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_url = require("node:url");
function kulalaCoreBinaryName() {
  return process.platform === "win32" ? "kulala-core.exe" : "kulala-core";
}
function resolveCoreBinary() {
  const envPath = process.env.KULALA_CORE_BIN;
  if (envPath && envPath.length > 0) {
    if ((0, import_node_fs.existsSync)(envPath)) return envPath;
    throw new Error(`KULALA_CORE_BIN points to a non-existent binary: ${envPath}`);
  }
  const binName = kulalaCoreBinaryName();
  const candidates = [
    (0, import_node_path.join)(__dirname, "..", "node_modules", "@mistweaverco", "kulala-core", "dist", "bin", binName),
    (0, import_node_path.join)(__dirname, "..", "..", "node_modules", "@mistweaverco", "kulala-core", "dist", "bin", binName)
  ];
  for (const c of candidates) {
    if ((0, import_node_fs.existsSync)(c)) return c;
  }
  throw new Error(
    "kulala-core binary not found. Tried the following paths:\n" + candidates.map((c) => `  - ${c}`).join("\n") + "\nStart the relay via the Zed extension (lib.rs), or ensure kulala-core is installed in node_modules."
  );
}
function ensureCore() {
  return resolveCoreBinary();
}
var INVOKE_MAX_RETRIES = 3;
async function invokeAsync(payload, cwd, timeoutMs = 9e4) {
  const payloadStr = `${JSON.stringify(payload)}
`;
  let lastResult;
  for (let attempt = 0; attempt < INVOKE_MAX_RETRIES; attempt++) {
    lastResult = await invokeAsyncOnce(payloadStr, payload, cwd, timeoutMs);
    if (lastResult.stdout.trim().length > 0) return lastResult;
    if (lastResult.code !== 0) return lastResult;
  }
  return lastResult;
}
function invokeAsyncOnce(payloadStr, payload, cwd, timeoutMs = 9e4) {
  return new Promise((resolve, reject) => {
    const exe = resolveCoreBinary();
    const tmpFile = (0, import_node_path.join)(
      (0, import_node_os.tmpdir)(),
      `kulala-stdout-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`
    );
    let fdOut;
    try {
      fdOut = (0, import_node_fs.openSync)(tmpFile, "w");
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const child = (0, import_node_child_process.spawn)(exe, [], {
      stdio: ["pipe", fdOut, "pipe"],
      cwd: cwd && cwd.length > 0 ? cwd : void 0,
      env: process.env
    });
    const stderrChunks = [];
    let timer;
    let settled = false;
    const cleanupTmp = () => {
      if (fdOut !== void 0) {
        try {
          (0, import_node_fs.closeSync)(fdOut);
        } catch {
        }
        fdOut = void 0;
      }
      try {
        (0, import_node_fs.unlinkSync)(tmpFile);
      } catch {
      }
    };
    const cleanupTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = void 0;
      }
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      cleanupTimer();
      let stdout = "";
      if (fdOut !== void 0) {
        try {
          (0, import_node_fs.closeSync)(fdOut);
        } catch {
        }
        fdOut = void 0;
        try {
          stdout = (0, import_node_fs.readFileSync)(tmpFile, "utf-8");
        } catch {
        }
        try {
          (0, import_node_fs.unlinkSync)(tmpFile);
        } catch {
        }
      }
      resolve({
        stdout,
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code
      });
    };
    const fail2 = (err) => {
      if (settled) return;
      settled = true;
      cleanupTimer();
      cleanupTmp();
      reject(err);
    };
    child.on("error", (err) => {
      fail2(err);
    });
    child.on("close", (code) => {
      finish(code);
    });
    if (child.stderr) {
      child.stderr.on("data", (c) => stderrChunks.push(c));
    }
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2e3);
      killTimer.unref?.();
      fail2(
        new Error(
          `kulala-core call timed out (${timeoutMs}ms); payload.action=${String(payload.action)}`
        )
      );
    }, timeoutMs);
    if (child.stdin) {
      child.stdin.write(payloadStr, () => {
        child.stdin?.end();
      });
    } else {
      fail2(new Error("child.stdin unavailable, cannot deliver payload"));
    }
  });
}
function parseStdout(job, action) {
  const raw = job.stdout.trim();
  if (!raw) {
    throw new Error(
      `kulala-core ${action} produced no output (exit code=${job.code})${job.stderr ? `: ${job.stderr.trim()}` : ""}`
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const head = raw.slice(0, 200);
    const tail = raw.slice(-200);
    throw new Error(
      `kulala-core ${action} output is not JSON (${raw.length} bytes, ${msg}): head=${head} ... tail=${tail}`
    );
  }
}
function uriToFsPath(uri) {
  if (!uri.startsWith("file:")) return void 0;
  try {
    return (0, import_node_url.fileURLToPath)(uri);
  } catch {
    return void 0;
  }
}
function filetypeFromUri(uri) {
  return uri.toLowerCase().endsWith(".rest") ? "rest" : "http";
}
function toKulalaPosition(p) {
  return { line: p.line + 1, column: p.character + 1 };
}
function lspCompletionAsync(ctx, position, uri) {
  return lspCompletionAsyncImpl(ctx, position, uri);
}
async function lspCompletionAsyncImpl(ctx, position, uri) {
  const kulalaPos = toKulalaPosition(position);
  const job = await invokeAsync(
    {
      action: "lsp_completion",
      content: ctx.content,
      filepath: ctx.filepath,
      env: "default",
      filetype: filetypeFromUri(uri),
      line: kulalaPos.line,
      column: kulalaPos.column
    },
    ctx.cwd
  );
  return parseStdout(job, "lsp_completion");
}
async function lspHoverAsync(ctx, position, uri) {
  const kulalaPos = toKulalaPosition(position);
  const job = await invokeAsync(
    {
      action: "lsp_hover",
      content: ctx.content,
      filepath: ctx.filepath,
      env: "default",
      filetype: filetypeFromUri(uri),
      line: kulalaPos.line,
      column: kulalaPos.column
    },
    ctx.cwd
  );
  const raw = job.stdout.trim();
  if (!raw) return void 0;
  try {
    return JSON.parse(raw);
  } catch {
    return void 0;
  }
}
async function lspSymbolsAsync(ctx) {
  const job = await invokeAsync(
    {
      action: "lsp_symbols",
      content: ctx.content,
      filepath: ctx.filepath
    },
    ctx.cwd
  );
  return parseStdout(job, "lsp_symbols");
}
async function lspDiagnosticsAsync(ctx) {
  const job = await invokeAsync(
    {
      action: "lsp_diagnostics",
      content: ctx.content,
      filepath: ctx.filepath
    },
    ctx.cwd
  );
  return parseStdout(job, "lsp_diagnostics");
}
async function formatDocumentAsync(ctx) {
  try {
    const job = await invokeAsync(
      {
        action: "format",
        content: ctx.content,
        filepath: ctx.filepath
      },
      ctx.cwd
    );
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core format produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`
      );
    }
    const parsed = JSON.parse(raw);
    if (parsed.success === true && typeof parsed.formatted === "string") {
      const changed = parsed.formatted !== ctx.content;
      return ok({ formatted: parsed.formatted, changed });
    }
    return fail(
      typeof parsed.error === "string" ? parsed.error : "format failed (unknown error)"
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
function ok(data) {
  return { ok: true, data };
}
function fail(error) {
  return { ok: false, error };
}
async function runAsync(ctx, cursor, env = "default") {
  try {
    const pos = toKulalaPosition(cursor);
    const job = await invokeAsync(
      {
        action: "run",
        content: ctx.content,
        filepath: ctx.filepath,
        env,
        limit: [
          { filter: "cursorPosition", line: pos.line, column: pos.column }
        ],
        responseFormat: { indent: 2, sort_keys: true },
        haltOnError: true
      },
      ctx.cwd
    );
    const wrapper = parseStdout(job, "run");
    return ok({ wrapper });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
async function runAllAsync(ctx, env = "default") {
  try {
    const job = await invokeAsync(
      {
        action: "run",
        content: ctx.content,
        filepath: ctx.filepath,
        env,
        responseFormat: { indent: 2, sort_keys: true },
        haltOnError: false
      },
      ctx.cwd
    );
    const wrapper = parseStdout(job, "run");
    return ok({ wrapper });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
async function toCurlAsync(ctx, cursor) {
  try {
    const pos = toKulalaPosition(cursor);
    const job = await invokeAsync(
      {
        action: "to_curl",
        content: ctx.content,
        filepath: ctx.filepath,
        line: pos.line,
        column: pos.column,
        env: "default"
      },
      ctx.cwd
    );
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core to_curl produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`
      );
    }
    const parsed = JSON.parse(raw);
    if (parsed.ok && typeof parsed.curl === "string") {
      return ok({ curl: parsed.curl, prompt: parsed.prompt });
    }
    return fail(
      typeof parsed.error === "string" ? parsed.error : "to_curl failed (unknown error)"
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
async function fromCurlAsync(curlText) {
  try {
    const job = await invokeAsync({
      action: "from_curl",
      curl: curlText
    });
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core from_curl produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`
      );
    }
    const parsed = JSON.parse(raw);
    if (parsed.ok && Array.isArray(parsed.lines)) {
      return ok({ lines: parsed.lines });
    }
    return fail(
      typeof parsed.error === "string" ? parsed.error : "from_curl failed (unknown error)"
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
async function inspectRequestAsync(ctx, cursor) {
  try {
    const pos = toKulalaPosition(cursor);
    const job = await invokeAsync(
      {
        action: "inspect_request",
        content: ctx.content,
        filepath: ctx.filepath,
        line: pos.line,
        column: pos.column,
        env: "default"
      },
      ctx.cwd
    );
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core inspect_request produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`
      );
    }
    const parsed = JSON.parse(raw);
    if (parsed.ok && Array.isArray(parsed.lines)) {
      return ok({ lines: parsed.lines });
    }
    return fail(
      typeof parsed.error === "string" ? parsed.error : "inspect_request failed (unknown error)"
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
async function graphqlIntrospectAsync(ctx, cursor) {
  try {
    const pos = toKulalaPosition(cursor);
    const job = await invokeAsync(
      {
        action: "graphql_introspect",
        content: ctx.content,
        filepath: ctx.filepath,
        line: pos.line,
        column: pos.column,
        env: "default"
      },
      ctx.cwd
    );
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core graphql_introspect produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`
      );
    }
    const parsed = JSON.parse(raw);
    if (parsed.ok && typeof parsed.host === "string") {
      return ok({
        host: parsed.host,
        fromCache: parsed.fromCache
      });
    }
    return fail(
      typeof parsed.error === "string" ? parsed.error : "graphql_introspect failed (unknown error)"
    );
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : String(err)
    );
  }
}
async function clearGraphqlSchemaAsync(host) {
  try {
    const payload = {
      action: "clear_graphql_schema"
    };
    if (host) payload.host = host;
    const job = await invokeAsync(payload);
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core clear_graphql_schema produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`
      );
    }
    const parsed = JSON.parse(raw);
    if (parsed.success && typeof parsed.cleared === "number") {
      return ok({
        cleared: parsed.cleared,
        hosts: parsed.hosts
      });
    }
    return fail(
      typeof parsed.error === "string" ? parsed.error : "clear_graphql_schema failed (unknown error)"
    );
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : String(err)
    );
  }
}
async function clearGlobalsAsync(names) {
  try {
    const payload = {
      action: "clear_globals"
    };
    if (names && names.length > 0) payload.names = names;
    const job = await invokeAsync(payload);
    const raw = job.stdout.trim();
    if (!raw) {
      throw new Error(
        `kulala-core clear_globals produced no output${job.stderr ? `: ${job.stderr.trim()}` : ""}`
      );
    }
    const parsed = JSON.parse(raw);
    if (parsed.success === true) {
      return ok({ cleared: true });
    }
    return fail(
      typeof parsed.error === "string" ? parsed.error : "clear_globals failed (unknown error)"
    );
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ls/format.ts
function indent(text, prefix = "  ") {
  return text.split("\n").map((l) => `${prefix}${l}`).join("\n");
}
function formatHeaders(headers) {
  if (!headers) return "(none)";
  const entries = Object.entries(headers);
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}: ${v}`).join("\n");
}
function formatTimings(timings) {
  if (!timings) return null;
  const keys = ["dns", "tcp", "tls", "request", "firstByte", "total"];
  const parts = [];
  let hasNonZero = false;
  for (const k of keys) {
    const v = timings[k];
    if (typeof v === "number") {
      parts.push(`${k}=${v}ms`);
      if (v > 0) hasNonZero = true;
    }
  }
  if (!hasNonZero) return null;
  return `# timings: ${parts.join(", ")}`;
}
function tryPrettyJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}
function formatBody(body, rawBody) {
  if (!body) {
    if (rawBody) return tryPrettyJson(rawBody);
    return "(empty)";
  }
  switch (body.type) {
    case "text":
      return body.content ? tryPrettyJson(body.content) : "(empty)";
    case "json": {
      if (body.formatted) return body.formatted;
      try {
        return JSON.stringify(body.content, null, 2);
      } catch {
        return String(body.content);
      }
    }
    case "binary":
      return `# (binary body, ${body.byteLength} bytes, mediaType=${body.mediaType ?? "unknown"}; base64 omitted)`;
    default:
      return "(unknown body type)";
  }
}
function formatScriptConsole(entries) {
  if (!entries || entries.length === 0) return null;
  const lines = entries.map((e) => {
    const loc = `${e.origin.phase}:${e.origin.file}:${e.origin.line ?? e.origin.httpDirectiveLine}`;
    const test = e.kind === "test" && e.testName ? ` [${e.testName}: ${e.status ?? "?"}]` : "";
    return `[${loc}] ${e.level}:${test} ${e.message}`;
  });
  return `### Script console
${lines.join("\n")}`;
}
function formatRedirectChain(chain) {
  if (!chain || chain.length === 0) return null;
  const lines = chain.map((r, i) => {
    const status = r.status ?? "?";
    const url = r.url ?? "(unknown url)";
    return `[${i + 1}/${chain.length}] HTTP ${status} ${url}`;
  });
  return `### Redirect chain
${lines.join("\n")}`;
}
function formatItem(item, index) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  if (item.success && !item.skipped && !item.protocol) {
    const r2 = item;
    const blockName2 = r2.blockName ?? `request-${index + 1}`;
    const method = r2.request?.method ?? "?";
    const url = r2.request?.url ?? r2.url;
    const reqHeaders = formatHeaders(r2.request?.headers);
    const reqBody = r2.request?.body && r2.request.body.length > 0 ? tryPrettyJson(r2.request.body) : "(empty)";
    const resHeaders = formatHeaders(r2.headers);
    const resBody = formatBody(r2.body, r2.rawBody);
    const timings = formatTimings(r2.timings);
    const console3 = formatScriptConsole(r2.scriptConsole);
    const redirects2 = formatRedirectChain(r2.redirectChain);
    const sections2 = [];
    sections2.push(`### Request: ${blockName2} | ${method} ${url}`);
    sections2.push(`# Time: ${timestamp}`);
    if (timings) sections2.push(timings);
    if (r2.jqFilter) sections2.push(`# jqFilter: ${r2.jqFilter}`);
    sections2.push("");
    sections2.push(`${method} ${url} HTTP/1.1`);
    sections2.push(reqHeaders);
    sections2.push("");
    sections2.push(reqBody);
    sections2.push("");
    sections2.push(`### Response: HTTP ${r2.status} ${r2.httpVersion ?? "1.1"}`);
    sections2.push(resHeaders);
    sections2.push("");
    sections2.push(resBody);
    if (console3) {
      sections2.push("");
      sections2.push(console3);
    }
    if (redirects2) {
      sections2.push("");
      sections2.push(redirects2);
    }
    if (r2.verboseTrace) {
      sections2.push("");
      sections2.push("### Verbose trace");
      sections2.push(indent(r2.verboseTrace));
    }
    return sections2.join("\n");
  }
  if (item.skipped) {
    const r2 = item;
    const blockName2 = r2.blockName ?? `request-${index + 1}`;
    const sections2 = [];
    sections2.push(`### Request: ${blockName2} (skipped)`);
    sections2.push(`# Time: ${timestamp}`);
    sections2.push("# This request was skipped by a pre-request script.");
    const console3 = formatScriptConsole(r2.scriptConsole);
    if (console3) {
      sections2.push("");
      sections2.push(console3);
    }
    return sections2.join("\n");
  }
  if (item.protocol === "websocket") {
    const r2 = item;
    const sections2 = [];
    sections2.push(`### WebSocket plan: ${r2.url}`);
    sections2.push(`# Time: ${timestamp}`);
    sections2.push("# kulala-core returned a WebSocket plan; not executed.");
    if (r2.initialMessage) {
      sections2.push("");
      sections2.push("# initialMessage:");
      sections2.push(indent(r2.initialMessage));
    }
    if (r2.jqFilter) sections2.push(`# jqFilter: ${r2.jqFilter}`);
    return sections2.join("\n");
  }
  if (item.prompt) {
    const r2 = item;
    const sections2 = [];
    sections2.push(`### Prompt required (promptId=${r2.promptId})`);
    sections2.push(`# Time: ${timestamp}`);
    sections2.push(`# promptType: ${r2.promptType}`);
    sections2.push(`# message: ${r2.message}`);
    if (r2.inputs.length > 0) {
      sections2.push("");
      sections2.push("# inputs:");
      for (const inp of r2.inputs) {
        const req = inp.required ? " (required)" : "";
        sections2.push(`#   - ${inp.id} [${inp.type}]${req}: ${inp.label}`);
      }
    }
    return sections2.join("\n");
  }
  const r = item;
  const blockName = r.blockName ?? `request-${index + 1}`;
  const sections = [];
  sections.push(`### Request: ${blockName} (ERROR)`);
  sections.push(`# Time: ${timestamp}`);
  sections.push(`# ERROR: ${r.error}`);
  if (r.httpCompleted) {
    sections.push("# HTTP request completed, but a post-request script failed.");
    if (r.status !== void 0) {
      sections.push("");
      sections.push(`### Response: HTTP ${r.status} ${r.httpVersion ?? "1.1"}`);
      sections.push(formatHeaders(r.headers));
      sections.push("");
      sections.push(formatBody(r.body, r.rawBody));
    }
  }
  const console2 = formatScriptConsole(r.scriptConsole);
  if (console2) {
    sections.push("");
    sections.push(console2);
  }
  const redirects = formatRedirectChain(r.redirectChain);
  if (redirects) {
    sections.push("");
    sections.push(redirects);
  }
  return sections.join("\n");
}
function formatRunResponse(wrapper) {
  return wrapper.data.map((item, idx2) => formatItem(item, idx2));
}
function formatInspectLines(lines) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const header = `### Inspect result
# Time: ${timestamp}
`;
  return `${header}
${lines.join("\n")}
`;
}

// ls/server.ts
var TRIGGER_CHARS = [":", "/", "{", "%", "$", ".", "(", '"', "'", "-"];
var DIAG_DEBOUNCE_MS = 75;
var HTTP_SUFFIXES = [".http", ".rest"];
var COMMANDS = [
  "kulala.sendRequest",
  "kulala.sendRequestAll",
  "kulala.copyAsCurl",
  "kulala.pasteFromCurl",
  "kulala.inspectRequest",
  "kulala.downloadGraphqlSchema",
  "kulala.clearGraphqlSchemaCache",
  "kulala.clearGlobals",
  "kulala.clearResponses"
];
var TMP_DIR_FALLBACK = (() => {
  try {
    return (0, import_node_path2.join)((0, import_node_os2.homedir)(), ".kulala", "responses");
  } catch {
    return (0, import_node_path2.join)((0, import_node_os2.tmpdir)(), "kulala-ls");
  }
})();
var PROJECT_CACHE_SUBDIR = (0, import_node_path2.join)(".kulala-cache", "response");
var TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var KULALA_TASK_TAG = "kulala-http-request";
var docs = /* @__PURE__ */ new Map();
var diagTimers = /* @__PURE__ */ new Map();
function isHttpUri(uri) {
  const lower = uri.toLowerCase();
  return HTTP_SUFFIXES.some((suf) => lower.endsWith(suf));
}
function docContext(uri) {
  const doc = docs.get(uri);
  if (!doc) {
    throw new Error(`Document not open: ${uri}`);
  }
  const filepath = uriToFsPath(uri);
  const cwd = filepath ? (0, import_node_path2.dirname)(filepath) : void 0;
  return { content: doc.text, filepath, cwd };
}
function scheduleDiagnostics(uri) {
  const existing = diagTimers.get(uri);
  if (existing) clearTimeout(existing);
  if (!isHttpUri(uri)) return;
  const timer = setTimeout(() => {
    diagTimers.delete(uri);
    void refreshDiagnostics(uri);
  }, DIAG_DEBOUNCE_MS);
  diagTimers.set(uri, timer);
}
async function refreshDiagnostics(uri) {
  let diagnostics = [];
  try {
    const ctx = docContext(uri);
    diagnostics = await lspDiagnosticsAsync(ctx);
  } catch (err) {
    console.error(`[kulala-ls] diagnostics failed ${uri}:`, err instanceof Error ? err.message : err);
  }
  conn.notify("textDocument/publishDiagnostics", {
    uri,
    diagnostics
  });
}
function applyChange(text, change) {
  if (change.range) {
    const lines = text.split(/\r?\n/);
    const { start, end } = change.range;
    const startIdx = idx(lines, start.line, start.character);
    const endIdx = idx(lines, end.line, end.character);
    return text.slice(0, startIdx) + change.text + text.slice(endIdx);
  }
  return change.text;
}
function idx(lines, line, character) {
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset + character;
}
function endPositionOfText(text) {
  const lines = text.split(/\r?\n/);
  const last = lines[lines.length - 1] ?? "";
  return { line: lines.length - 1, character: last.length };
}
function ensureTmpDir() {
  try {
    (0, import_node_fs2.mkdirSync)(TMP_DIR_FALLBACK, { recursive: true });
    cleanupOldFiles(TMP_DIR_FALLBACK, "");
  } catch (err) {
    console.error(`[kulala-ls] failed to create temp dir ${TMP_DIR_FALLBACK}:`, err);
  }
}
function resolveProjectCacheDir(filepath) {
  const envRoot = import_node_process.default.env.KULALA_PROJECT_ROOT;
  if (envRoot && envRoot.length > 0) {
    const dir = (0, import_node_path2.join)(envRoot, PROJECT_CACHE_SUBDIR);
    ensureGitignore((0, import_node_path2.join)(envRoot, ".kulala-cache"));
    return dir;
  }
  if (filepath) {
    let dir = (0, import_node_path2.dirname)(filepath);
    for (let cur = dir; cur && cur !== (0, import_node_path2.dirname)(cur); cur = (0, import_node_path2.dirname)(cur)) {
      if ((0, import_node_fs2.existsSync)((0, import_node_path2.join)(cur, ".git"))) {
        dir = cur;
        break;
      }
    }
    const cacheDir = (0, import_node_path2.join)(dir, PROJECT_CACHE_SUBDIR);
    ensureGitignore((0, import_node_path2.join)(dir, ".kulala-cache"));
    return cacheDir;
  }
  return TMP_DIR_FALLBACK;
}
function ensureGitignore(kulalaCacheDir) {
  const gitignorePath = (0, import_node_path2.join)(kulalaCacheDir, ".gitignore");
  const EXPECTED = "*\n!.gitignore\n";
  try {
    if ((0, import_node_fs2.existsSync)(gitignorePath)) {
      return;
    }
    (0, import_node_fs2.mkdirSync)(kulalaCacheDir, { recursive: true });
    (0, import_node_fs2.writeFileSync)(gitignorePath, EXPECTED, "utf-8");
  } catch (err) {
    console.error(`[kulala-ls] failed to create ${gitignorePath}:`, err instanceof Error ? err.message : err);
  }
}
function cleanupOldFiles(dir, prefix) {
  try {
    const now = Date.now();
    const files = (0, import_node_fs2.readdirSync)(dir).filter((name) => prefix === "" || name.startsWith(prefix + "-"));
    for (const name of files) {
      const path = (0, import_node_path2.join)(dir, name);
      try {
        const st = (0, import_node_fs2.statSync)(path);
        if (st.isFile() && now - st.mtimeMs > TMP_MAX_AGE_MS) {
          (0, import_node_fs2.rmSync)(path, { force: true });
        }
      } catch {
      }
    }
  } catch {
  }
}
function writeTmpFile(dir, prefix, ext, content, index = 0) {
  (0, import_node_fs2.mkdirSync)(dir, { recursive: true });
  const ts = Date.now();
  const name = index === 0 ? `${prefix}-${ts}.${ext}` : `${prefix}-${ts}-${index}.${ext}`;
  const path = (0, import_node_path2.join)(dir, name);
  (0, import_node_fs2.writeFileSync)(path, content, "utf-8");
  cleanupOldFiles(dir, prefix);
  return path;
}
function sanitizeBlockName(name) {
  const sanitized = name.replace(/[\/\\:*?"<>|@\s]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) return "request";
  return sanitized.length > 40 ? sanitized.slice(0, 40) : sanitized;
}
function statusTag(item) {
  if (item.success) {
    if (item.skipped) return "SKIP";
    if (item.protocol === "websocket") return "WS";
    const r2 = item;
    return typeof r2.status === "number" ? String(r2.status) : "OK";
  }
  if (item.prompt) return "PROMPT";
  const r = item;
  return typeof r.status === "number" ? String(r.status) : "ERR";
}
function formatMMddHHmmss(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${mm}${dd}-${hh}${mi}${ss}`;
}
function buildResponseFilename(item, index, total) {
  const rawName = item.blockName ?? `request-${index + 1}`;
  const block = sanitizeBlockName(rawName);
  const status = statusTag(item);
  const time = formatMMddHHmmss(/* @__PURE__ */ new Date());
  const suffix = total > 1 ? `-${index + 1}` : "";
  return `resp-${block}-${status}-${time}${suffix}.kulala`;
}
function writeNamedFile(dir, filename, content) {
  (0, import_node_fs2.mkdirSync)(dir, { recursive: true });
  const path = (0, import_node_path2.join)(dir, filename);
  (0, import_node_fs2.writeFileSync)(path, content, "utf-8");
  const prefix = filename.split("-")[0] ?? "";
  cleanupOldFiles(dir, prefix);
  return path;
}
function readClipboard() {
  const platform = import_node_process.default.platform;
  let cmd;
  if (platform === "darwin") {
    cmd = { exe: "pbpaste", args: [] };
  } else if (platform === "win32") {
    cmd = {
      exe: "powershell",
      args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"]
    };
  } else if (platform === "linux") {
    if ((0, import_node_fs2.existsSync)("/usr/bin/xclip") || whichSync("xclip")) {
      cmd = { exe: "xclip", args: ["-selection", "clipboard", "-o"] };
    } else if ((0, import_node_fs2.existsSync)("/usr/bin/xsel") || whichSync("xsel")) {
      cmd = { exe: "xsel", args: ["--clipboard", "--output"] };
    }
  }
  if (!cmd) return void 0;
  try {
    const r = (0, import_node_child_process2.spawnSync)(cmd.exe, cmd.args, { encoding: "utf-8", timeout: 5e3 });
    if (r.error || r.status !== 0) return void 0;
    return (r.stdout ?? "").replace(/\r\n$/, "\n").replace(/\n$/, "");
  } catch {
    return void 0;
  }
}
function whichSync(exe) {
  const path = import_node_process.default.env.PATH;
  if (!path) return false;
  for (const dir of path.split(":")) {
    if (dir && (0, import_node_fs2.existsSync)((0, import_node_path2.join)(dir, exe))) return true;
  }
  return false;
}
function showMessage(type, message) {
  conn.notify("window/showMessage", { type, message });
}
async function withProgress(title, fn) {
  const token = `kulala-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let active = false;
  try {
    await conn.request("window/workDoneProgress/create", { token });
    active = true;
  } catch (err) {
    console.error(`[kulala-ls] workDoneProgress/create failed, degrading to no-progress:`, err instanceof Error ? err.message : err);
  }
  const report = (message, percentage) => {
    if (!active) return;
    conn.notify("$/progress", {
      token,
      value: { kind: "report", message, percentage }
    });
  };
  if (active) {
    conn.notify("$/progress", {
      token,
      value: { kind: "begin", title, cancellable: false }
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
function openInZed(path) {
  let child;
  try {
    child = (0, import_node_child_process2.spawn)("zed", ["-e", path], { stdio: "ignore", detached: true });
  } catch (err) {
    console.error(`[kulala-ls] failed to spawn zed:`, err instanceof Error ? err.message : err);
    return;
  }
  child.on("error", (err) => {
    console.error(`[kulala-ls] zed -e failed (${path}):`, err.message);
  });
  child.unref();
}
function ensureWorkspaceTask() {
  const autoCreate = import_node_process.default.env.KULALA_AUTO_CREATE_TASK ?? "false";
  if (autoCreate !== "true") return;
  const root = import_node_process.default.env.KULALA_PROJECT_ROOT;
  if (!root || root.length === 0) {
    console.error("[kulala-ls] ensureWorkspaceTask: KULALA_PROJECT_ROOT not set, skipping task auto-write");
    return;
  }
  const zedDir = (0, import_node_path2.join)(root, ".zed");
  const tasksPath = (0, import_node_path2.join)(zedDir, "tasks.json");
  const cliPath = (0, import_node_path2.join)(__dirname, "cli.cjs");
  const TASK_TEMPLATE = {
    label: "Kulala: Run in Terminal",
    command: "node",
    args: [`"${cliPath}"`, "run", "$ZED_FILE", "$ZED_ROW"],
    tags: [KULALA_TASK_TAG],
    reveal: "always"
  };
  let existing = [];
  if ((0, import_node_fs2.existsSync)(tasksPath)) {
    try {
      const raw = (0, import_node_fs2.readFileSync)(tasksPath, "utf-8");
      existing = JSON.parse(raw);
    } catch (err) {
      console.error(
        `[kulala-ls] ensureWorkspaceTask: ${tasksPath} parse failed, skipping auto-write (to avoid corrupting user data):`,
        err instanceof Error ? err.message : err
      );
      return;
    }
  }
  let tasks;
  if (Array.isArray(existing)) {
    tasks = existing;
  } else if (existing && typeof existing === "object") {
    tasks = [existing];
  } else {
    tasks = [];
  }
  const hasKulalaTask = tasks.some((t) => {
    if (!t || typeof t !== "object") return false;
    const tags = t.tags;
    return Array.isArray(tags) && tags.includes(KULALA_TASK_TAG);
  });
  if (hasKulalaTask) return;
  try {
    (0, import_node_fs2.mkdirSync)(zedDir, { recursive: true });
    const next = [...tasks, TASK_TEMPLATE];
    const text = `${JSON.stringify(next, null, 2)}
`;
    (0, import_node_fs2.writeFileSync)(tasksPath, text, "utf-8");
    console.error(`[kulala-ls] ensureWorkspaceTask: wrote ${tasksPath} (appended ${KULALA_TASK_TAG} task)`);
  } catch (err) {
    console.error(
      `[kulala-ls] ensureWorkspaceTask: failed to write ${tasksPath}:`,
      err instanceof Error ? err.message : err
    );
  }
}
async function runCli(file, row) {
  const lineNum = Number.parseInt(row, 10);
  if (!Number.isFinite(lineNum) || lineNum < 1) {
    console.error(`[kulala-ls] CLI run: invalid line number "${row}" (expected 1-based positive integer)`);
    import_node_process.default.exit(1);
  }
  let content;
  try {
    content = (0, import_node_fs2.readFileSync)(file, "utf-8");
  } catch (err) {
    console.error(
      `[kulala-ls] CLI run: failed to read file ${file}:`,
      err instanceof Error ? err.message : err
    );
    import_node_process.default.exit(1);
  }
  const ctx = { content, filepath: file, cwd: (0, import_node_path2.dirname)(file) };
  const position = { line: lineNum - 1, character: 0 };
  const result = await runAsync(ctx, position);
  if (!result.ok || !result.data) {
    console.error(
      `[kulala-ls] CLI run: request failed: ${result.error ?? "unknown error"}`
    );
    import_node_process.default.exit(1);
  }
  const texts = formatRunResponse(result.data.wrapper);
  import_node_process.default.stdout.write(texts.join("\n\n"));
  if (texts.length > 0) {
    import_node_process.default.stdout.write("\n");
  }
  import_node_process.default.exit(0);
}
function dispatchCliMode() {
  const argv = import_node_process.default.argv.slice(2);
  if (argv[0] !== "run") return false;
  const file = argv[1];
  const row = argv[2];
  if (!file || !row) {
    console.error("[kulala-ls] CLI run usage: node dist/cli.cjs run <file> <line>");
    import_node_process.default.exit(1);
  }
  void runCli(file, row);
  return true;
}
var conn = new LspConnection(import_node_process.default.stdin, import_node_process.default.stdout);
var shutdownRequested = false;
function buildCodeAction(title, command, uri, position) {
  return {
    title,
    kind: "source",
    command: {
      title,
      command,
      arguments: [{ uri, position }]
    }
  };
}
function parseCommandArg(args) {
  const arg = args?.[0];
  if (!arg || typeof arg !== "object") {
    throw new Error("executeCommand argument missing or not an object");
  }
  const obj = arg;
  if (typeof obj.uri !== "string") {
    throw new Error("executeCommand argument uri missing or not a string");
  }
  if (!obj.position || typeof obj.position !== "object" || typeof obj.position.line !== "number" || typeof obj.position.character !== "number") {
    throw new Error("executeCommand argument position missing or malformed");
  }
  return {
    uri: obj.uri,
    position: obj.position
  };
}
function parseUriArg(args) {
  const arg = args?.[0];
  if (!arg || typeof arg !== "object") {
    throw new Error("executeCommand argument missing or not an object");
  }
  const obj = arg;
  if (typeof obj.uri !== "string") {
    throw new Error("executeCommand argument uri missing or not a string");
  }
  return { uri: obj.uri };
}
function hintForKulalaError(error) {
  if (!error) return "";
  if (error.includes("cannot be parsed as a URL")) {
    return " (Hint: URL missing scheme; use http:// or https:// prefix)";
  }
  return "";
}
async function executeCommand(params) {
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
async function handleSendRequest(params) {
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
async function handleSendRequestAll(params) {
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
async function writeRunResponsesAndNotify(ctx, wrapper) {
  const cacheDir = resolveProjectCacheDir(ctx.filepath);
  const texts = formatRunResponse(wrapper);
  const paths = [];
  texts.forEach((text, idx2) => {
    const item = wrapper.data[idx2];
    const filename = buildResponseFilename(item, idx2, texts.length);
    const path = writeNamedFile(cacheDir, filename, text);
    paths.push(path);
  });
  if (paths[0]) {
    openInZed(paths[0]);
  }
  const hasPrompt = wrapper.data.some((d) => "prompt" in d && d.prompt);
  const hasWebSocket = wrapper.data.some(
    (d) => "protocol" in d && d.protocol === "websocket"
  );
  const hasError = wrapper.type === "error" || wrapper.data.some((d) => !d.success);
  const hasSkipped = wrapper.data.some((d) => "skipped" in d && d.skipped);
  if (hasPrompt) {
    showMessage(
      1,
      "Request needs interactive input (OAuth2 etc.). Not supported in Zed; use Neovim + kulala.nvim. See temp file for prompt details."
    );
  } else if (hasWebSocket) {
    showMessage(
      2,
      "WebSocket requests are not yet supported in Zed. See temp file for plan details."
    );
  } else if (hasError) {
    const first = paths[0] ?? "(no file)";
    const extra = paths.length > 1 ? ` (+${paths.length - 1} more)` : "";
    const errDetail = wrapper.data.find(
      (d) => d.success === false && "error" in d && typeof d.error === "string"
    );
    const hint = hintForKulalaError(errDetail?.error);
    showMessage(
      1,
      `Request failed.${hint} See: ${first}${extra} (cmd+P search "resp")`
    );
  } else if (hasSkipped) {
    showMessage(
      3,
      `Request was skipped by pre-request script. See: ${paths[0] ?? "(no file)"}`
    );
  } else {
    const first = paths[0] ?? "(no file)";
    const extra = paths.length > 1 ? ` (+${paths.length - 1} more)` : "";
    showMessage(
      3,
      `Response saved to: ${first}${extra} (cmd+P search "resp" to open)`
    );
  }
  return null;
}
async function handleCopyAsCurl(params) {
  const { uri, position } = parseCommandArg(params.arguments);
  const ctx = docContext(uri);
  const result = await toCurlAsync(ctx, position);
  if (!result.ok || !result.data) {
    const hint = hintForKulalaError(result.error);
    const msg = `Copy as cURL failed${hint}: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  const text = `# Generated at ${(/* @__PURE__ */ new Date()).toISOString()}

${result.data.curl}
`;
  const cacheDir = resolveProjectCacheDir(ctx.filepath);
  const path = writeTmpFile(cacheDir, "curl", "kulala", text);
  openInZed(path);
  showMessage(3, `cURL saved to: ${path} (cmd+P search "curl" to open)`);
  return null;
}
async function handlePasteFromCurl(params) {
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
  const newText = `${result.data.lines.join("\n")}

`;
  const editParams = {
    label: "Paste from cURL",
    edit: {
      documentChanges: [
        {
          textDocument: { uri, version: null },
          edits: [{ range: { start: position, end: position }, newText }]
        }
      ]
    }
  };
  try {
    const resp = await conn.request(
      "workspace/applyEdit",
      editParams
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
async function handleInspectRequest(params) {
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
async function handleDownloadGraphqlSchema(params) {
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
async function handleClearGraphqlSchemaCache() {
  const result = await clearGraphqlSchemaAsync();
  if (!result.ok || !result.data) {
    const msg = `Clear GraphQL Schema Cache failed: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  showMessage(3, `Cleared ${result.data.cleared} GraphQL schema cache entries`);
  return null;
}
async function handleClearGlobals() {
  const result = await clearGlobalsAsync();
  if (!result.ok || !result.data) {
    const msg = `Clear Globals failed: ${result.error ?? "unknown error"}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  showMessage(3, "Cleared all global script variables");
  return null;
}
async function handleClearResponses(params) {
  const { uri } = parseUriArg(params.arguments);
  const filepath = uriToFsPath(uri);
  const cacheDir = resolveProjectCacheDir(filepath);
  let files;
  try {
    files = (0, import_node_fs2.readdirSync)(cacheDir);
  } catch (err) {
    const msg = `Clear Responses failed (cannot read ${cacheDir}): ${err instanceof Error ? err.message : err}`;
    showMessage(1, msg);
    throw new Error(msg);
  }
  const counts = {};
  let cleared = 0;
  for (const name of files) {
    const prefix = name.split("-")[0] ?? "other";
    counts[prefix] = (counts[prefix] ?? 0) + 1;
    const full = (0, import_node_path2.join)(cacheDir, name);
    try {
      const st = (0, import_node_fs2.statSync)(full);
      if (st.isFile()) {
        (0, import_node_fs2.rmSync)(full, { force: true });
        cleared++;
      }
    } catch {
      try {
        (0, import_node_fs2.rmSync)(full, { force: true });
        cleared++;
      } catch {
      }
    }
  }
  const breakdown = Object.entries(counts).filter(([_, n]) => n > 0).map(([p, n]) => `${p}=${n}`).join(", ");
  showMessage(
    3,
    `Cleared ${cleared} file${cleared === 1 ? "" : "s"} from .kulala-cache/response/${breakdown ? ` (${breakdown})` : ""}`
  );
  return null;
}
async function handle(msg) {
  if ("id" in msg && "method" in msg) {
    const req = msg;
    const id = req.id;
    try {
      switch (req.method) {
        case "initialize": {
          ensureTmpDir();
          const result = {
            capabilities: {
              textDocumentSync: 1,
              // Full
              completionProvider: { triggerCharacters: TRIGGER_CHARS, resolveProvider: false },
              hoverProvider: true,
              documentSymbolProvider: true,
              codeActionProvider: true,
              executeCommandProvider: { commands: [...COMMANDS] },
              // Supports Zed `formatter: "language_server"` + `format_on_save`:
              // on save (or manual format) Zed sends textDocument/formatting.
              documentFormattingProvider: true
            },
            serverInfo: { name: "kulala-ls", version: "0.1.0" }
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
          const params = req.params;
          const uri = params.textDocument.uri;
          const list = await lspCompletionAsync(docContext(uri), params.position, uri);
          conn.ok(id, list);
          return;
        }
        case "textDocument/hover": {
          ensureCore();
          const params = req.params;
          const uri = params.textDocument.uri;
          const hover = await lspHoverAsync(docContext(uri), params.position, uri);
          conn.ok(id, hover ?? null);
          return;
        }
        case "textDocument/documentSymbol": {
          ensureCore();
          const params = req.params;
          const uri = params.textDocument.uri;
          const symbols = await lspSymbolsAsync(docContext(uri));
          conn.ok(id, symbols);
          return;
        }
        case "textDocument/formatting": {
          ensureCore();
          const params = req.params;
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
              result.error ?? "unknown error"
            );
            conn.ok(id, []);
            return;
          }
          if (!result.data.changed) {
            conn.ok(id, []);
            return;
          }
          const end = endPositionOfText(ctx.content);
          const edits = [
            {
              range: { start: { line: 0, character: 0 }, end },
              newText: result.data.formatted
            }
          ];
          conn.ok(id, edits);
          return;
        }
        case "textDocument/codeAction": {
          const params = req.params;
          const uri = params.textDocument.uri;
          if (!isHttpUri(uri)) {
            conn.ok(id, []);
            return;
          }
          const position = params.range.start;
          const actions = [
            buildCodeAction("Kulala: Send Request", "kulala.sendRequest", uri, position),
            buildCodeAction("Kulala: Send All Requests", "kulala.sendRequestAll", uri, position),
            buildCodeAction("Kulala: Copy as cURL", "kulala.copyAsCurl", uri, position),
            buildCodeAction("Kulala: Paste from cURL", "kulala.pasteFromCurl", uri, position),
            buildCodeAction("Kulala: Inspect Current Request", "kulala.inspectRequest", uri, position),
            buildCodeAction("Kulala: Download GraphQL Schema", "kulala.downloadGraphqlSchema", uri, position),
            buildCodeAction("Kulala: Clear GraphQL Schema Cache", "kulala.clearGraphqlSchemaCache", uri, position),
            buildCodeAction("Kulala: Clear Globals", "kulala.clearGlobals", uri, position),
            buildCodeAction("Kulala: Clear Responses", "kulala.clearResponses", uri, position)
          ];
          conn.ok(id, actions);
          return;
        }
        case "workspace/executeCommand": {
          ensureCore();
          const params = req.params;
          const result = await executeCommand(params);
          conn.ok(id, result);
          return;
        }
        default: {
          conn.sendError(id, -32601 /* MethodNotFound */, `Unknown method: ${req.method}`);
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[kulala-ls] request ${req.method} failed:`, message);
      conn.sendError(id, -32603 /* InternalError */, message);
    }
    return;
  }
  if ("method" in msg) {
    const note = msg;
    switch (note.method) {
      case "initialized":
        break;
      case "exit":
        import_node_process.default.exit(shutdownRequested ? 0 : 1);
        break;
      case "textDocument/didOpen": {
        const params = note.params;
        const { uri, text, version } = params.textDocument;
        docs.set(uri, { text, version });
        scheduleDiagnostics(uri);
        break;
      }
      case "textDocument/didChange": {
        const params = note.params;
        const { uri, version } = params.textDocument;
        const cur = docs.get(uri);
        let text = cur?.text ?? "";
        for (const ch of params.contentChanges) text = applyChange(text, ch);
        docs.set(uri, { text, version });
        scheduleDiagnostics(uri);
        break;
      }
      case "textDocument/didClose": {
        const params = note.params;
        const uri = params.textDocument.uri;
        docs.delete(uri);
        conn.notify("textDocument/publishDiagnostics", {
          uri,
          diagnostics: []
        });
        break;
      }
      default:
        break;
    }
  }
}
if (dispatchCliMode()) {
} else {
  ensureWorkspaceTask();
  conn.start((msg) => {
    void handle(msg);
  });
}
import_node_process.default.on("uncaughtException", (err) => {
  console.error("[kulala-ls] uncaught exception:", err instanceof Error ? err.message : err);
});
import_node_process.default.on("unhandledRejection", (err) => {
  console.error("[kulala-ls] unhandled promise rejection:", err instanceof Error ? err.message : err);
});
//# sourceMappingURL=cli.cjs.map
