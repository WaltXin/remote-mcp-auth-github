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
