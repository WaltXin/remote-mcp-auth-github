import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { fetchCognitoAuthToken, getCognitoAuthorizeUrl, parseJWT, Props } from "./utils";
import { env } from "cloudflare:workers";
import { clientIdAlreadyApproved, parseRedirectApproval, renderApprovalDialog } from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (await clientIdAlreadyApproved(c.req.raw, oauthReqInfo.clientId, env.COOKIE_ENCRYPTION_KEY)) {
    return redirectToCognito(c.req.raw, oauthReqInfo);
  }

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    server: {
      name: "Cloudflare Cognito MCP Server",
      logo: "https://d0.awsstatic.com/logos/powered-by-aws.png",
      description: "This is a demo MCP Remote Server using AWS Cognito for authentication.",
    },
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  const { state, headers } = await parseRedirectApproval(c.req.raw, env.COOKIE_ENCRYPTION_KEY);
  if (!state.oauthReqInfo) {
    return c.text("Invalid request", 400);
  }

  return redirectToCognito(c.req.raw, state.oauthReqInfo, headers);
});

async function redirectToCognito(request: Request, oauthReqInfo: AuthRequest, headers: Record<string, string> = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      location: getCognitoAuthorizeUrl({
        cognito_domain: env.COGNITO_DOMAIN,
        client_id: env.COGNITO_CLIENT_ID,
        redirect_uri: new URL("/callback", request.url).href,
        state: btoa(JSON.stringify(oauthReqInfo)),
      }),
    },
  });
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from Cognito after user authentication.
 * It exchanges the temporary code for tokens, then extracts user info from ID token.
 */
app.get("/callback", async (c) => {
  const oauthReqInfo = JSON.parse(atob(c.req.query("state") as string)) as AuthRequest;
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid state", 400);
  }

  // Exchange the code for tokens from Cognito
  const [tokens, errResponse] = await fetchCognitoAuthToken({
    cognito_domain: c.env.COGNITO_DOMAIN,
    client_id: c.env.COGNITO_CLIENT_ID,
    client_secret: c.env.COGNITO_CLIENT_SECRET,
    code: c.req.query("code"),
    redirect_uri: new URL("/callback", c.req.url).href,
  });
  if (errResponse) return errResponse;

  // Parse the ID token to get user info
  const idTokenPayload = parseJWT(tokens.id_token);
  const { sub, email, given_name, family_name } = idTokenPayload;

  // Return back to the MCP client a new token
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: sub,
    metadata: {
      label: given_name && family_name ? `${given_name} ${family_name}` : email,
    },
    scope: oauthReqInfo.scope,
    props: {
      sub,
      login: email,
      name: given_name && family_name ? `${given_name} ${family_name}` : email,
      email,
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
    } as Props,
  });

  return Response.redirect(redirectTo);
});

/**
 * Client Registration Endpoint
 */
app.post("/register", async (c) => {
  try {
    const clientInfo = await c.req.json();
    
    const clientId = `mcp-client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const clientSecret = crypto.randomUUID();
    
    const response = {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      ...clientInfo
    };
    
    return c.json(response);
  } catch (error) {
    console.error("Client registration error:", error);
    return c.json({ error: "invalid_client_metadata" }, 400);
  }
});

export { app as CognitoHandler };
