import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CognitoHandler } from "./github-handler";
import { refreshCognitoTokens, isTokenNearExpiry, updatePropsWithTokens } from "./utils";

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
type Props = {
  sub: string;
  login: string;
  name: string;
  email: string;
  accessToken: string;
  idToken: string;
  refreshToken: string;
  tokenExpiresAt: number; // Unix timestamp when access token expires
  tokenIssuedAt: number;  // Unix timestamp when tokens were issued/refreshed
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

  /**
   * Check if token needs refresh and refresh it if necessary
   * This ensures we always have valid tokens before making API calls
   */
  private async ensureValidTokens(): Promise<void> {
    // Check if token needs refresh (within 5 minutes of expiry)
    if (!isTokenNearExpiry(this.props.tokenIssuedAt)) {
      return; // No refresh needed
    }

    console.log(`Token for user ${this.props.sub} is near expiry, attempting refresh...`);

    try {
      // Attempt to refresh tokens
      const [newTokens, errResponse] = await refreshCognitoTokens({
        cognito_domain: this.env.COGNITO_DOMAIN,
        client_id: this.env.COGNITO_CLIENT_ID,
        client_secret: this.env.COGNITO_CLIENT_SECRET,
        refresh_token: this.props.refreshToken,
      });

      if (errResponse) {
        console.error(`Failed to refresh tokens for user ${this.props.sub}:`, errResponse.status);
        return; // Keep using current props if refresh fails
      }

      // Update props with new tokens
      const updatedProps = updatePropsWithTokens(this.props, newTokens);
      
      // Update the current props in memory
      Object.assign(this.props, updatedProps);
      
      console.log(`Successfully refreshed tokens for user ${this.props.sub}`);
    } catch (error) {
      console.error(`Error during token refresh for user ${this.props.sub}:`, error);
    }
  }

  async init() {
    // Get user info from Cognito authentication
    this.server.tool("userInfo", "Get user info from Cognito authentication", {}, async () => {
      // 🔄 Ensure we have valid tokens
      await this.ensureValidTokens();
      
      const now = Math.floor(Date.now() / 1000);
      const tokenAge = now - this.props.tokenIssuedAt;
      const tokenExpiresIn = this.props.tokenExpiresAt - now;
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              // User information
              sub: this.props.sub,
              login: this.props.login,
              name: this.props.name,
              email: this.props.email,
              // Token status information
              tokenStatus: {
                issuedAt: new Date(this.props.tokenIssuedAt * 1000).toISOString(),
                expiresAt: new Date(this.props.tokenExpiresAt * 1000).toISOString(),
                ageInSeconds: tokenAge,
                expiresInSeconds: tokenExpiresIn,
                isNearExpiry: tokenExpiresIn <= 300 // 5 minutes
              }
            }, null, 2),
          },
        ],
      };
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
          // 🔄 Ensure we have valid tokens before making API call
          await this.ensureValidTokens();

          // Generate current date and time
          const now = new Date();
          
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

          console.log(`Making API call with token issued at: ${this.props.tokenIssuedAt}, current time: ${Math.floor(Date.now() / 1000)}`);

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
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Failed to create todo. Status: ${response.status}`,
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
          // 🔄 Ensure we have valid tokens before making API call
          await this.ensureValidTokens();
          
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

    // Add a diagnostic tool to check token status
    this.server.tool(
      "diagnose_tokens", 
      "Diagnose current token status and force refresh if needed",
      {
        forceRefresh: z.boolean().optional().describe("Force token refresh even if not expired")
      },
      async ({ forceRefresh = false }) => {
        const now = Math.floor(Date.now() / 1000);
        const tokenAge = now - this.props.tokenIssuedAt;
        const tokenExpiresIn = this.props.tokenExpiresAt - now;
        const needsRefresh = isTokenNearExpiry(this.props.tokenIssuedAt);
        
        const beforeRefresh = {
          tokenIssuedAt: this.props.tokenIssuedAt,
          tokenExpiresAt: this.props.tokenExpiresAt,
          tokenAge,
          tokenExpiresIn,
          needsRefresh,
          currentTime: now
        };

        if (forceRefresh || needsRefresh) {
          console.log(`Forcing token refresh for user ${this.props.sub}`);
          await this.ensureValidTokens();
        }

        const afterNow = Math.floor(Date.now() / 1000);
        const afterRefresh = {
          tokenIssuedAt: this.props.tokenIssuedAt,
          tokenExpiresAt: this.props.tokenExpiresAt,
          tokenAge: afterNow - this.props.tokenIssuedAt,
          tokenExpiresIn: this.props.tokenExpiresAt - afterNow,
          wasRefreshed: this.props.tokenIssuedAt !== beforeRefresh.tokenIssuedAt
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                beforeRefresh,
                afterRefresh,
                refreshTrigger: forceRefresh ? "forced" : (needsRefresh ? "automatic" : "none")
              }, null, 2),
            },
          ],
        };
      }
    );
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
