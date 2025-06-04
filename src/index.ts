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
            endTime,
            userId: this.props.sub
          };

          // Call the external API
          const response = await fetch("https://2s627cz5fiowa22mehsoxahboq0pibpv.lambda-url.us-west-2.on.aws/tasks", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
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
          return {
            content: [
              {
                type: "text",
                text: `Todo created successfully! Response: ${result}`,
              },
            ],
          };
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
