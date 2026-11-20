import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalDevelopmentRequest, requireUser } from "./auth";

const tokenBase = {aud: "paperdesk.apps.googleusercontent.com", azp: "paperdesk.apps.googleusercontent.com", sub: "123456789012345678901", expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata"};
const profileBase = {sub: tokenBase.sub, email: "owner@example.com", email_verified: true};
function google(token: Record<string, unknown> = {}, profile: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (url: string) => Response.json(url.includes("tokeninfo") ? {...tokenBase, ...token} : {...profileBase, ...profile}));
  vi.stubGlobal("fetch", fetchMock); return fetchMock;
}
const authenticated = () => new Request("https://app.example.com/api/chat", {headers: {Authorization: "Bearer google-access-token"}});
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("ALLOW_LOCAL_DEV", "false"); vi.stubEnv("VERCEL", "");
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", tokenBase.aud); vi.stubEnv("ALLOWED_EMAILS", "owner@example.com");
  google();
});
afterEach(() => {vi.unstubAllEnvs(); vi.unstubAllGlobals();});

describe("Google authorization", () => {
  it("rejects anonymous access by default, including loopback", async () => {
    await expect(requireUser(new Request("http://127.0.0.1:3000/api/chat"))).rejects.toMatchObject({status: 401});
  });
  it("permits only explicitly enabled development loopback requests", async () => {
    vi.stubEnv("ALLOW_LOCAL_DEV", "true");
    await expect(requireUser(new Request("http://127.0.0.1:3000/api/chat"))).resolves.toEqual({id: "local-development"});
    expect(isLocalDevelopmentRequest(new Request("https://app.example.com/api/chat"))).toBe(false);
    expect(isLocalDevelopmentRequest(new Request("http://localhost:3000/api/chat", {headers: {origin: "https://external.example"}}))).toBe(false);
    expect(isLocalDevelopmentRequest(new Request("http://localhost:3000/api/chat", {headers: {"x-forwarded-for": "203.0.113.5"}}))).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(isLocalDevelopmentRequest(new Request("http://localhost:3000/api/chat"))).toBe(false);
  });
  it("fails closed without a client ID or allowlist", async () => {
    const fetchMock = google(); vi.stubEnv("ALLOWED_EMAILS", "");
    await expect(requireUser(authenticated())).rejects.toMatchObject({status: 503}); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("verifies Google audience and identity, retaining the token only in the server context", async () => {
    const fetchMock = google(); const user = await requireUser(authenticated());
    expect(user).toMatchObject({id: tokenBase.sub, email: profileBase.email, accessToken: "google-access-token"});
    expect(user.expiresAt).toBeGreaterThan(Date.now());
    expect(fetchMock.mock.calls.every(([url]) => !url.includes("google-access-token"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://oauth2.googleapis.com/tokeninfo", expect.objectContaining({method: "POST", headers: expect.objectContaining({authorization: "Bearer google-access-token"})}));
  });
  it("rejects tokens issued to another application", async () => {
    google({aud: "other.apps.googleusercontent.com"}); await expect(requireUser(authenticated())).rejects.toMatchObject({status: 401});
  });
  it("rejects an expired token and mismatched user-info identity", async () => {
    google({expires_in: 0}); await expect(requireUser(authenticated())).rejects.toMatchObject({status: 401});
    google({}, {sub: "different-user"}); await expect(requireUser(authenticated())).rejects.toMatchObject({status: 401});
  });
  it("requires appDataFolder permission before authorizing server work", async () => {
    google({scope: "openid email profile https://www.googleapis.com/auth/drive.file"}); await expect(requireUser(authenticated())).rejects.toMatchObject({status: 403});
  });
  it("rejects an unverified or unlisted email", async () => {
    google({}, {email_verified: false}); await expect(requireUser(authenticated())).rejects.toMatchObject({status: 403});
    google({}, {email: "other@example.com"}); await expect(requireUser(authenticated())).rejects.toMatchObject({status: 403});
  });
  it("returns a generic auth error without reflecting provider data or tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sensitive-provider-detail", {status: 401})));
    const error = await requireUser(authenticated()).catch(value => value as Response);
    if (!(error instanceof Response)) throw new Error("Expected authentication failure");
    expect(error.status).toBe(401); expect(await error.text()).not.toContain("sensitive-provider-detail");
  });
});
