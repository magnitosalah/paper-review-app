import { createHash } from "node:crypto";
import { requireUser } from "@/lib/server/auth";
import { claimChatRequest, finishChatRequest, getChatRequest } from "@/lib/server/chat-requests";
import { chatRequestSchema, MAX_ANSWER_CHARS, ProviderError, publicError, readBoundedJson, streamProvider, validateProvider } from "@/lib/server/providers";

export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";
const headers = {"Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff"};
const encoder = new TextEncoder();
const line = (value: unknown) => encoder.encode(JSON.stringify(value) + "\n");

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const id = new URL(request.url).searchParams.get("requestId") ?? "";
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(id)) return Response.json({error: "올바른 요청 ID가 필요합니다."}, {status: 400});
    const record = await getChatRequest(user, id);
    if (!record) return Response.json({error: "요청 기록을 찾을 수 없습니다."}, {status: 404});
    return Response.json({requestId: record.requestId, status: record.status, answer: record.answer, error: record.error, updatedAt: record.updatedAt}, {headers: {"Cache-Control": "no-store"}});
  } catch (error) {
    if (error instanceof Response) return error;
    const safe = publicError(error); return Response.json({error: safe.message}, {status: safe.status});
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const parsed = chatRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) return Response.json({error: "질문 형식 또는 길이를 확인해 주세요. 질문은 마지막 메시지에 포함되어야 합니다."}, {status: 400});
    const input = parsed.data;
    validateProvider(input);
    if (user.expiresAt && user.expiresAt - Date.now() < 180_000) return Response.json({error: "답변 저장까지 Google 연결을 유지해야 합니다. Drive를 다시 연결한 뒤 질문해 주세요."}, {status: 401});
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const claimed = await claimChatRequest(user, input.requestId, requestHash);
    if (!claimed.claimed) {
      if (claimed.request.status === "complete") {
        return new Response(new ReadableStream({start(controller) {
          if (claimed.request.answer) controller.enqueue(line({type: "delta", text: claimed.request.answer}));
          controller.enqueue(line({type: "done"})); controller.close();
        }}), {headers});
      }
      return Response.json({error: "이미 처리된 요청이거나 처리 중입니다. 요청 상태를 확인해 주세요.", requestId: input.requestId, status: claimed.request.status}, {status: 409});
    }

    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(110_000)]);
    // Runner receipts are also isolated by authenticated user, not a browser-chosen ID alone.
    const providerInput = input.provider === "codex" ? {...input, requestId: createHash("sha256").update(`${user.id}\0${input.requestId}`).digest("hex")} : input;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let answer = "";
        const emit = (event: unknown) => { if (!cancelled) controller.enqueue(line(event)); };
        try {
          for await (const delta of streamProvider(providerInput, signal)) {
            answer += delta;
            if (answer.length > MAX_ANSWER_CHARS) throw new ProviderError("답변이 허용 길이를 초과했습니다.");
            emit({type: "delta", text: delta});
          }
          if (!answer.trim()) throw new ProviderError("AI가 빈 답변을 반환했습니다.");
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          // Save before emitting done: a confirmed answer is recoverable from another device.
          await finishChatRequest(user, input.requestId, {status: "complete", answer});
          emit({type: "done"});
        } catch (error) {
          let safe = publicError(error);
          if (error instanceof Response) {
            const body = await error.json().catch(() => null);
            if (typeof body?.error === "string") safe = {message: body.error, status: error.status};
          }
          const status = signal.aborted ? "interrupted" : "failed";
          try { await finishChatRequest(user, input.requestId, {status, answer, error: safe.message}); }
          catch { /* A pending record is retained for recovery; never claim a successful save. */ }
          emit({type: "error", message: safe.message});
        } finally {
          abort.abort();
          if (!cancelled) controller.close();
        }
      },
      cancel() { cancelled = true; abort.abort(); },
    });
    return new Response(body, {headers});
  } catch (error) {
    if (error instanceof Response) return error;
    const safe = publicError(error); return Response.json({error: safe.message}, {status: safe.status});
  }
}
