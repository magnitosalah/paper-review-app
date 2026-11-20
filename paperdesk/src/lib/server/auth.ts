export interface AuthenticatedUser { id: string; email?: string; accessToken?: string; expiresAt?: number }
export const LOCAL_USER_ID = "local-development";
const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host.toLowerCase());

function failure(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/** Explicit development-only access; production and forwarded remote requests never qualify. */
export function isLocalDevelopmentRequest(request: Request): boolean {
  if (process.env.NODE_ENV !== "development" || process.env.ALLOW_LOCAL_DEV !== "true" || process.env.VERCEL) return false;
  const target = new URL(request.url);
  if (!loopback(target.hostname)) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== target.origin) return false;
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor && forwardedFor.split(",").some(value => !loopback(value.trim()))) return false;
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost && forwardedHost !== target.host) return false;
  return true;
}

export async function requireUser(request: Request): Promise<AuthenticatedUser> {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    if (isLocalDevelopmentRequest(request)) return { id: LOCAL_USER_ID };
    throw failure("로그인이 필요합니다.", 401);
  }
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match || match[1].length > 8192) throw failure("로그인 정보를 확인할 수 없습니다.", 401);
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim();
  const allowed = (process.env.ALLOWED_EMAILS ?? "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!clientId || !allowed.length) throw failure("Google 로그인 설정과 허용 계정 설정이 필요합니다.", 503);
  const accessToken = match[1];
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]);
  let token: Record<string, unknown>; let profile: Record<string, unknown>;
  try {
    // Google's own OAuth client uses POST + Bearer for tokeninfo. Keep tokens out of URLs.
    const [tokenResponse, profileResponse] = await Promise.all([
      fetch("https://oauth2.googleapis.com/tokeninfo", {method: "POST", headers: {authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded;charset=UTF-8"}, cache: "no-store", redirect: "error", signal}),
      fetch("https://openidconnect.googleapis.com/v1/userinfo", {headers: {authorization: `Bearer ${accessToken}`}, cache: "no-store", redirect: "error", signal}),
    ]);
    if (!tokenResponse.ok || !profileResponse.ok) {
      if ([400, 401, 403].includes(tokenResponse.status) || [400, 401, 403].includes(profileResponse.status)) throw failure("Google 연결이 만료되었습니다. 다시 연결해 주세요.", 401);
      throw failure("Google 인증 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503);
    }
    [token, profile] = await Promise.all([tokenResponse.json(), profileResponse.json()]);
  } catch (error) {
    if (error instanceof Response) throw error;
    throw failure("Google 인증 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503);
  }
  if (!token || !profile || token.aud !== clientId || (token.azp && token.azp !== clientId)) throw failure("이 앱에서 발급받은 Google 연결이 아닙니다. 다시 연결해 주세요.", 401);
  const remaining = Number(token.expires_in);
  if (!Number.isFinite(remaining) || remaining <= 0) throw failure("Google 연결이 만료되었습니다. 다시 연결해 주세요.", 401);
  const scopes = new Set(typeof token.scope === "string" ? token.scope.split(/\s+/) : []);
  if (!scopes.has("openid") || !scopes.has("https://www.googleapis.com/auth/drive.appdata")) throw failure("Google 로그인과 앱 데이터 저장 권한이 필요합니다. Drive를 다시 연결해 주세요.", 403);
  if (typeof profile.sub !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(profile.sub) || (token.sub && token.sub !== profile.sub)) throw failure("Google 계정을 확인할 수 없습니다.", 401);
  if (typeof profile.email !== "string" || profile.email_verified !== true || !allowed.includes(profile.email.toLowerCase())) {
    throw failure("이 앱에 허용된 계정이 아닙니다.", 403);
  }
  return {id: profile.sub, email: profile.email, accessToken, expiresAt: Date.now() + remaining * 1000};
}
