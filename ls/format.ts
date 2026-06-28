/**
 * format.ts — kulala-core response text formatting.
 *
 * Formats the KulalaResponseWrapper returned by the `run` action into readable
 * .http text (written to temp files), and wraps `inspect_request` output with a
 * title.
 */

import type {
  KulalaErrorResponse,
  KulalaPromptResponse,
  KulalaResponseItem,
  KulalaResponseWrapper,
  KulalaScriptConsoleEntry,
  KulalaSkippedResponse,
  KulalaSuccessResponse,
  KulalaWebSocketPlanResponse,
} from "./protocol";

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((l) => `${prefix}${l}`)
    .join("\n");
}

function formatHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return "(none)";
  const entries = Object.entries(headers);
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}: ${v}`).join("\n");
}

function formatTimings(timings: Record<string, number> | undefined): string | null {
  if (!timings) return null;
  const keys = ["dns", "tcp", "tls", "request", "firstByte", "total"] as const;
  const parts: string[] = [];
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

function tryPrettyJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function formatBody(
  body: KulalaSuccessResponse["body"] | undefined,
  rawBody?: string,
): string {
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

function formatScriptConsole(
  entries: KulalaScriptConsoleEntry[] | undefined,
): string | null {
  if (!entries || entries.length === 0) return null;
  const lines = entries.map((e) => {
    const loc = `${e.origin.phase}:${e.origin.file}:${e.origin.line ?? e.origin.httpDirectiveLine}`;
    const test = e.kind === "test" && e.testName ? ` [${e.testName}: ${e.status ?? "?"}]` : "";
    return `[${loc}] ${e.level}:${test} ${e.message}`;
  });
  return `### Script console\n${lines.join("\n")}`;
}

function formatRedirectChain(
  chain: Array<Partial<KulalaSuccessResponse>> | undefined,
): string | null {
  if (!chain || chain.length === 0) return null;
  const lines = chain.map((r, i) => {
    const status = r.status ?? "?";
    const url = r.url ?? "(unknown url)";
    return `[${i + 1}/${chain.length}] HTTP ${status} ${url}`;
  });
  return `### Redirect chain\n${lines.join("\n")}`;
}

function formatItem(item: KulalaResponseItem, index: number): string {
  const timestamp = new Date().toISOString();

  if (item.success && !(item as KulalaSkippedResponse).skipped && !(item as KulalaWebSocketPlanResponse).protocol) {
    const r = item as KulalaSuccessResponse;
    const blockName = r.blockName ?? `request-${index + 1}`;
    const method = r.request?.method ?? "?";
    const url = r.request?.url ?? r.url;
    const reqHeaders = formatHeaders(r.request?.headers);
    const reqBody = r.request?.body && r.request.body.length > 0
      ? tryPrettyJson(r.request.body)
      : "(empty)";
    const resHeaders = formatHeaders(r.headers);
    const resBody = formatBody(r.body, r.rawBody);
    const timings = formatTimings(r.timings);
    const console = formatScriptConsole(r.scriptConsole);
    const redirects = formatRedirectChain(r.redirectChain);

    const sections: string[] = [];
    sections.push(`### Request: ${blockName} | ${method} ${url}`);
    sections.push(`# Time: ${timestamp}`);
    if (timings) sections.push(timings);
    if (r.jqFilter) sections.push(`# jqFilter: ${r.jqFilter}`);
    sections.push("");
    sections.push(`${method} ${url} HTTP/1.1`);
    sections.push(reqHeaders);
    sections.push("");
    sections.push(reqBody);
    sections.push("");
    sections.push(`### Response: HTTP ${r.status} ${r.httpVersion ?? "1.1"}`);
    sections.push(resHeaders);
    sections.push("");
    sections.push(resBody);
    if (console) {
      sections.push("");
      sections.push(console);
    }
    if (redirects) {
      sections.push("");
      sections.push(redirects);
    }
    if (r.verboseTrace) {
      sections.push("");
      sections.push("### Verbose trace");
      sections.push(indent(r.verboseTrace));
    }
    return sections.join("\n");
  }

  if ((item as KulalaSkippedResponse).skipped) {
    const r = item as KulalaSkippedResponse;
    const blockName = r.blockName ?? `request-${index + 1}`;
    const sections: string[] = [];
    sections.push(`### Request: ${blockName} (skipped)`);
    sections.push(`# Time: ${timestamp}`);
    sections.push("# This request was skipped by a pre-request script.");
    const console = formatScriptConsole(r.scriptConsole);
    if (console) {
      sections.push("");
      sections.push(console);
    }
    return sections.join("\n");
  }

  if ((item as KulalaWebSocketPlanResponse).protocol === "websocket") {
    const r = item as KulalaWebSocketPlanResponse;
    const sections: string[] = [];
    sections.push(`### WebSocket plan: ${r.url}`);
    sections.push(`# Time: ${timestamp}`);
    sections.push("# kulala-core returned a WebSocket plan; not executed.");
    if (r.initialMessage) {
      sections.push("");
      sections.push("# initialMessage:");
      sections.push(indent(r.initialMessage));
    }
    if (r.jqFilter) sections.push(`# jqFilter: ${r.jqFilter}`);
    return sections.join("\n");
  }

  if ((item as KulalaPromptResponse).prompt) {
    const r = item as KulalaPromptResponse;
    const sections: string[] = [];
    sections.push(`### Prompt required (promptId=${r.promptId})`);
    sections.push(`# Time: ${timestamp}`);
    sections.push(`# promptType: ${r.promptType}`);
    sections.push(`# message: ${r.message}`);
    if (r.inputs.length > 0) {
      sections.push("");
      sections.push("# inputs:");
      for (const inp of r.inputs) {
        const req = inp.required ? " (required)" : "";
        sections.push(`#   - ${inp.id} [${inp.type}]${req}: ${inp.label}`);
      }
    }
    return sections.join("\n");
  }

  const r = item as KulalaErrorResponse;
  const blockName = r.blockName ?? `request-${index + 1}`;
  const sections: string[] = [];
  sections.push(`### Request: ${blockName} (ERROR)`);
  sections.push(`# Time: ${timestamp}`);
  sections.push(`# ERROR: ${r.error}`);
  if (r.httpCompleted) {
    sections.push("# HTTP request completed, but a post-request script failed.");
    if (r.status !== undefined) {
      sections.push("");
      sections.push(`### Response: HTTP ${r.status} ${r.httpVersion ?? "1.1"}`);
      sections.push(formatHeaders(r.headers));
      sections.push("");
      sections.push(formatBody(r.body, r.rawBody));
    }
  }
  const console = formatScriptConsole(r.scriptConsole);
  if (console) {
    sections.push("");
    sections.push(console);
  }
  const redirects = formatRedirectChain(r.redirectChain);
  if (redirects) {
    sections.push("");
    sections.push(redirects);
  }
  return sections.join("\n");
}

/**
 * Formats the `run` action wrapper into a string array.
 * Array length equals wrapper.data.length; each element is the content of one temp file.
 */
export function formatRunResponse(wrapper: KulalaResponseWrapper): string[] {
  return wrapper.data.map((item, idx) => formatItem(item, idx));
}

/** Wraps the `inspect_request` lines with a title. */
export function formatInspectLines(lines: string[]): string {
  const timestamp = new Date().toISOString();
  const header = `### Inspect result\n# Time: ${timestamp}\n`;
  return `${header}\n${lines.join("\n")}\n`;
}
