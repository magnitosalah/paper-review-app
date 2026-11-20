import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { samplePdf } from "./sample";
import { extractReferences, findMatchingPages, textItemsToText } from "./pdf-utils";

describe("bundled reading guide PDF", () => {
  it("parses with PDF.js and supplies selectable, searchable text plus a reference", async () => {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = getDocument({
      data: new Uint8Array(await samplePdf().arrayBuffer()),
      standardFontDataUrl: fileURLToPath(new URL("../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)).replace(/\\/g,"/"),
    });
    const document = await loadingTask.promise;
    try {
      expect(document.numPages).toBe(2);
      const textByPage: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({scale:1});
        expect(viewport.width).toBe(612);
        expect(viewport.height).toBe(792);
        const content = await page.getTextContent();
        textByPage.push(textItemsToText(content.items.filter(item => "str" in item)));
      }
      expect(findMatchingPages(textByPage,"A useful explanation connects a new idea")).toEqual([1]);
      const references = extractReferences(textByPage);
      expect(references).toHaveLength(1);
      expect(references[0].label).toBe("1");
      expect(references[0].citation).toContain("Vaswani");
      expect(references[0].citation).toContain("Attention Is All You Need");
      expect(references[0].citation).not.toContain("Try it");
      expect(references[0].citation).not.toContain("No AI response");
    } finally { await loadingTask.destroy(); }
  },15000);
});
