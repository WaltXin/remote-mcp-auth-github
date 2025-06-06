import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/*
 * 🎯 TODO SERVER 🎯
 * 
 * Simple todo management server with API Key authentication:
 * - Direct connection, no OAuth
 * - Create todo items with title and notes
 * - Dynamic API Key from Claude Desktop config
 */

// Simplified Props (no OAuth fields needed)
type SimpleProps = {
  apiKey: string;
  mode: string;
};

export class MyMCP extends McpAgent<Env, {}, SimpleProps> {
  server = new McpServer({
    name: "Todo Server",
    version: "1.0.0",
  });

  /**
   * Get user-specific API Key from multiple sources
   * Priority: tool parameter > KV storage > environment
   */
  private async getUserApiKey(userId: string, providedApiKey?: string): Promise<string | null> {
    // Priority 1: API Key provided in tool call
    if (providedApiKey) {
      console.log('✅ Using API Key from tool parameter');
      return providedApiKey;
    }
    
    // Priority 2: Check user's stored API Key in KV
    try {
      if (this.env?.OAUTH_KV) {
        const storedData = await this.env.OAUTH_KV.get(`user_api_key:${userId}`);
        if (storedData) {
          try {
            // Try to parse as JSON (new format)
            const apiKeyData = JSON.parse(storedData);
            if (apiKeyData.apiKey) {
              // Check if not expired
              if (apiKeyData.expiresAt && Date.now() < apiKeyData.expiresAt) {
                console.log('✅ Using stored API Key for user:', userId);
                return apiKeyData.apiKey;
              } else {
                console.log('⚠️ Stored API Key expired for user:', userId);
                return null;
              }
            }
          } catch (parseError) {
            // Handle legacy format (just the API key string)
            console.log('✅ Using legacy format API Key for user:', userId);
            return storedData;
          }
        }
      }
    } catch (error) {
      console.log('Error reading user API Key from KV:', error);
    }
    
    // Priority 3: Check environment (set by Worker)
    if (this.env && 'API_KEY' in this.env) {
      console.log('✅ Using environment API Key');
      return (this.env as any).API_KEY;
    }
    
    console.log('❌ No API Key found for user:', userId);
    return null;
  }

  /**
   * Generate a simple user ID 
   * For simplicity, use a default user ID since we can't access request in MCP tools
   */
  private getUserId(): string {
    // For multi-user support, in production this should be from user authentication
    // For now, use a default user ID - each Claude Desktop instance is one user
    return 'claude_desktop_user';
  }

