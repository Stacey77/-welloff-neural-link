import 'dotenv/config';

const MCP_URL = process.env.WELLOFF_MCP_URL ?? 'http://localhost:3000/api/mcp';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpContent {
  type: string;
  text: string;
}

let reqId = 1;

async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const body: JsonRpcRequest = { jsonrpc: '2.0', id: reqId++, method, params };
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as JsonRpcResponse<T>;

  if (json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }

  return json.result as T;
}

export async function initializeMcp(): Promise<void> {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'welloff-neural-link', version: '1.0.0' },
  });
}

export async function listMcpTools(): Promise<McpTool[]> {
  const result = await rpc<{ tools: McpTool[] }>('tools/list');
  return result.tools;
}

export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await rpc<{ content: McpContent[] }>('tools/call', {
    name,
    arguments: args,
  });

  const text = result.content.find((c) => c.type === 'text')?.text;
  if (!text) return result.content;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
