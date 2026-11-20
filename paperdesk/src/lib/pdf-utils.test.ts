import { describe, expect, it } from "vitest";
import { extractReferences, findMatchingPages, normalizeQuoteText, textItemsToText } from "./pdf-utils";

describe("PDF evidence helpers", () => {
  it("joins broken words but preserves meaningful hyphens", () => {
    expect(normalizeQuoteText("self-attention is inter-\nnational\t research")).toBe("self-attention is international research");
  });
  it("preserves line boundaries needed for bibliography parsing", () => {
    expect(textItemsToText([{str:"References",transform:[1,0,0,1,10,30],height:10},{str:"[1] A paper",transform:[1,0,0,1,10,10],height:10}])).toBe("References\n[1] A paper");
  });
  it("does not mistake numbered results in the body for references", () => {
    expect(extractReferences(["Results\n1. This method works well in experiments (2024).\n2. Another result."])).toEqual([]);
  });
  it("retains wrapped citations across page boundaries without guessing titles", () => {
    expect(extractReferences(["Introduction [1].\nReferences\n[1] Vaswani, A. et al. Attention is", "all you need. 2017.\n[2] Smith, J. A second long paper. 2024.\nAppendix A\nExtra stuff"])).toEqual([
      {label:"1",citation:"Vaswani, A. et al. Attention is all you need. 2017."},
      {label:"2",citation:"Smith, J. A second long paper. 2024."},
    ]);
  });
  it("recognizes Korean headings and author-year entries", () => {
    expect(extractReferences(["참고문헌\nKim, J. (2024). A long enough research title.\nPark, M. (2023). Another research article."])).toHaveLength(2);
  });
  it("searches across text line breaks and ignores case", () => {
    expect(findMatchingPages(["A multi-\nmodal method", "Nothing relevant", "MULTIMODAL inference"], "multimodal")).toEqual([1,3]);
  });
});
