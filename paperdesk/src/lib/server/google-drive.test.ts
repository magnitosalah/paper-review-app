import { afterEach, describe, expect, it, vi } from "vitest";
import { claimChatRequest, finishChatRequest, getChatRequest } from "./chat-requests";
import { createDriveReceipt, readDriveReceipt, receiptProperties } from "./google-drive";

const user = {id: "123456789012345678901", email: "owner@example.com", accessToken: "test-google-access-token"};
const requestId = "1GoogleGeneratedRequestId123456";
function envelope(status = "pending") {
  const now = new Date().toISOString();
  return {version: 1, ownerId: user.id, record: {requestId, requestHash: "same-hash", status, createdAt: now, updatedAt: now}};
}
function metadata(overrides: Record<string, unknown> = {}) {
  return {id: requestId, mimeType: "application/json", ownedByMe: true, trashed: false, spaces: ["appDataFolder"], appProperties: receiptProperties(user.id, requestId), ...overrides};
}
afterEach(() => {vi.unstubAllGlobals();});

describe("Drive request receipts", () => {
  it("creates one receipt with the pre-generated ID and never stores OAuth tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({id: requestId})); vi.stubGlobal("fetch", fetchMock);
    expect(await createDriveReceipt(user, requestId, envelope())).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Bearer ${user.accessToken}`);
    expect(init.body).toContain(`"id":"${requestId}"`); expect(init.body).toContain('"parents":["appDataFolder"]');
    expect(init.body).not.toContain(user.accessToken);
    expect(init.body).toContain('"application":"paperdesk"');
  });
  it("authorizes inference only after a confirmed create, and reuses an existing receipt on 409", async () => {
    let exists = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        if (exists) return new Response(null, {status: 409});
        exists = true; return Response.json({id: requestId});
      }
      return Response.json(url.includes("alt=media") ? envelope() : metadata());
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.all([claimChatRequest(user, requestId, "same-hash"), claimChatRequest(user, requestId, "same-hash")]);
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(results.every(result => result.request.requestHash === "same-hash")).toBe(true);
  });
  it("treats an ambiguous create result as failure instead of starting an AI request", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("timeout")); vi.stubGlobal("fetch", fetchMock);
    await expect(claimChatRequest(user, requestId, "same-hash")).rejects.toMatchObject({status: 503});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects ordinary Drive files or a different owner before reading their content", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(metadata({spaces: ["drive"]}))).mockResolvedValueOnce(Response.json(metadata({appProperties: receiptProperties("other-owner", requestId)})));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readDriveReceipt(user, requestId)).rejects.toMatchObject({status: 403});
    await expect(readDriveReceipt(user, requestId)).rejects.toMatchObject({status: 403});
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("alt=media"))).toBe(true);
  });
  it("rejects a duplicate ID with another question hash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, {status: 409})).mockResolvedValueOnce(Response.json(metadata())).mockResolvedValueOnce(Response.json(envelope())));
    await expect(claimChatRequest(user, requestId, "different-hash")).rejects.toMatchObject({status: 409});
  });
  it("saves a completed answer only after verifying metadata and the body owner", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(metadata())).mockResolvedValueOnce(Response.json(envelope())).mockResolvedValueOnce(Response.json({id: requestId}));
    vi.stubGlobal("fetch", fetchMock);
    expect(await finishChatRequest(user, requestId, {status: "complete", answer: "Saved answer"})).toMatchObject({status: "complete", answer: "Saved answer"});
    const update = fetchMock.mock.calls[2];
    expect(update[1].method).toBe("PATCH");
    expect(JSON.parse(update[1].body).record.answer).toBe("Saved answer");
    expect(update[1].body).not.toContain(user.accessToken);
  });
  it("never overwrites an already complete answer with a late failure", async () => {
    const body = envelope("complete");
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(metadata())).mockResolvedValueOnce(Response.json(body)); vi.stubGlobal("fetch", fetchMock);
    expect((await finishChatRequest(user, requestId, {status: "failed", error: "late error"})).status).toBe("complete");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("shows an abandoned pending receipt as interrupted without writing during GET", async () => {
    const body = envelope(); body.record.updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(metadata())).mockResolvedValueOnce(Response.json(body)); vi.stubGlobal("fetch", fetchMock);
    expect((await getChatRequest(user, requestId))?.status).toBe("interrupted"); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("rejects a receipt body carrying another Google account's identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(metadata())).mockResolvedValueOnce(Response.json({...envelope(), ownerId: "other-google-user"})));
    await expect(getChatRequest(user, requestId)).rejects.toMatchObject({status: 409});
  });
  it("uses fixed-size private properties even for long IDs", () => {
    const properties = receiptProperties("s".repeat(255), "r".repeat(200));
    expect(Object.entries(properties).every(([key, value]) => key.length + value.length < 124)).toBe(true);
  });
});
