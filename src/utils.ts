/**
 * Constructs an authorization URL for an upstream service.
 *
 * @param {Object} options
 * @param {string} options.upstream_url - The base URL of the upstream service.
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} [options.state] - The state parameter.
 *
 * @returns {string} The authorization URL.
 */
export function getUpstreamAuthorizeUrl({
  upstream_url,
  client_id,
  scope,
  redirect_uri,
  state,
}: {
  upstream_url: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
  state?: string;
}) {
  const upstream = new URL(upstream_url);
  upstream.searchParams.set("client_id", client_id);
  upstream.searchParams.set("redirect_uri", redirect_uri);
  upstream.searchParams.set("scope", scope);
  if (state) upstream.searchParams.set("state", state);
  upstream.searchParams.set("response_type", "code");
  return upstream.href;
}

/**
 * Fetches an authorization token from an upstream service.
 *
 * @param {Object} options
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.client_secret - The client secret of the application.
 * @param {string} options.code - The authorization code.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} options.upstream_url - The token endpoint URL of the upstream service.
 *
 * @returns {Promise<[string, null] | [null, Response]>} A promise that resolves to an array containing the access token or an error response.
 */
export async function fetchUpstreamAuthToken({
  client_id,
  client_secret,
  code,
  redirect_uri,
  upstream_url,
}: {
  code: string | undefined;
  upstream_url: string;
  client_secret: string;
  redirect_uri: string;
  client_id: string;
}): Promise<[string, null] | [null, Response]> {
  if (!code) {
    return [null, new Response("Missing code", { status: 400 })];
  }

  const resp = await fetch(upstream_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
  });
  if (!resp.ok) {
    console.log(await resp.text());
    return [null, new Response("Failed to fetch access token", { status: 500 })];
  }
  const body = await resp.formData();
  const accessToken = body.get("access_token") as string;
  if (!accessToken) {
    return [null, new Response("Missing access token", { status: 400 })];
  }
  return [accessToken, null];
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
export type Props = {
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

/**
 * Builds the Cognito authorization URL for OAuth flow.
 */
export function getCognitoAuthorizeUrl({
  cognito_domain,
  client_id,
  redirect_uri,
  state,
}: {
  cognito_domain: string;
  client_id: string;
  redirect_uri: string;
  state: string;
}): string {
  const url = new URL(`https://${cognito_domain}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client_id);
  url.searchParams.set('redirect_uri', redirect_uri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  
  return url.toString();
}

/**
 * Fetches an authorization token from Cognito.
 */
export async function fetchCognitoAuthToken({
  client_id,
  client_secret,
  code,
  redirect_uri,
  cognito_domain,
}: {
  code: string | undefined;
  cognito_domain: string;
  client_secret: string;
  redirect_uri: string;
  client_id: string;
}): Promise<[any, null] | [null, Response]> {
  if (!code) {
    return [null, new Response("Missing code", { status: 400 })];
  }

  const tokenUrl = `https://${cognito_domain}/oauth2/token`;
  
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id,
      client_secret,
      code,
      redirect_uri,
    }).toString(),
  });
  
  if (!resp.ok) {
    console.log(await resp.text());
    return [null, new Response("Failed to fetch access token", { status: 500 })];
  }
  
  const tokens = await resp.json() as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  
  if (!tokens.access_token || !tokens.id_token) {
    return [null, new Response("Missing tokens in response", { status: 400 })];
  }
  
  return [tokens, null];
}

/**
 * Parses a JWT token and returns the payload.
 */
export function parseJWT(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch (error) {
    console.error('Error parsing JWT:', error);
    throw new Error('Failed to parse JWT token');
  }
}

/**
 * Refreshes Cognito tokens using the refresh token.
 */
export async function refreshCognitoTokens({
  client_id,
  client_secret,
  refresh_token,
  cognito_domain,
}: {
  refresh_token: string;
  cognito_domain: string;
  client_secret: string;
  client_id: string;
}): Promise<[any, null] | [null, Response]> {
  const tokenUrl = `https://${cognito_domain}/oauth2/token`;
  
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id,
      client_secret,
      refresh_token,
    }).toString(),
  });
  
  if (!resp.ok) {
    const errorText = await resp.text();
    console.error('Failed to refresh tokens:', errorText);
    return [null, new Response("Failed to refresh tokens", { status: 500 })];
  }
  
  const tokens = await resp.json() as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  
  if (!tokens.access_token || !tokens.id_token) {
    return [null, new Response("Missing tokens in refresh response", { status: 400 })];
  }
  
  return [tokens, null];
}

/**
 * Checks if a token is about to expire (within 5 minutes).
 */
export function isTokenNearExpiry(tokenIssuedAt: number, expiryMinutes: number = 60): boolean {
  const now = Math.floor(Date.now() / 1000);
  const tokenExpiresAt = tokenIssuedAt + (expiryMinutes * 60);
  const fiveMinutesFromNow = now + (5 * 60);
  
  return tokenExpiresAt <= fiveMinutesFromNow;
}

/**
 * Creates updated Props with new token information.
 */
export function updatePropsWithTokens(currentProps: Props, tokens: any): Props {
  const now = Math.floor(Date.now() / 1000);
  const idTokenPayload = parseJWT(tokens.id_token);
  
  return {
    ...currentProps,
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token || currentProps.refreshToken, // Keep existing if not provided
    tokenIssuedAt: now,
    tokenExpiresAt: now + (60 * 60), // 60 minutes from now
    // Update user info from new ID token in case it changed
    sub: idTokenPayload.sub || currentProps.sub,
    email: idTokenPayload.email || currentProps.email,
    name: (idTokenPayload.given_name && idTokenPayload.family_name) 
      ? `${idTokenPayload.given_name} ${idTokenPayload.family_name}` 
      : idTokenPayload.email || currentProps.name,
  };
}
