import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({user: vi.fn(), claim: vi.fn(), finish: vi.fn(), get: vi.fn(), stream: vi.fn()}));
vi.mock("@/lib/server/auth", () => ({requireUser: mocks.user}));
vi.mock("@/lib/server/chat-requests", () => ({claimChatRequest: mocks.claim, finishChatRequest: mocks.finish, getChatRequest: mocks.get}));
vi.mock("@/lib/server/providers", async importOriginal => ({...await importOriginal<typeof import("@/lib/server/providers")>(), streamProvider: mocks.stream}));
import { GET, POST } from "./route";

const input = {requestId: "9b5d058c-3e72-4f86-837c-6e55b13bd264", provider: "gemini", model: "allowed-model", messages: [{role: "user", content: "설명해 줘"}]};
const makeRequest = (body = input) => new Request("https://paperdesk.test/api/chat", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "unit-test-key"); vi.stubEnv("GEMINI_MODELS", "allowed-model");
  mocks.user.mockResolvedValue({id: "user-one"});
  mocks.claim.mockResolvedValue({claimed: true, request: {status: "pending"}});
  mocks.finish.mockResolvedValue({status: "complete"});
  mocks.stream.mockImplementation(async function* () { yield "답변"; });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("chat request lifecycle", () => {
  it("requires authentication before claiming or contacting a provider", async () => {
    mocks.user.mockRejectedValue(new Response(null, {status: 401}));
    const response = await POST(makeRequest());
    expect(response.status).toBe(401); expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
  });
  it("rejects unapproved model IDs before recording the request", async () => {
    const response = await POST(makeRequest({...input, model: "unapproved"}));
    expect(response.status).toBe(400); expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("replays a completed request without charging a second provider request", async () => {
    mocks.claim.mockResolvedValue({claimed: false, request: {status: "complete", answer: "기존 답변"}});
    const response = await POST(makeRequest());
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events).toEqual([{type: "delta", text: "기존 답변"}, {type: "done"}]);
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it("does not automatically rerun pending or failed requests", async () => {
    for (const status of ["pending", "failed", "interrupted"]) {
      mocks.claim.mockResolvedValue({claimed: false, request: {status}});
      expect((await POST(makeRequest())).status).toBe(409);
    }
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it("persists the complete answer before emitting the final event", async () => {
    const response = await POST(makeRequest()); const text = await response.text();
    expect(text).toContain('"type":"done"');
    expect(mocks.finish).toHaveBeenCalledWith({id: "user-one"}, input.requestId, {status: "complete", answer: "답변"});
  });
  it("preserves partial output as failed and never emits done on disconnect", async () => {
    mocks.stream.mockImplementation(async function* () { yield "부분 답변"; throw new Error("upstream secret error"); });
    const response = await POST(makeRequest()); const text = await response.text();
    expect(text).toContain("부분 답변"); expect(text).toContain('"type":"error"');
    expect(text).not.toContain('"type":"done"'); expect(text).not.toContain("upstream secret");
    expect(mocks.finish).toHaveBeenCalledWith({id: "user-one"}, input.requestId, expect.objectContaining({status: "failed", answer: "부분 답변"}));
  });
  it("returns only the authenticated user's saved status without its request hash", async () => {
    mocks.get.mockResolvedValue({requestId: input.requestId, status: "complete", answer: "saved", requestHash: "private-hash", updatedAt: "2026-11-20"});
    const response = await GET(new Request(`https://paperdesk.test/api/chat?requestId=${input.requestId}`));
    const body = await response.json();
    expect(mocks.get).toHaveBeenCalledWith({id: "user-one"}, input.requestId);
    expect(body.answer).toBe("saved"); expect(body.requestHash).toBeUndefined();
  });
  it("does not start generation when the Google token may expire before answer storage", async () => {
    mocks.user.mockResolvedValue({id: "google-user", accessToken: "token", expiresAt: Date.now() + 60_000});
    expect((await POST(makeRequest())).status).toBe(401);
    expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
  });
  it("does not start a provider when Drive receipt creation is uncertain", async () => {
    mocks.claim.mockRejectedValue(Response.json({error: "Google Drive 응답 상태 미확인"}, {status: 503}));
    expect((await POST(makeRequest())).status).toBe(503); expect(mocks.stream).not.toHaveBeenCalled();
  });
});