  async init() {
    // Add API Key management tool
    this.server.tool(
      "set_api_key",
      "Set your personal API Key for long-term use (stored for 10 years)",
      {
        apiKey: z.string().describe("Your personal API Key for backend authentication")
      },
      async ({ apiKey }) => {
        try {
          const userId = this.getUserId();
          
          // Store user's API Key in KV storage for 10 years (3650 days)
          if (this.env?.OAUTH_KV) {
            const tenYearsInSeconds = 3650 * 24 * 60 * 60; // 10 years = 315,360,000 seconds
            const expiryTimestamp = Date.now() + (tenYearsInSeconds * 1000);
            
            // Store API Key with expiration metadata
            const apiKeyData = {
              apiKey: apiKey,
              createdAt: Date.now(),
              expiresAt: expiryTimestamp
            };
            
            await this.env.OAUTH_KV.put(`user_api_key:${userId}`, JSON.stringify(apiKeyData), {
              expirationTtl: tenYearsInSeconds
            });
            
            const expiryDate = new Date(expiryTimestamp);
            
            return {
              content: [{ 
                type: "text", 
                text: `✅ API Key set successfully for 10 years! 🎉\n\n📅 Your API Key will be stored until: ${expiryDate.toLocaleDateString()}\n🔐 You can now use add_todo without providing apiKey parameter each time.\n🚀 Login once, use for 3650 days!\n\nSession: ${userId}`
              }],
            };
          } else {
            return {
              content: [{ 
                type: "text", 
                text: `❌ Error: Unable to store API Key (KV storage not available)`
              }],
            };
          }
        } catch (error) {
          return {
            content: [{ 
              type: "text", 
              text: `❌ Error setting API Key: ${error instanceof Error ? error.message : 'Unknown error'}`
            }],
          };
        }
      }
    );

    // Add diagnostic tool to understand API Key transmission
    this.server.tool(
      "diagnose_api_key",
      "Diagnose multi-user API Key transmission from Claude Desktop to Cloudflare Workers",
      {},
      async () => {
        const userId = this.getUserId();
        const envApiKey = await this.getUserApiKey(userId);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              diagnosis: "Multi-User API Key Transmission Analysis",
              findings: {
                userId: userId,
                workersEnvKeys: Object.keys(this.env || {}),
                detectedApiKey: envApiKey ? envApiKey.substring(0, 8) + "..." : "None detected",
                hasApiKey: !!envApiKey,
                userSpecificKey: !!envApiKey
              },
              multiUserArchitecture: {
                step1: "Claude Desktop: User configures API_KEY in config",
                step2: "mcp-remote: Accesses user's API_KEY", 
                step3: "HTTP transmission: Various methods supported",
                step4: "ApiKeyWorker: Extracts from headers/URL/params",
                step5: "Environment: Sets user-specific API_KEY",
                step6: "MCP Tools: Use user's API_KEY"
              },
              supportedMethods: [
                "🔑 HTTP Authorization: Bearer YOUR_API_KEY",
                "🔑 HTTP Header: X-API-KEY: YOUR_API_KEY", 
                "🔑 URL Parameter: ?API_KEY=YOUR_API_KEY",
                "🔑 Tool Parameter: apiKey: 'YOUR_API_KEY'",
                "🔑 Stored API Key: Use set_api_key tool first"
              ],
              recommendations: envApiKey ? 
                ["✅ User API Key detected successfully"] : 
                [
                  "❌ No user API Key detected",
                  "🔧 Use: set_api_key tool to store your API Key",
                  "💡 Or: Provide apiKey parameter in each tool call",
                  "📋 Config: https://server.url/?API_KEY=your-key",
                  "🔄 Restart Claude Desktop after config changes"
                ],
              status: envApiKey ? "✅ Ready for multi-user operation" : "❌ Needs user API Key"
            }, null, 2)
          }]
        };
      }
    );

    // Add todo tool with optional API Key parameter for multi-user support
    this.server.tool(
      "add_todo",
      "Add a todo item with title and optional note",
      {
        title: z.string().describe("The title of the todo item"),
        note: z.string().optional().describe("Optional note for the todo item"),
        apiKey: z.string().optional().describe("Your personal API Key (optional if you used set_api_key tool)")
      },
      async ({ title, note, apiKey }) => {
        try {
          const userId = this.getUserId();
          
          // Use provided API key or get from storage/environment
          const effectiveApiKey = await this.getUserApiKey(userId, apiKey);
          
          if (!effectiveApiKey) {
            return {
              content: [{ 
                type: "text", 
                text: `❌ Error: No API Key available.\n\n🔧 Solutions:\n1. Use: set_api_key tool to store your API Key for this session\n2. Or: Provide apiKey parameter: add_todo(title="...", apiKey="your-key")\n3. Or: Configure API_KEY in Claude Desktop config with URL parameter\n\nSession: ${userId}` 
              }],
            };
          }

          const now = new Date();
          const date = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
          const startTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
          const endDate = new Date(now.getTime() + 15 * 60 * 1000);
          const endTime = endDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

          const taskData = { title, note: note || "", date, startTime, endTime };

          const response = await fetch('https://xbc070isy8.execute-api.us-west-2.amazonaws.com/tasks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': effectiveApiKey
            },
            body: JSON.stringify(taskData)
          });

          if (!response.ok) {
            const errorText = await response.text();
            return {
              content: [{ 
                type: "text", 
                text: `❌ Error: Failed to create todo. Status: ${response.status}\nError details: ${errorText}` 
              }],
            };
          }

          const result = await response.text();
          
          try {
            const parsedResult = JSON.parse(result);
            const userFriendlyResponse = {
              title: parsedResult.title || title,
              note: parsedResult.note || note || "",
              date: parsedResult.date || date,
              startTime: parsedResult.startTime || startTime,
              endTime: parsedResult.endTime || endTime,
              status: "created",
              mode: " ",
              apiKeyUsed: effectiveApiKey.substring(0, 8) + "..."
            };
            
            return {
              content: [{ type: "text", text: `Todo created!\n\nDetails:\n${JSON.stringify(userFriendlyResponse, null, 2)}` }],
            };
          } catch (parseError) {
            return {
              content: [{ type: "text", text: `Todo "${title}" created successfully with zimi!` }],
            };
          }
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          };
        }
      }
    );

    // Add API Key status tool
    this.server.tool(
      "check_api_key_status",
      "Check your stored API Key status and expiration time",
      {},
      async () => {
        try {
          const userId = this.getUserId();
          
          if (this.env?.OAUTH_KV) {
            const result = await this.env.OAUTH_KV.get(`user_api_key:${userId}`);
            
            if (result) {
              try {
                const apiKeyData = JSON.parse(result);
                const now = Date.now();
                const remainingMs = Math.max(0, apiKeyData.expiresAt - now);
                const remainingDays = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
                const remainingYears = Math.floor(remainingDays / 365);
                
                const expiryDate = new Date(apiKeyData.expiresAt);
                const createdDate = new Date(apiKeyData.createdAt);
                
                return {
                  content: [{ 
                    type: "text", 
                    text: `✅ API Key Status\n\n🔐 API Key: ${apiKeyData.apiKey.substring(0, 8)}...\n📅 Created: ${createdDate.toLocaleDateString()}\n📅 Expires: ${expiryDate.toLocaleDateString()} ${expiryDate.toLocaleTimeString()}\n⏰ Remaining: ${remainingYears} years, ${remainingDays % 365} days\n📊 Status: ${remainingMs > 0 ? 'Active' : 'Expired'}\n\nSession: ${userId}`
                  }],
                };
              } catch (parseError) {
                // Handle legacy format (just the API key string)
                return {
                  content: [{ 
                    type: "text", 
                    text: `✅ API Key Status\n\n🔐 API Key: ${result.substring(0, 8)}...\n📊 Status: Active (legacy format)\n💡 Re-run set_api_key to update to new format with expiration tracking.\n\nSession: ${userId}`
                  }],
                };
              }
            } else {
              return {
                content: [{ 
                  type: "text", 
                  text: `❌ No API Key found\n\n💡 Use set_api_key tool to store your API Key for 10 years.\n\nSession: ${userId}`
                }],
              };
            }
          } else {
            return {
              content: [{ 
                type: "text", 
                text: `❌ Error: KV storage not available`
              }],
            };
          }
        } catch (error) {
          return {
            content: [{ 
              type: "text", 
              text: `❌ Error checking API Key status: ${error instanceof Error ? error.message : 'Unknown error'}`
            }],
          };
        }
      }
    );
  }
}

