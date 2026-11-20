import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let allowed = true;
let subject = "google-user-one";
let pending: (() => void) | undefined;
let defer = false;
const requestPopup = vi.fn();

beforeEach(() => {
  vi.resetModules();
  allowed = true; subject = "google-user-one"; pending = undefined; defer = false;
  requestPopup.mockReset();
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com");
  vi.stubGlobal("document", {
    createElement: () => ({ remove: vi.fn(), onload: undefined }),
    head: { appendChild: (script: { onload: () => void }) => queueMicrotask(() => script.onload()) },
  });
  vi.stubGlobal("window", {
    location: { href: "https://paper.example/", origin: "https://paper.example" },
    google: { accounts: { oauth2: {
      hasGrantedAllScopes: () => allowed,
      initTokenClient: (config: { callback: (response: unknown) => void; scope: string }) => ({
        requestAccessToken: () => {
          requestPopup();
          pending = () => config.callback({ access_token: "test-token", expires_in: 3600, scope: config.scope });
          if (!defer) queueMicrotask(pending);
        },
      }),
    } } },
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sub: subject, email: "reader@example.com", email_verified: true })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Google Drive authorization boundaries", () => {
  it("does not open a login popup for a background request", async () => {
    const drive = await import("./drive");
    await expect(drive.getDriveAccessToken()).rejects.toThrow("연결이 만료");
    expect(requestPopup).not.toHaveBeenCalled();
  });
  it("rejects partial permission grants before accepting a token", async () => {
    allowed = false;
    const drive = await import("./drive");
    await expect(drive.authorizeDriveWorkspace()).rejects.toThrow("필요한 권한");
    expect(drive.driveConnected()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("disconnects if identity changes while a workspace is connected", async () => {
    const drive = await import("./drive");
    expect((await drive.authorizeDriveWorkspace()).id).toBe(subject);
    subject = "another-google-account";
    await expect(drive.getGoogleUser()).rejects.toThrow("다른 Google 계정");
    expect(drive.driveConnected()).toBe(false);
  });
  it("ignores an OAuth callback arriving after logout", async () => {
    defer = true;
    const drive = await import("./drive");
    const signingIn = drive.authorizeDriveWorkspace();
    const rejected = expect(signingIn).rejects.toThrow("취소");
    await vi.waitFor(() => expect(pending).toBeTypeOf("function"));
    drive.disconnectDrive();
    pending!();
    await rejected;
    expect(drive.driveConnected()).toBe(false);
  });
  it("never forwards a Google token outside the app origin", async () => {
    const drive = await import("./drive");
    await drive.authorizeDriveWorkspace();
    vi.mocked(fetch).mockClear();
    const { authorizedFetch } = await import("./api");
    await expect(authorizedFetch("https://other.example/api")).rejects.toThrow("앱 내부 요청");
    expect(fetch).not.toHaveBeenCalled();
    await authorizedFetch("/api/providers");
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
  });
});
