import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { fetchCognitoAuthToken, getCognitoAuthorizeUrl, parseJWT, Props, refreshCognitoTokens, isTokenNearExpiry, updatePropsWithTokens } from "./utils";
import { env } from "cloudflare:workers";
import { clientIdAlreadyApproved, parseRedirectApproval, renderApprovalDialog } from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

/**
 * Token refresh middleware - automatically refreshes tokens if they're about to expire
 */
async function refreshTokenIfNeeded(
  currentProps: Props,
  env: { COGNITO_DOMAIN: string; COGNITO_CLIENT_ID: string; COGNITO_CLIENT_SECRET: string }
): Promise<Props> {
  // Check if token needs refresh (within 5 minutes of expiry)
  if (!isTokenNearExpiry(currentProps.tokenIssuedAt)) {
    return currentProps; // No refresh needed
  }

  console.log(`Token for user ${currentProps.sub} is near expiry, attempting refresh...`);

  // Attempt to refresh tokens
  const [newTokens, errResponse] = await refreshCognitoTokens({
    cognito_domain: env.COGNITO_DOMAIN,
    client_id: env.COGNITO_CLIENT_ID,
    client_secret: env.COGNITO_CLIENT_SECRET,
    refresh_token: currentProps.refreshToken,
  });

  if (errResponse) {
    console.error(`Failed to refresh tokens for user ${currentProps.sub}:`, errResponse.status);
    return currentProps; // Return current props if refresh fails
  }

  // Update props with new tokens
  const updatedProps = updatePropsWithTokens(currentProps, newTokens);
  console.log(`Successfully refreshed tokens for user ${currentProps.sub}`);
  
  return updatedProps;
}

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

  // Calculate token expiration times
  const now = Math.floor(Date.now() / 1000);
  const tokenExpiresAt = now + (60 * 60); // 60 minutes from now (1 hour)

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
      refreshToken: tokens.refresh_token,
      tokenIssuedAt: now,
      tokenExpiresAt: tokenExpiresAt,
    } as Props,
  });

  return Response.redirect(redirectTo);
});

/**
 * Token Refresh Endpoint
 * 
 * This endpoint allows explicit token refresh using a refresh token.
 * It's designed to be called by MCP clients when they detect token expiry.
 */
app.post("/refresh", async (c) => {
  try {
    const { refresh_token, user_id } = await c.req.json();
    
    if (!refresh_token) {
      return c.json({ error: "refresh_token is required" }, 400);
    }

    // Attempt to refresh tokens
    const [newTokens, errResponse] = await refreshCognitoTokens({
      cognito_domain: c.env.COGNITO_DOMAIN,
      client_id: c.env.COGNITO_CLIENT_ID,
      client_secret: c.env.COGNITO_CLIENT_SECRET,
      refresh_token,
    });

    if (errResponse) {
      console.error("Token refresh failed:", errResponse.status);
      return c.json({ error: "token_refresh_failed" }, 400);
    }

    // Parse the new ID token to get updated user info
    const idTokenPayload = parseJWT(newTokens.id_token);
    const { sub, email, given_name, family_name } = idTokenPayload;
    const now = Math.floor(Date.now() / 1000);

    // Return the refreshed tokens and user info
    const refreshedProps = {
      sub,
      login: email,
      name: given_name && family_name ? `${given_name} ${family_name}` : email,
      email,
      accessToken: newTokens.access_token,
      idToken: newTokens.id_token,
      refreshToken: newTokens.refresh_token || refresh_token, // Use new refresh token or keep the old one
      tokenIssuedAt: now,
      tokenExpiresAt: now + (60 * 60), // 60 minutes from now
    };

    return c.json({
      success: true,
      tokens: refreshedProps
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    return c.json({ error: "invalid_request" }, 400);
  }
});

/**
 * Token Validation and Auto-Refresh Endpoint
 * 
 * This endpoint checks if the current token is valid and automatically refreshes it if needed.
 * MCP clients can call this periodically to ensure they always have valid tokens.
 */
app.post("/validate-token", async (c) => {
  try {
    const { props } = await c.req.json();
    
    if (!props || !props.refreshToken || !props.tokenIssuedAt) {
      return c.json({ 
        error: "invalid_request",
        message: "Missing required token properties"
      }, 400);
    }

    // Check if token needs refresh and refresh it if necessary
    const updatedProps = await refreshTokenIfNeeded(props, {
      COGNITO_DOMAIN: c.env.COGNITO_DOMAIN,
      COGNITO_CLIENT_ID: c.env.COGNITO_CLIENT_ID,
      COGNITO_CLIENT_SECRET: c.env.COGNITO_CLIENT_SECRET,
    });

    // Check if tokens were actually refreshed
    const wasRefreshed = updatedProps.tokenIssuedAt !== props.tokenIssuedAt;

    return c.json({
      success: true,
      refreshed: wasRefreshed,
      tokens: updatedProps,
      message: wasRefreshed ? "Tokens were refreshed successfully" : "Tokens are still valid"
    });
  } catch (error) {
    console.error("Token validation error:", error);
    return c.json({ 
      error: "validation_failed",
      message: "Failed to validate or refresh tokens"
    }, 500);
  }
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
