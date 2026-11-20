/** Small, deterministic helpers. PDF reading order still needs user verification. */
export function normalizeQuoteText(text: string): string {
  return text.replace(/([\p{L}])-\s*\n\s*([\p{L}])/gu, "$1$2").replace(/\s+/g, " ").trim();
}

export interface PdfTextItem { str?: string; hasEOL?: boolean; transform?: number[]; height?: number }

export function textItemsToText(items: PdfTextItem[]): string {
  let result = "";
  let previousY: number | undefined;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5];
    if (previousY !== undefined && y !== undefined && Math.abs(y - previousY) > Math.max(2, (item.height ?? 10) * .6) && !result.endsWith("\n")) result += "\n";
    result += item.str;
    result += item.hasEOL ? "\n" : " ";
    if (y !== undefined) previousY = y;
  }
  return result.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ExtractedReference { label: string; citation: string }

/** Extract candidates only after a bibliography heading; never invent metadata. */
export function extractReferences(textByPage: string[]): ExtractedReference[] {
  const text = textByPage.join("\n");
  const heading = /(?:^|\n)\s*(?:\d+[.\s]+)?(?:references|bibliography|literature cited|참\s*고\s*문\s*헌)\s*(?=\n|$)/im.exec(text);
  if (!heading) return [];
  const tail = text.slice(heading.index + heading[0].length).split(/\n\s*(?:appendix(?:\s+[A-Z0-9])?|supplementary material|acknowledg(?:e)?ments)\s*(?:\n|$)/i)[0];
  const lines = tail.split("\n").map(line => line.trim()).filter(Boolean);
  const result: ExtractedReference[] = [];
  let current: ExtractedReference | null = null;
  const numbered = lines.some(line => /^(?:\[(\d{1,3})\]|(\d{1,3})[.)])\s+\S/.test(line));
  for (const line of lines) {
    if (/^\d{1,4}$/.test(line) || /^(?:references|bibliography)$/i.test(line)) continue;
    const number = /^(?:\[(\d{1,3})\]|(\d{1,3})[.)])\s+(.+)/.exec(line);
    const authorYear = !numbered && /^[\p{L}][^\n]{0,180}\b(?:18|19|20)\d{2}[a-z]?\b/u.test(line);
    if ((numbered && number) || authorYear) {
      if (current) result.push(current);
      current = { label: number ? (number[1] ?? number[2]) : String(result.length + 1), citation: number ? number[3] : line };
    } else if (current) current.citation += ` ${line}`;
    if (result.length >= 200) break;
  }
  if (current && result.length < 200) result.push(current);
  return result.map(ref => ({ label: ref.label, citation: normalizeQuoteText(ref.citation).slice(0, 3000) })).filter(ref => ref.citation.length >= 20);
}

export function findMatchingPages(textByPage: string[], query: string): number[] {
  const needle = normalizeQuoteText(query).toLocaleLowerCase();
  if (!needle) return [];
  return textByPage.flatMap((text, index) => normalizeQuoteText(text).toLocaleLowerCase().includes(needle) ? [index + 1] : []);
}
