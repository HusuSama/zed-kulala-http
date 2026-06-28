/**
 * protocol.ts — LSP base protocol layer.
 *
 * Implements the LSP base protocol frame read/write (Content-Length header +
 * JSON body), declares the LSP message/type subset used by the relay server,
 * and provides JSON-RPC 2.0 request/response/notification envelopes.
 *
 * Zed ↔ relay server communicates via standard LSP over stdio (JSON-RPC 2.0).
 * kulala-core itself does not speak LSP — it is a "one-shot CLI" (stdin JSON in,
 * stdout JSON out). This file handles only the LSP side; the kulala-core
 * bridging lives in bridge.ts.
 */

import type { Readable, Writable } from "node:stream";

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0 message skeleton
 * ------------------------------------------------------------------ */

/** JSON-RPC request: has id, expects a response. */
export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: P;
}

/** JSON-RPC notification: no id, no response expected. */
export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

/** JSON-RPC response: corresponds to a request's id. */
export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  /**
   * Must be a number or string — **never null**.
   *
   * Zed's `RequestId` is `#[serde(untagged)] enum { Int(i32), Str(String) }`;
   * `null` matches neither → the entire response fails to deserialize and is
   * dropped by Zed. Even for ParseError, use string "unknown" or 0 instead of null.
   */
  id: number | string;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

/** Union of all JSON-RPC messages, used for inbound dispatch. */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

/* ------------------------------------------------------------------ *
 * LSP base types (only those used by the relay server)
 * ------------------------------------------------------------------ */

/** Text position: line / character are both 0-based (LSP spec). */
export interface Position {
  line: number;
  character: number;
}

/** Range: start is inclusive, end is exclusive. */
export interface Range {
  start: Position;
  end: Position;
}

/** Text document change event (used for didChange incremental sync). */
export interface TextDocumentContentChangeEvent {
  range: Range;
  rangeLength?: number;
  text: string;
}

/** Document identifier. */
export interface VersionedTextDocumentIdentifier {
  uri: string;
  version: number;
}

/* ------------------------------------------------------------------ *
 * LSP request / notification parameter types
 * ------------------------------------------------------------------ */

export interface DidOpenTextDocumentParams {
  textDocument: {
    uri: string;
    languageId: string;
    version: number;
    text: string;
  };
}

export interface DidChangeTextDocumentParams {
  textDocument: VersionedTextDocumentIdentifier;
  contentChanges: TextDocumentContentChangeEvent[];
}

export interface CompletionParams {
  textDocument: { uri: string };
  position: Position;
}

export interface HoverParams {
  textDocument: { uri: string };
  position: Position;
}

export interface DocumentSymbolParams {
  textDocument: { uri: string };
}

/** textDocument/formatting request params. Options are sent by the client but not consumed here. */
export interface DocumentFormattingParams {
  textDocument: { uri: string };
  options: {
    tabSize: number;
    insertSpaces: boolean;
    insertFinalNewline?: boolean;
    trimFinalNewlines?: boolean;
  };
}

/** LSP TextEdit: replaces text within `range` with `newText`. */
export interface TextEdit {
  range: Range;
  newText: string;
}

/* ------------------------------------------------------------------ *
 * LSP response / notification body types (passthrough of kulala-core output)
 * ------------------------------------------------------------------ */

export interface CompletionItem {
  label: string;
  labelDetails?: { description?: string };
  kind?: number;
  detail?: string;
  documentation?: { kind: "plaintext" | "markdown"; value: string };
  insertText?: string;
  insertTextFormat?: number;
  sortText?: string;
  textEdit?: { range: Range; newText: string };
}

export interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

export interface Hover {
  contents:
    | string
    | { kind: "plaintext" | "markdown"; value: string }
    | { language: string; value: string };
}

export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
}

/** publishDiagnostics notification params. */
export interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: Diagnostic[];
}

/* ------------------------------------------------------------------ *
 * kulala-core response types (mirror runner/types.ts KulalaResponseWrapper)
 * ------------------------------------------------------------------ */

export interface KulalaScriptConsoleEntry {
  level: "log" | "error" | "warn" | "info" | "debug";
  message: string;
  origin: {
    phase: string;
    source: string;
    file: string;
    httpDirectiveLine: number;
    line?: number;
    column?: number;
  };
  kind?: "log" | "test" | "assert";
  testName?: string;
  status?: "pass" | "fail";
}

