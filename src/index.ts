import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Remote MCP Server (header‑only API‑Key)
 * --------------------------------------
 * ‣ No KV / durable storage
 * ‣ Every call must carry the key via:
 *      – Authorization: Bearer <key>
 *      – X‑API‑KEY: <key>
 *      – ?API_KEY=<key>
 *      – tool param `apiKey`
 */

interface Env { [k: string]: unknown }

// Global connection-based API key storage (keyed by connection fingerprint)
const connectionApiKeys = new Map<string, { apiKey: string, lastUsed: number }>();

// Store current request's API key for access during tool execution
let currentRequestApiKey: string | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Props available per request, injected via ctx.props in outer Worker
type RequestProps = { apiKey?: string }

export class MyMCPv2 extends McpAgent<Env, {}, RequestProps> {
  server = new McpServer({ name: "Todo Server", version: "2.0.0" })

  /** resolve key: param → injected header → global variable → none */
  private key(provided?: string): string | null {
    // 1) explicit param
    if (provided) return provided

    // 2) per-request props injected via ctx.props
    const fromProps = (this as any).props?.apiKey as string | undefined
    if (fromProps) return fromProps

    // 3) (fallback) global variable – only works when same isolate (dev)
    if (currentRequestApiKey) return currentRequestApiKey

    return null
  }

  async init() {
    // diagnose
    this.server.tool(
      "diagnose_api_key",
      "Show if an API‑Key is present in this request.",
      {},
      async () => {
        const apiKey = this.key()
        
        return {
          content: [
            {
              type: "text",
              text: apiKey 
                ? `✅ API‑Key: ${apiKey.slice(0, 8)}… (from injected header)` 
                : `❌ No API‑Key found. CurrentRequestApiKey: ${currentRequestApiKey}`,
            },
          ],
        }
      }
    )

    // add todo
    this.server.tool(
      "add_todo",
      "Create a todo item (title + optional note).",
      {
        title: z.string(),
        note: z.string().optional(),
        apiKey: z.string().optional(),
      },
      async ({ title, note, apiKey }) => {
        const key = this.key(apiKey)
        
        if (!key)
          return {
            content: [{ 
              type: "text", 
              text: `❌ No API key available. Please provide apiKey parameter or ensure your MCP client sends x-api-key header.` 
            }],
          }

        const payload = { title, note: note ?? "", date: new Date().toISOString() }
        const res = await fetch(
          "https://xbc070isy8.execute-api.us-west-2.amazonaws.com/tasks",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": key,
            },
            body: JSON.stringify(payload),
          }
        )

        if (!res.ok)
          return {
            content: [
              { type: "text", text: `❌ ${res.status}: ${await res.text()}` },
            ],
          }

        return { content: [{ type: "text", text: `✅ Todo created: "${title}"` }] }
      }
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker level - extract and store API keys globally, mount MCP at /sse
// ─────────────────────────────────────────────────────────────────────────────
class ApiKeyWorker {
  private extract(req: Request): string | null {
    const h = req.headers
    const auth = h.get("authorization")
    if (auth?.startsWith("Bearer ")) return auth.slice(7)
    const x = h.get("x-api-key") ?? h.get("X-API-KEY")
    if (x) return x
    const url = new URL(req.url)
    return url.searchParams.get("API_KEY") ?? url.searchParams.get("api_key")
  }

  private getConnectionFingerprint(req: Request): string {
    const userAgent = req.headers.get('user-agent') || 'unknown'
    const forwarded = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown'
    const fingerprint = btoa(`${userAgent}-${forwarded}`).slice(0, 16)
    return fingerprint
  }

  private cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, X-API-KEY, Content-Type",
    "Access-Control-Max-Age": "86400",
  }

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log(`Request: ${req.method} ${req.url}`)
    
    // CORS preflight
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: this.cors })

    const url = new URL(req.url)
    const pathname = url.pathname

    // root → /sse convenience redirect
    if (pathname === "/") return Response.redirect("/sse", 302)

    // Extract API key and create connection fingerprint
    const apiKey = this.extract(req)
    const fingerprint = this.getConnectionFingerprint(req)

    console.log(`Fingerprint: ${fingerprint}, HasApiKey: ${!!apiKey}, Path: ${pathname}`)

    // Store API key for this connection when we first see it
    if (apiKey) {
      console.log(`Storing API key for connection ${fingerprint}: ${apiKey.slice(0, 8)}...`)
      connectionApiKeys.set(fingerprint, { apiKey, lastUsed: Date.now() })
      
      // Clean up old connections periodically (keep last 500, remove older than 1 hour)
      if (connectionApiKeys.size > 500) {
        const cutoff = Date.now() - 60 * 60 * 1000 // 1 hour ago
        for (const [key, value] of connectionApiKeys.entries()) {
          if (value.lastUsed < cutoff) {
            connectionApiKeys.delete(key)
          }
        }
      }
    }

    // Get stored API key for this connection
    const storedConnection = connectionApiKeys.get(fingerprint)
    const effectiveApiKey = apiKey || storedConnection?.apiKey || null

    console.log(`EffectiveApiKey: ${effectiveApiKey ? effectiveApiKey.slice(0, 8) + '...' : 'none'}, ConnectionKeys: ${connectionApiKeys.size}`)

    // Set global variable for tool access
    currentRequestApiKey = effectiveApiKey

    try {
      const handler = MyMCPv2.serveSSE("/sse")
      if (effectiveApiKey) (ctx as any).props = { apiKey: effectiveApiKey };
      const res = await handler.fetch(req, env, ctx)

      const hdr = new Headers(res.headers)
      for (const [k, v] of Object.entries(this.cors)) hdr.set(k, v)
      return new Response(res.body, { status: res.status, headers: hdr })
    } finally {
      // Clean up global variable after request
      currentRequestApiKey = null
    }
  }
}

export default new ApiKeyWorker()

// Alias old class name so existing Durable Object instances can continue until migration
export { MyMCPv2 as MyMCP };
