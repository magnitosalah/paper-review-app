import { providerStatuses } from "@/lib/server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({providers: providerStatuses()}, {headers: {"Cache-Control": "no-store"}});
}