export interface KulalaRequestSent {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export type KulalaResponseBody =
  | { type: "text"; content: string; mediaType?: string }
  | {
      type: "binary";
      content: string;
      encoding: "base64";
      byteLength: number;
      mediaType?: string;
    }
  | { type: "json"; content: Record<string, unknown>; formatted?: string };

export interface KulalaSuccessResponse {
  success: true;
  blockName?: string;
  status: number;
  httpVersion?: string;
  headers: Record<string, string>;
  url: string;
  request?: KulalaRequestSent;
  timings: Record<string, number>;
  body: KulalaResponseBody;
  rawBody?: string;
  filteredBody?: KulalaResponseBody;
  jqFilter?: string;
  redirectChain?: Array<Partial<KulalaSuccessResponse>>;
  verboseTrace?: string;
  scriptConsole?: KulalaScriptConsoleEntry[];
}

export interface KulalaErrorResponse {
  success: false;
  blockName?: string;
  error: string;
  scriptConsole?: KulalaScriptConsoleEntry[];
  httpCompleted?: boolean;
  status?: number;
  httpVersion?: string;
  headers?: Record<string, string>;
  url?: string;
  request?: KulalaRequestSent;
  timings?: Record<string, number>;
  body?: KulalaResponseBody;
  rawBody?: string;
  filteredBody?: KulalaResponseBody;
  redirectChain?: Array<Partial<KulalaSuccessResponse>>;
  verboseTrace?: string;
}

export interface KulalaPromptResponse {
  success: false;
  prompt: true;
  promptId: string;
  promptType: string;
  message: string;
  inputs: Array<{
    id: string;
    label: string;
    type: "text" | "password" | "url";
    required?: boolean;
  }>;
}

export interface KulalaSkippedResponse {
  success: true;
  skipped: true;
  blockName?: string;
  scriptConsole?: KulalaScriptConsoleEntry[];
}

export interface KulalaWebSocketPlanResponse {
  success: true;
  protocol: "websocket";
  url: string;
  initialMessage?: string;
  request?: KulalaRequestSent;
  jqFilter?: string;
}

export type KulalaResponseItem =
  | KulalaSuccessResponse
  | KulalaErrorResponse
  | KulalaPromptResponse
  | KulalaSkippedResponse
  | KulalaWebSocketPlanResponse;

export interface KulalaResponseWrapper {
  type: "responses" | "error";
  data: KulalaResponseItem[];
}

/* ------------------------------------------------------------------ *
 * Server capabilities / initialize result
 * ------------------------------------------------------------------ */

export interface ServerCapabilities {
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  hoverProvider?: boolean;
  documentSymbolProvider?: boolean;
  textDocumentSync?: number;
  /** Code Action capability (true = simple support, no resolveProvider). */
  codeActionProvider?: boolean;
  /** Command execution capability (all command strings must be listed, or Zed skips unlisted ones). */
  executeCommandProvider?: { commands: string[] };
  /** Document formatting capability (textDocument/formatting). */
  documentFormattingProvider?: boolean;
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
}

/* ------------------------------------------------------------------ *
 * CodeAction / Command / WorkspaceEdit
 * ------------------------------------------------------------------ */

/** LSP Command: triggered by CodeAction, dispatched via workspace/executeCommand. */
export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

/** LSP CodeAction: may be edit-only, command-only, or both. */
export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
}

/** textDocument/codeAction request params. */
export interface CodeActionParams {
  textDocument: { uri: string };
  range: Range;
  context: {
    diagnostics: Diagnostic[];
    only?: string[];
    triggerKind?: number;
  };
}

/** workspace/executeCommand request params. */
export interface ExecuteCommandParams {
  command: string;
  arguments?: unknown[];
}

/** TextDocumentEdit: a single document edit within documentChanges. */
export interface TextDocumentEdit {
  textDocument: { uri: string; version: number | null };
  edits: Array<{ range: Range; newText: string }>;
}