// Custom Worker that handles multiple API Key sources for multi-user support
class ApiKeyWorker {
  private mcpHandler: any;
  
  constructor() {
    this.mcpHandler = MyMCP.mount("/");
  }
  
  /**
   * Extract API Key from multiple sources for multi-user support
   */
  private extractApiKey(request: Request): string | null {
    try {
              console.log('🔍 Extracting API Key for multi-user setup...');
      
      // Method 1: HTTP Authorization header
      const authHeader = request.headers.get('authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const apiKey = authHeader.substring(7);
        console.log('🔑 API Key found in Authorization header:', apiKey.substring(0, 8) + '...');
        return apiKey;
      }
      
      // Method 2: X-API-KEY header  
      const apiKeyHeader = request.headers.get('x-api-key') || request.headers.get('X-API-KEY');
      if (apiKeyHeader) {
        console.log('🔑 API Key found in X-API-KEY header:', apiKeyHeader.substring(0, 8) + '...');
        return apiKeyHeader;
      }
      
      // Method 3: URL parameters (fallback)
      const url = new URL(request.url);
      console.log('🔍 Full request URL:', request.url);
      console.log('🔍 URL search params:', Object.fromEntries(url.searchParams.entries()));
      
      const urlApiKey = url.searchParams.get('api_key') || url.searchParams.get('API_KEY');
      if (urlApiKey) {
        console.log('🔑 API Key found in URL parameter:', urlApiKey.substring(0, 8) + '...');
        return urlApiKey;
      }
      
      console.log('⚠️ No API Key found in any source');
      console.log('Available headers:', Object.fromEntries(request.headers.entries()));
      return null;
      
    } catch (error) {
      console.log('❌ Error extracting API Key:', error);
      return null;
    }
  }
  
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Extract API Key from multiple sources
    const apiKey = this.extractApiKey(request);
    
    if (apiKey) {
      // Create enhanced environment with user's API Key
      const envWithApiKey = {
        ...env,
        API_KEY: apiKey
      };
      
      console.log('✅ Forwarding request with user API Key');
      return this.mcpHandler.fetch(request, envWithApiKey, ctx);
    } else {
      console.log('⚠️ Forwarding request without API Key');
      return this.mcpHandler.fetch(request, env, ctx);
    }
  }
}

// Export the custom worker instead of direct MCP mount
export default new ApiKeyWorker();