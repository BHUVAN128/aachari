/**
 * Fake Brave Search MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * It ships the same string-shaped tool errors the official
 * `@brave/brave-search-mcp-server@2.1.4` emits — the HTTP status is embedded at
 * the start of the flattened message because the server throws
 * `new Error(`${status} ${statusText}\n${body}`)` — so the real classifier in
 * `@upcraft/providers` is tested against realistic payloads, not a mock shape.
 *
 * Scenario is selected with `FAKE_BRAVE_SCENARIO`:
 *   success            two grounded sources with long snippets
 *   empty              valid response with empty `grounding.generic`
 *   flaky-then-success fail the first `FAKE_BRAVE_FAIL_FIRST` calls with 429
 *   error-401|403|429|500  isError with the status embedded in the text
 *   schema-missing     `brave_llm_context` drops count/max tokens/threshold
 *   hang               never answer `tools/call` (forces a client timeout)
 *   truncated          emit a partial JSON line and stall
 *   child-exit         exit before initialize (missing key / npx failure)
 *
 * Run as: node test/pipeline/steps/s02-research/brave/fake-brave-mcp.ts
 */

const scenario = process.env.FAKE_BRAVE_SCENARIO ?? "success";
const failFirst = Number(process.env.FAKE_BRAVE_FAIL_FIRST ?? "0");

const SENTENCE = "Photosynthesis converts light energy into chemical energy stored in glucose, using chlorophyll to absorb light and releasing oxygen as a by-product. ";

const grounding = {
  grounding: {
    generic: [
      { url: "https://www.example.edu/photosynthesis", title: "Photosynthesis — overview", snippets: [SENTENCE.repeat(25).trim(), SENTENCE.repeat(25).trim()] },
      { url: "https://www.example.org/light-reactions", title: "Light-dependent reactions", snippets: [SENTENCE.repeat(3).trim()] },
    ],
    poi: { results: [] },
    map: { results: [] },
  },
  sources: {
    "https://www.example.edu/photosynthesis": { title: "Photosynthesis — overview", snippets: [SENTENCE.repeat(25).trim()] },
    "https://www.example.org/light-reactions": { title: "Light-dependent reactions", snippets: [SENTENCE.repeat(3).trim()] },
  },
};

const fullSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    count: { type: "integer" },
    maximum_number_of_urls: { type: "integer" },
    maximum_number_of_tokens: { type: "integer" },
    maximum_number_of_snippets: { type: "integer" },
    maximum_number_of_tokens_per_url: { type: "integer" },
    context_threshold_mode: { type: "string" },
    safesearch: { type: "string" },
    freshness: { type: "string" },
    goggles: { type: "string" },
    country: { type: "string" },
    search_lang: { type: "string" },
  },
};

// The 1.x-era schema: proves the init assertion catches drift loudly.
const narrowedSchema = { type: "object", properties: { query: { type: "string" }, country: { type: "string" }, search_lang: { type: "string" } } };

const STATUS_TEXT: Record<string, string> = { "401": "Unauthorized", "403": "Forbidden", "429": "Too Many Requests", "500": "Internal Server Error" };

if (scenario === "child-exit") {
  process.stderr.write("BRAVE_API_KEY is required\n");
  process.exit(1);
}

let buffer = "";
let toolCalls = 0;

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const ok = (id: number, result: unknown): void => send({ jsonrpc: "2.0", id, result });
const fail = (id: number, code: number, message: string): void => send({ jsonrpc: "2.0", id, error: { code, message } });

const handle = (message: { id?: number; method?: string }): void => {
  if (message.method === "initialize") return ok(message.id as number, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-brave-search-mcp-server", version: "2.1.4" } });
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    const inputSchema = scenario === "schema-missing" ? narrowedSchema : fullSchema;
    return ok(message.id as number, { tools: [{ name: "brave_llm_context", description: "Brave LLM Context", inputSchema }] });
  }
  if (message.method === "tools/call") {
    toolCalls += 1;
    if (scenario === "hang") return;
    if (scenario === "truncated") {
      process.stdout.write(`{"jsonrpc":"2.0","id":${message.id},"result":{"content":[{"type":"text","text":"{\\"grounding\\":`);
      return;
    }
    if (scenario.startsWith("error-")) {
      const status = scenario.slice("error-".length);
      return ok(message.id as number, { isError: true, content: [{ type: "text", text: `${status} ${STATUS_TEXT[status] ?? "Error"}\n{"error":"upstream failure"}` }] });
    }
    if (scenario === "flaky-then-success" && toolCalls <= failFirst) {
      return ok(message.id as number, { isError: true, content: [{ type: "text", text: '429 Too Many Requests\n{"error":"rate limited"}' }] });
    }
    if (scenario === "empty") {
      return ok(message.id as number, { content: [{ type: "text", text: JSON.stringify({ grounding: { generic: [] } }) }], structuredContent: { grounding: { generic: [] } } });
    }
    return ok(message.id as number, { content: [{ type: "text", text: JSON.stringify(grounding) }], structuredContent: grounding });
  }
  if (typeof message.id === "number") fail(message.id, -32601, `Method not found: ${message.method ?? "unknown"}`);
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line) as { id?: number; method?: string });
      } catch {
        /* ignore malformed frames */
      }
    }
    index = buffer.indexOf("\n");
  }
});