/** CreateFile resource operation. */
export interface CreateFile {
  kind: "create";
  uri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

/** DeleteFile resource operation. */
export interface DeleteFile {
  kind: "delete";
  uri: string;
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
}

/** RenameFile resource operation. */
export interface RenameFile {
  kind: "rename";
  oldUri: string;
  newUri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export type DocumentChange =
  | TextDocumentEdit
  | CreateFile
  | DeleteFile
  | RenameFile;

/** LSP WorkspaceEdit. */
export interface WorkspaceEdit {
  changes?: Record<string, Array<{ range: Range; newText: string }>>;
  documentChanges?: DocumentChange[];
}

/** workspace/applyEdit request params. */
export interface ApplyWorkspaceEditParams {
  label: string;
  edit: WorkspaceEdit;
}

/** workspace/applyEdit response. */
export interface ApplyWorkspaceEditResponse {
  applied: boolean;
  failedChange?: string;
  failureReason?: string;
}

/* ------------------------------------------------------------------ *
 * window/showMessage / showMessageRequest
 * ------------------------------------------------------------------ */

export type MessageType = 1 | 2 | 3 | 4; // Error / Warning / Info / Log

/** window/showMessage notification params. */
export interface ShowMessageParams {
  type: MessageType;
  message: string;
}

/** window/showMessageRequest request params (with action options). */
export interface ShowMessageRequestParams {
  type: MessageType;
  message: string;
  actions?: Array<{ title: string }>;
}

/** window/showMessageRequest response: the user-selected action or null. */
export interface MessageActionItem {
  title: string;
}

/* ------------------------------------------------------------------ *
 * JSON-RPC error codes (LSP convention)
 * ------------------------------------------------------------------ */
export enum JsonRpcErrorCodes {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

/* ------------------------------------------------------------------ *
 * LSP base protocol framing: reader/writer
 * ------------------------------------------------------------------ */

/**
 * LspConnection — stdio-based LSP message reader/writer.
 *
 * Reads complete JSON messages from the input stream by `Content-Length` header,
 * writes base-protocol-compliant messages to the output stream, and supports
 * server → client requests via `request()` (auto-incrementing id, pending table
 * resolved in `tryConsume`).
 *
 * Inbound dispatch (LSP spec):
 *   - has id + has method = client → server request (to onMessage)
 *   - no id + has method = client → server notification (to onMessage)
 *   - has id + no method = response to a server request (dispatched to pendingRequests)
 */
export class LspConnection {
  // Must use Buffer (bytes) rather than string (characters).
  // LSP base protocol Content-Length is measured in **bytes**, while string
  // length/slice counts **characters**. When the body contains multi-byte UTF-8
  // chars (e.g. CJK, emoji), bytes ≠ chars; using string would misalign frame
  // boundaries and cascade-parse-fail all subsequent frames. Buffer operates on
  // bytes, matching Content-Length semantics.
  private buffer = Buffer.alloc(0);
  private nextRequestId = 0;
  private readonly pendingRequests = new Map<
    number | string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  /** Starts the read loop; calls onMessage for each inbound message (responses excluded). */
  start(onMessage: (msg: JsonRpcMessage) => void): void {
    this.input.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      this.buffer = Buffer.concat([this.buffer, buf]);
      this.tryConsume(onMessage);
    });
  }

  /** Parses as many complete messages as possible from the buffer. */
  private tryConsume(onMessage: (msg: JsonRpcMessage) => void): void {
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
      const msg = JSON.parse(body) as JsonRpcMessage;
      // Response: id present, method absent → resolve/reject pending request.
      if ("id" in msg && !("method" in msg)) {
        const resp = msg as JsonRpcResponse;
        const key = resp.id;
        if (key !== null && key !== undefined) {
          const pending = this.pendingRequests.get(key);
          if (pending) {
            this.pendingRequests.delete(key);
            if (resp.error) {
              pending.reject(
                new Error(
                  `${resp.error.message} (code=${resp.error.code}${resp.error.data !== undefined ? ` data=${JSON.stringify(resp.error.data)}` : ""})`,
                ),
              );
            } else {
              pending.resolve(resp.result);
            }
          }
        }
      } else {
        // Request or notification → hand to upper handler.
        onMessage(msg);
      }
    } catch {
      // Drop the unparseable frame to avoid blocking subsequent messages.
      // We don't send a ParseError response: JSON-RPC requires an id on error
      // responses, but on parse failure we can't obtain the id. Sending id:null
      // would make Zed's RequestId::untagged deserialization fail and discard
      // the whole response (noisy logs), masking the root cause. Silent drop +
      // stderr log is clearer.
      console.error(
        `[kulala-ls] Failed to parse JSON-RPC message body: ${body.slice(0, 200)}`,
      );
    }

    if (this.buffer.length > 0) this.tryConsume(onMessage);
  }

  /** Writes a JSON-RPC message (auto-adds Content-Length header). */
  send(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    const json = JSON.stringify(message);
    const bodyBuf = Buffer.from(json, "utf-8");
    const header = `Content-Length: ${bodyBuf.length}\r\n\r\n`;
    this.output.write(Buffer.concat([Buffer.from(header, "utf-8"), bodyBuf]));
  }

  /** Sends a notification (no id). */
  notify<P>(method: string, params?: P): void {
    this.send({ jsonrpc: "2.0", method, params } satisfies JsonRpcNotification);
  }

  /**
   * Sends a server → client request (with id), returns a Promise.
   * Resolves/rejects when the client replies with the matching id.
   *
   * Timeout handling is the caller's responsibility (LSP spec doesn't mandate
   * server-side timeouts).
   */
  request<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
      });
      this.send({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest);
    });
  }

  /** Sends a success response for a request. */
  ok(id: number | string | null, result: unknown): void {
    if (id === null) return;
    this.send({ jsonrpc: "2.0", id, result } satisfies JsonRpcResponse);
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
  sendError(id: number | string | null, code: number, message: string): void {
    if (id === null) return;
    this.send({ jsonrpc: "2.0", id, error: { code, message } } satisfies JsonRpcResponse);
  }
}
