import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/*
 * 🧪 PURE API KEY MODE 🧪
 * 
 * This MCP Server uses API Key authentication only:
 * - NO OAuth flow - no browser popups
 * - Direct connection
 * - All API calls use x-api-key header
 * - Fixed API Key: 943bf3bd-e5ce-48be-8af8-d964d873873c
 */

// Simplified Props (no OAuth fields needed)
type SimpleProps = {
  apiKey: string;
  mode: string;
};

// 固定的API Key用于测试
const FIXED_API_KEY = '943bf3bd-e5ce-48be-8af8-d964d873873c';

export class MyMCP extends McpAgent<Env, {}, SimpleProps> {
  server = new McpServer({
    name: "Simple MCP Server - API Key Only",
    version: "2.0.0",
  });

  async init() {
    // Get API Key info
    this.server.tool("userInfo", "Get current authentication mode", {}, async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              authMode: "Pure API Key Mode",
              apiKey: FIXED_API_KEY.substring(0, 8) + "...",
              message: "No OAuth required - direct API Key authentication",
              noPopups: true
            }, null, 2),
          },
        ],
      };
    });

    // Add todo tool with API Key
    this.server.tool(
      "add_todo",
      "Add a todo item with title and optional note",
      {
        title: z.string().describe("The title of the todo item"),
        note: z.string().optional().describe("Optional note for the todo item"),
      },
      async ({ title, note }) => {
        try {
          const now = new Date();
          const date = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
          const startTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
          const endDate = new Date(now.getTime() + 15 * 60 * 1000);
          const endTime = endDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

          const taskData = { title, note: note || "", date, startTime, endTime };

          console.log(`Direct API call with API Key - no OAuth needed`);
          console.log(`Request details:`, {
            url: 'https://xbc070isy8.execute-api.us-west-2.amazonaws.com/tasks',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': '943bf3bd-e5ce-48be-8af8-d964d873873c'
            },
            body: taskData
          });

          const response = await fetch('https://xbc070isy8.execute-api.us-west-2.amazonaws.com/tasks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': '943bf3bd-e5ce-48be-8af8-d964d873873c' // UUID 格式，小写
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
              mode: "Pure API Key - No OAuth",
              originalRequest: taskData
            };
            
            return {
              content: [{ type: "text", text: `Todo created with pure API Key!\n\nDetails:\n${JSON.stringify(userFriendlyResponse, null, 2)}` }],
            };
          } catch (parseError) {
            return {
              content: [{ type: "text", text: `Todo "${title}" created successfully with API Key (no OAuth)!` }],
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
    this.server.tool("test_api_key", "Test API Key without OAuth", {}, async () => {
      try {
        const testResponse = await fetch("https://xbc070isy8.execute-api.us-west-2.amazonaws.com/tasks", {
          method: "GET",
          headers: { "x-api-key": FIXED_API_KEY }
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              mode: "Pure API Key Test",
              apiKey: FIXED_API_KEY.substring(0, 8) + "...",
              noOAuth: true,
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
              mode: "Pure API Key Test",
              error: error instanceof Error ? error.message : "Unknown error",
              timestamp: new Date().toISOString()
            }, null, 2),
          }],
        };
      }
    });
  }
}

// Direct export of MCP handler - no OAuth wrapper
export default MyMCP.mount("/");
