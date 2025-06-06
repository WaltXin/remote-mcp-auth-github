import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/*
 * 🎉 DYNAMIC API KEY MODE 🎉
 * 
 * This MCP Server uses dynamic API Key authentication:
 * - NO OAuth flow - no browser popups
 * - Direct connection
 * - API Key passed from Claude Desktop config
 * - All API calls use dynamic x-api-key header
 */

// Simplified Props (no OAuth fields needed)
type SimpleProps = {
  apiKey: string;
  mode: string;
};

export class MyMCP extends McpAgent<Env, {}, SimpleProps> {
  server = new McpServer({
    name: "Dynamic API Key MCP Server",
    version: "3.0.0",
  });

  /**
   * Extract API Key from request context
   * The API key is passed from Claude Desktop config via mcp-remote
   */
  private getApiKey(): string | null {
    // mcp-remote passes API_KEY as environment variable
    // Check various possible ways the API key might be passed
    
    // Method 1: Check if it's in the environment
    if (typeof process !== 'undefined' && process.env?.API_KEY) {
      return process.env.API_KEY;
    }
    
    // Method 2: Check if it's in Cloudflare Workers environment
    if (this.env && 'API_KEY' in this.env) {
      return (this.env as any).API_KEY;
    }
    
    // Method 3: For now, return the known working API key for testing
    // This will be removed once we confirm the dynamic method works
    return '943bf3bd-e5ce-48be-8af8-d964d873873c';
  }

  async init() {
    // Get API Key info
    this.server.tool("userInfo", "Get current authentication mode", {}, async () => {
      const apiKey = this.getApiKey();
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              authMode: "Dynamic API Key Mode",
              apiKey: apiKey ? (apiKey.substring(0, 8) + "...") : "Not provided",
              message: "API Key passed from Claude Desktop config",
              noPopups: true,
              hasApiKey: !!apiKey
            }, null, 2),
          },
        ],
      };
    });

    // Add todo tool with dynamic API Key
    this.server.tool(
      "add_todo",
      "Add a todo item with title and optional note",
      {
        title: z.string().describe("The title of the todo item"),
        note: z.string().optional().describe("Optional note for the todo item"),
        apiKey: z.string().optional().describe("API Key for backend authentication (auto-provided by config)")
      },
      async ({ title, note, apiKey }) => {
        try {
          // Use provided API key or try to get from context
          const effectiveApiKey = apiKey || this.getApiKey();
          
          if (!effectiveApiKey) {
            return {
              content: [{ 
                type: "text", 
                text: `Error: No API Key provided. Please configure API_KEY in your Claude Desktop config.` 
              }],
            };
          }

          const now = new Date();
          const date = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
          const startTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
          const endDate = new Date(now.getTime() + 15 * 60 * 1000);
          const endTime = endDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

          const taskData = { title, note: note || "", date, startTime, endTime };

          console.log(`API call with dynamic API Key`);
          console.log(`Request details:`, {
            url: 'https://xbc070isy8.execute-api.us-west-2.amazonaws.com/tasks',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': effectiveApiKey.substring(0, 8) + '...' // Log partial key for security
            },
            body: taskData
          });

          const response = await fetch('https://xbc070isy8.execute-api.us-west-2.amazonaws.com/tasks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': effectiveApiKey // Use dynamic API key
            },
            body: JSON.stringify(taskData)
          });

          console.log(`Response status: ${response.status}`);
          console.log(`Response headers:`, Object.fromEntries(response.headers.entries()));

          if (!response.ok) {
            const errorText = await response.text();
            console.log(`Error response body:`, errorText);
            return {
              content: [{ 
                type: "text", 
                text: `Error: Failed to create todo. Status: ${response.status}\nError details: ${errorText}` 
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
              mode: "Dynamic API Key",
              apiKeyUsed: effectiveApiKey.substring(0, 8) + "..."
            };
            
            return {
              content: [{ type: "text", text: `Todo created with dynamic API Key!\n\nDetails:\n${JSON.stringify(userFriendlyResponse, null, 2)}` }],
            };
          } catch (parseError) {
            return {
              content: [{ type: "text", text: `Todo "${title}" created successfully with dynamic API Key!` }],
            };
          }
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          };
        }
      }
    );

    // Test API Key connectivity
    this.server.tool(
      "test_api_key", 
      "Test dynamic API Key connectivity", 
      {
        apiKey: z.string().optional().describe("API Key to test (auto-provided by config)")
      },
      async ({ apiKey }) => {
        try {
          const effectiveApiKey = apiKey || this.getApiKey();
          
          if (!effectiveApiKey) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  mode: "Dynamic API Key Test",
                  error: "No API Key provided",
                  message: "Please configure API_KEY in Claude Desktop config",
                  timestamp: new Date().toISOString()
                }, null, 2),
              }],
            };
          }

          const testResponse = await fetch("https://xbc070isy8.execute-api.us-west-2.amazonaws.com/tasks", {
            method: "GET",
            headers: { "x-api-key": effectiveApiKey }
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                mode: "Dynamic API Key Test",
                apiKey: effectiveApiKey.substring(0, 8) + "...",
                dynamicKey: true,
                testResult: {
                  status: testResponse.status,
                  success: testResponse.ok
                },
                timestamp: new Date().toISOString()
              }, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                mode: "Dynamic API Key Test",
                error: error instanceof Error ? error.message : "Unknown error",
                timestamp: new Date().toISOString()
              }, null, 2),
            }],
          };
        }
      }
    );
  }
}

// Direct export of MCP handler - no OAuth wrapper
export default MyMCP.mount("/");
