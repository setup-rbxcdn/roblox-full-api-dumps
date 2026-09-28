import { spawn } from "node:child_process";

export function mask(value) {
  if (process.env.GITHUB_ACTIONS && value) console.log(`::add-mask::${value}`);
}

function cookieHeaders(cookie) {
  return { Cookie: `.ROBLOSECURITY=${cookie}` };
}

async function responseMessage(response) {
  const text = await response.text();
  return `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`;
}

async function fetchRoblox(url, init) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt >= 4) return response;
    const delay = 30000 * 2 ** attempt;
    console.log(`Roblox rate limited ${new URL(url).host}; retrying in ${delay / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function getSetCookie(response, name) {
  const headers = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")];
  for (const header of headers) {
    const match = header?.match(new RegExp(`(?:^|[,;]\\s*)${name.replace(".", "\\.")}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

export async function validateCookie(cookie) {
  const response = await fetchRoblox("https://users.roblox.com/v1/users/authenticated", {
    headers: cookieHeaders(cookie),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Roblox rejected the cookie as unauthenticated. It is invalid, expired, was invalidated by a rotation, or does not match this machine's region/IP.");
  }
  if (!response.ok) throw new Error(`ROBLOSECURITY is invalid: ${await responseMessage(response)}`);
  const user = await response.json();
  if (!user.id) throw new Error("ROBLOSECURITY validation returned no user ID");
  return user.id;
}

async function getCsrfToken(cookie) {
  const response = await fetchRoblox("https://auth.roblox.com/v2/logout", {
    method: "POST",
    headers: cookieHeaders(cookie),
  });
  const token = response.headers.get("x-csrf-token");
  if (!token) throw new Error(`Could not obtain Roblox CSRF token: ${await responseMessage(response)}`);
  return token;
}

export async function exchangeAuthenticationTicket(cookie) {
  const response = await fetchRoblox("https://auth.roblox.com/v1/authentication-ticket", {
    method: "POST",
    headers: {
      ...cookieHeaders(cookie),
      "Content-Type": "application/json",
      "X-CSRF-TOKEN": await getCsrfToken(cookie),
      RBXAuthenticationNegotiation: "1",
      Referer: "https://www.roblox.com/",
    },
    body: "{}",
    redirect: "manual",
  });
  const ticket = response.headers.get("rbx-authentication-ticket");
  if (!ticket) throw new Error(`Roblox authentication-ticket request failed: ${await responseMessage(response)}`);

  const redeemed = await fetchRoblox("https://auth.roblox.com/v1/authentication-ticket/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json", RBXAuthenticationNegotiation: "1" },
    body: JSON.stringify({ authenticationTicket: ticket }),
    redirect: "manual",
  });
  const derived = getSetCookie(redeemed, ".ROBLOSECURITY");
  if (!derived) throw new Error(`Roblox authentication-ticket redemption failed: ${await responseMessage(redeemed)}`);
  return derived;
}

export async function createStudioOAuthTokens(cookie) {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const scopes = ["openid", "credentials", "profile", "age", "roles", "premium"].map(
    (scopeType) => ({ scopeType, operations: ["read"] }),
  );
  const response = await fetchRoblox("https://apis.roblox.com/oauth/v1/authorizations", {
    method: "POST",
    headers: {
      ...cookieHeaders(cookie),
      "Content-Type": "application/json-patch+json",
      "X-CSRF-TOKEN": await getCsrfToken(cookie),
      Origin: "https://authorize.roblox.com",
      Referer: "https://authorize.roblox.com/",
    },
    body: JSON.stringify({
      clientId: "7968549422692352298",
      responseTypes: ["Code"],
      redirectUri: "roblox-studio-auth:/",
      scopes,
      state: crypto.randomUUID(),
      codeChallenge: Buffer.from(digest).toString("base64url"),
      codeChallengeMethod: "S256",
      resourceInfos: [],
    }),
  });
  if (!response.ok) throw new Error(`Studio OAuth authorization failed: ${await responseMessage(response)}`);
  const code = new URL((await response.json()).location).searchParams.get("code");
  if (!code) throw new Error("Studio OAuth authorization returned no code");

  const tokenResponse = await fetchRoblox("https://apis.roblox.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "7968549422692352298",
      redirect_uri: "roblox-studio-auth:/",
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Studio OAuth token exchange failed: ${await responseMessage(tokenResponse)}`);
  const tokens = await tokenResponse.json();
  if (!tokens.access_token || !tokens.refresh_token) throw new Error("Studio OAuth returned incomplete tokens");
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: String(Math.floor(Date.now() / 1000) + Number(tokens.expires_in ?? 900)),
  };
}

export async function refreshCookie(cookie) {
  const response = await fetchRoblox("https://auth.roblox.com/v2/logoutfromallsessionsandreauthenticate", {
    method: "POST",
    headers: {
      ...cookieHeaders(cookie),
      "Content-Type": "application/json",
      "X-CSRF-TOKEN": await getCsrfToken(cookie),
    },
    body: "{}",
    redirect: "manual",
  });
  const refreshed = getSetCookie(response, ".ROBLOSECURITY");
  if (!refreshed) throw new Error(`Roblox cookie rotation failed: ${await responseMessage(response)}`);
  return refreshed;
}

export async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}
