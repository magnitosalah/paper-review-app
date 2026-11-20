import { createHash } from "node:crypto";
import { ProviderError } from "@/lib/server/providers";

export interface ReferenceCandidate {
  id: string;
  title: string;
  authors: string;
  year?: number;
  doi?: string;
  url?: string;
  abstract?: string;
  evidence: "metadata" | "abstract";
}

export function plainMetadata(value: unknown, limit = 24_000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(?:jats:)?(?:p|sec|title)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (all, decimal, hex, named) => {
      if (decimal || hex) {
        const number = Number.parseInt(decimal || hex, decimal ? 10 : 16);
        return number > 31 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : "";
      }
      return ({amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "} as Record<string, string>)[String(named).toLowerCase()] ?? all;
    })
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);
}

export function doiFromQuery(query: string): string | null {
  const value = query.trim();
  // Reference-list searches contain the whole citation, not just an isolated DOI.
  const resolver = value.match(/\bhttps?:\/\/(?:dx\.)?doi\.org\/[^\s<>"“”]+/i);
  let candidate: string;
  if (resolver) {
    try {
      candidate = decodeURIComponent(new URL(resolver[0]).pathname.slice(1));
    } catch { return null; }
  } else {
    // Arbitrary URLs are never lookup targets. Bare DOIs can occur after author/title text.
    if (/^https?:\/\//i.test(value)) return null;
    const match = value.match(/(?:^|[\s([{;,:])(?:doi:\s*)?(10\.\d{4,9}\/[^\s<>"“”]+)/i);
    if (!match) return null;
    candidate = match[1];
  }
  // Remove citation punctuation while retaining balanced parentheses used by valid DOIs.
  for (;;) {
    const previous = candidate;
    candidate = candidate.replace(/[.,;:'’”]+$/, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      if (candidate.endsWith(close) && candidate.split(close).length > candidate.split(open).length) candidate = candidate.slice(0, -1);
    }
    if (candidate === previous) break;
  }
  return /^10\.\d{4,9}\/\S{1,240}$/i.test(candidate) ? candidate.toLowerCase() : null;
}

export function normalizeCrossref(item: unknown): ReferenceCandidate | null {
  if (!item || typeof item !== "object") return null;
  const work = item as Record<string, unknown>;
  const title = plainMetadata(Array.isArray(work.title) ? work.title[0] : work.title, 2_000);
  if (!title) return null;
  const doi = typeof work.DOI === "string" ? doiFromQuery(work.DOI) ?? undefined : undefined;
  const authors = (Array.isArray(work.author) ? work.author : []).slice(0, 20).map(author => {
    if (!author || typeof author !== "object") return "";
    const value = author as Record<string, unknown>;
    return [plainMetadata(value.given, 100), plainMetadata(value.family, 100)].filter(Boolean).join(" ") || plainMetadata(value.name, 200);
  }).filter(Boolean).join(", ");
  let year: number | undefined;
  for (const key of ["published", "published-print", "published-online", "issued"]) {
    const date = work[key] as {"date-parts"?: unknown[][]} | undefined;
    const candidate = date?.["date-parts"]?.[0]?.[0];
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 1000 && candidate <= 3000) { year = candidate; break; }
  }
  const abstract = plainMetadata(work.abstract) || undefined;
  // DOI URLs are constructed locally. Never follow a URL supplied by a search result.
  const url = doi ? `https://doi.org/${encodeURI(doi).replace(/#/g, "%23").replace(/\?/g, "%3F")}` : undefined;
  const id = `crossref-${createHash("sha256").update(doi ?? `${title}|${authors}|${year ?? ""}`).digest("hex").slice(0, 24)}`;
  return {id, title, authors: authors || "저자 정보 없음", ...(year ? {year} : {}), ...(doi ? {doi, url} : {}), ...(abstract ? {abstract} : {}), evidence: abstract ? "abstract" : "metadata"};
}

export function normalizeDataCite(item: unknown): ReferenceCandidate | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const attributes = record.attributes;
  if (!attributes || typeof attributes !== "object") return null;
  const work = attributes as Record<string, unknown>;
  const titles = (Array.isArray(work.titles) ? work.titles : []).filter((title): title is Record<string, unknown> => !!title && typeof title === "object");
  const primaryTitle = titles.find(title => !title.titleType) ?? titles[0];
  const creators = (Array.isArray(work.creators) ? work.creators : []).filter((creator): creator is Record<string, unknown> => !!creator && typeof creator === "object");
  const descriptions = (Array.isArray(work.descriptions) ? work.descriptions : []).filter((description): description is Record<string, unknown> => !!description && typeof description === "object");
  // A Methods/Other description is not an abstract; keep the evidence boundary explicit.
  const abstract = descriptions.find(description => String(description.descriptionType).toLowerCase() === "abstract")?.description;
  const candidate = normalizeCrossref({
    DOI: work.doi ?? record.id,
    title: [primaryTitle?.title],
    author: creators.map(creator => ({given: creator.givenName, family: creator.familyName, name: creator.name})),
    published: {"date-parts": [[work.publicationYear]]},
    abstract,
  });
  return candidate ? {...candidate, id: candidate.id.replace(/^crossref-/, "datacite-")} : null;
}

async function fetchMetadata(url: URL, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    headers: {Accept: "application/json", "User-Agent": "Paperdesk/0.1 (reference metadata lookup)"},
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12_000)]),
    redirect: "error", cache: "no-store",
  });
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
  if (!response.ok) throw new ProviderError(response.status === 429 ? "참고문헌 검색 요청이 많습니다. 잠시 후 다시 시도해 주세요." : "참고문헌 검색 서비스에 연결하지 못했습니다.", response.status === 429 ? 429 : 502);
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("참고문헌 검색 결과를 읽지 못했습니다.");
  const decoder = new TextDecoder(); let text = "";
  try {
    for (;;) {
      const {value, done} = await reader.read();
      text += done ? decoder.decode() : decoder.decode(value, {stream: true});
      if (text.length > 1_000_000) throw new ProviderError("참고문헌 검색 응답이 너무 큽니다.");
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch { /* reject below */ }
  throw new ProviderError("참고문헌 검색 응답 형식이 올바르지 않습니다.");
}

export async function searchReferences(query: string, signal?: AbortSignal): Promise<ReferenceCandidate[]> {
  const doi = doiFromQuery(query);
  const url = doi ? new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`) : new URL("https://api.crossref.org/works");
  if (!doi) { url.searchParams.set("query.bibliographic", query); url.searchParams.set("rows", "6"); }
  const data = await fetchMetadata(url, signal);
  if (doi) {
    const crossref = data ? normalizeCrossref(data.message) : null;
    if (crossref?.doi === doi) return [crossref];
    // arXiv and many repositories register DOIs with DataCite, not Crossref.
    // Only the fixed registry endpoint is fetched; no publisher/result URL is followed.
    const dataCite = await fetchMetadata(new URL(`https://api.datacite.org/dois/${encodeURIComponent(doi)}`), signal);
    const candidate = dataCite ? normalizeDataCite(dataCite.data) : null;
    return candidate?.doi === doi ? [candidate] : [];
  }
  if (!data) return [];
  const message = data.message as {items?: unknown[]} | undefined;
  const items = Array.isArray(message?.items) ? message.items : [];
  const unique = new Map<string, ReferenceCandidate>();
  for (const item of items) { const candidate = normalizeCrossref(item); if (candidate) unique.set(candidate.id, candidate); }
  return [...unique.values()].slice(0, 6);
}
