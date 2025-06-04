import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CognitoHandler } from "./github-handler";

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
type Props = {
  sub: string;
  login: string;
  name: string;
  email: string;
  accessToken: string;
  idToken: string;
};

const ALLOWED_USERNAMES = new Set<string>([
  // Add user subs or emails of users who should have access to the image generation tool
  // For example: 'user-sub-id', 'user@example.com'
]);

export class MyMCP extends McpAgent<Env, {}, Props> {
  server = new McpServer({
    name: "Cognito OAuth Proxy Demo",
    version: "1.0.0",
  });

  async init() {
    // Hello, world!
    this.server.tool("add", "Add two numbers the way only MCP can", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }));

    // Get user info from Cognito authentication
    this.server.tool("userInfo", "Get user info from Cognito authentication", {}, async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              sub: this.props.sub,
              login: this.props.login,
              name: this.props.name,
              email: this.props.email,
            }, null, 2),
          },
        ],
      };
    });

    // Debug tool to inspect ID token claims and verify configuration
    this.server.tool("debugAuth", "Debug authentication configuration and token details", {}, async () => {
      try {
        // 1. Verify we're using ID Token (not Access Token)
        const tokenType = this.props.idToken ? "ID Token" : "NO ID TOKEN";
        const hasAccessToken = this.props.accessToken ? "Yes" : "No";
        
        // 2. Check Authorization Header format
        const authHeader = `Bearer ${this.props.idToken}`;
        const headerFormat = authHeader.startsWith("Bearer ") ? "✅ Correct" : "❌ Incorrect";
        
        // 3. Parse ID Token to check audience and other claims
        if (!this.props.idToken) {
          return {
            content: [{ type: "text", text: "❌ No ID Token available!" }],
          };
        }
        
        const tokenParts = this.props.idToken.split('.');
        if (tokenParts.length !== 3) {
          return {
            content: [{ type: "text", text: "❌ Invalid JWT format" }],
          };
        }
        
        const header = JSON.parse(atob(tokenParts[0]));
        const payload = JSON.parse(atob(tokenParts[1]));
        
        // Check critical claims
        const audience = payload.aud || "NOT_SET";
        const issuer = payload.iss || "NOT_SET";
        const expiry = payload.exp ? new Date(payload.exp * 1000).toISOString() : "NOT_SET";
        const isExpired = payload.exp ? Date.now() > (payload.exp * 1000) : "UNKNOWN";
        const clientId = payload.client_id || "NOT_SET";
        
        const debugInfo = `🔍 AUTHENTICATION DEBUG REPORT
        
📋 1. TOKEN TYPE VERIFICATION:
   Using ID Token: ${tokenType}
   Has Access Token: ${hasAccessToken}
   Token Length: ${this.props.idToken.length}

🔑 2. AUTHORIZATION HEADER FORMAT:
   Header: Authorization: ${authHeader.substring(0, 50)}...
   Format Check: ${headerFormat}
   
🎯 3. TOKEN CLAIMS ANALYSIS:
   Audience (aud): ${audience}
   Client ID: ${clientId}
   Issuer (iss): ${issuer}
   Expires: ${expiry}
   Is Expired: ${isExpired}
   Subject (sub): ${payload.sub || "NOT_SET"}
   Email: ${payload.email || "NOT_SET"}
   
📊 4. TOKEN STRUCTURE:
   Algorithm: ${header.alg || "NOT_SET"}
   Key ID: ${header.kid || "NOT_SET"}
   Type: ${header.typ || "NOT_SET"}
   
⚠️  POTENTIAL ISSUES TO CHECK:
   - Ensure audience (${audience}) matches your API Gateway Client ID
   - Verify issuer (${issuer}) matches your Cognito User Pool
   - Check if token is expired: ${isExpired}
   
🔧 BACKEND CHECKLIST:
   - Add identitySource: ["$request.header.Authorization"] to your authorizer
   - Verify userPoolClients includes the client with ID: ${audience}`;

        return {
          content: [
            {
              type: "text", 
              text: debugInfo,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Error analyzing authentication: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    });

    // Debug tool to inspect ID token claims
    this.server.tool("debugToken", "Debug ID token claims (for troubleshooting)", {}, async () => {
      try {
        // Parse the ID token to see its contents
        const tokenParts = this.props.idToken.split('.');
        if (tokenParts.length !== 3) {
          return {
            content: [{ type: "text", text: "Invalid JWT format" }],
          };
        }
        
        const header = JSON.parse(atob(tokenParts[0]));
        const payload = JSON.parse(atob(tokenParts[1]));
        
        return {
          content: [
            {
              type: "text", 
              text: `ID Token Debug Info:\n\nHeader:\n${JSON.stringify(header, null, 2)}\n\nPayload:\n${JSON.stringify(payload, null, 2)}\n\nToken Length: ${this.props.idToken.length}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error parsing token: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    });

    // Add todo tool that calls external API
    this.server.tool(
      "add_todo",
      "Add a todo item with title and optional note",
      {
        title: z.string().describe("The title of the todo item"),
        note: z.string().optional().describe("Optional note for the todo item"),
      },
      async ({ title, note }) => {
        try {
          // Generate current date and time
          const now = new Date();
          
          // Debug: Token info for troubleshooting
          const tokenPreview = this.props.idToken 
            ? `${this.props.idToken.substring(0, 20)}...${this.props.idToken.substring(this.props.idToken.length - 20)}`
            : 'NO_TOKEN';
          const tokenLength = this.props.idToken?.length || 0;
          
          // Format date as YYYY/MM/DD
          const date = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
          
          // Format start time as HH:MM AM/PM
          const startTime = now.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          });
          
          // Calculate end time (start time + 15 minutes)
          const endDate = new Date(now.getTime() + 15 * 60 * 1000);
          const endTime = endDate.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          });

          // Prepare request body
          const requestBody = {
            title,
            note: note || "",
            date,
            startTime,
            endTime
          };

          // Call the external API
          const response = await fetch("https://xbc070isy8.execute-api.us-west-2.amazonaws.com/tasks", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${this.props.idToken}`
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            // Try to get more error details from the response
            let errorDetails = '';
            try {
              errorDetails = await response.text();
            } catch (e) {
              // Could not read error response body
            }
            
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Failed to create todo. Status: ${response.status}${errorDetails ? `\nDetails: ${errorDetails}` : ''}\n\nDebug Info:\nToken Preview: ${tokenPreview}\nToken Length: ${tokenLength}\nToken Type: ${this.props.idToken?.startsWith('ey') ? 'JWT' : 'Unknown'}`,
                },
              ],
            };
          }

          const result = await response.text();
          
          // Parse the response and filter out sensitive information
          try {
            const parsedResult = JSON.parse(result);
            // Create a filtered response without sensitive fields
            const userFriendlyResponse = {
              title: parsedResult.title || title,
              note: parsedResult.note || note || "",
              date: parsedResult.date || date,
              startTime: parsedResult.startTime || startTime,
              endTime: parsedResult.endTime || endTime,
              status: "created"
            };
            
            return {
              content: [
                {
                  type: "text",
                  text: `Todo created successfully!\n\nDetails:\n${JSON.stringify(userFriendlyResponse, null, 2)}`,
                },
              ],
            };
          } catch (parseError) {
            // If JSON parsing fails, return a simple success message
            return {
              content: [
                {
                  type: "text",
                  text: `Todo "${title}" created successfully!`,
                },
              ],
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Failed to create todo - ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            ],
          };
        }
      }
    );

    // Dynamically add tools based on the user's sub or email
    if (ALLOWED_USERNAMES.has(this.props.sub) || ALLOWED_USERNAMES.has(this.props.email)) {
      this.server.tool(
        "generateImage",
        "Generate an image using the `flux-1-schnell` model. Works best with 8 steps.",
        {
          prompt: z.string().describe("A text description of the image you want to generate."),
          steps: z
            .number()
            .min(4)
            .max(8)
            .default(4)
            .describe(
              "The number of diffusion steps; higher values can improve quality but take longer. Must be between 4 and 8, inclusive.",
            ),
        },
        async ({ prompt, steps }) => {
          const response = await this.env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
            prompt,
            steps,
          });

          return {
            content: [{ type: "image", data: response.image!, mimeType: "image/jpeg" }],
          };
        },
      );
    }
  }
}

export default new OAuthProvider({
  apiRoute: "/sse",
  apiHandler: MyMCP.mount("/sse") as any,
  defaultHandler: CognitoHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
