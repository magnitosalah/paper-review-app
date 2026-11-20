import { requireUser } from "@/lib/server/auth";
import { publicError } from "@/lib/server/providers";
import { searchReferences } from "./search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireUser(request);
    const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    if (query.length < 3 || query.length > 500) return Response.json({error: "논문 제목이나 DOI를 3~500자로 입력해 주세요."}, {status: 400});
    const results = await searchReferences(query, request.signal);
    return Response.json({results}, {headers: {"Cache-Control": "no-store"}});
  } catch (error) {
    if (error instanceof Response) return error;
    const safe = publicError(error); return Response.json({error: safe.message}, {status: safe.status});
  }
}
