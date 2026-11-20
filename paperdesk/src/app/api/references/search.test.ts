import { afterEach, describe, expect, it, vi } from "vitest";
import { doiFromQuery, normalizeCrossref, normalizeDataCite, plainMetadata, searchReferences } from "./search";

afterEach(() => { vi.unstubAllGlobals(); });

const arxivRecord = {
  id: "10.48550/arXiv.1706.03762", type: "dois",
  attributes: {
    doi: "10.48550/arXiv.1706.03762", publicationYear: 2017,
    titles: [{title: "Attention Is All You Need"}],
    creators: [{givenName: "Ashish", familyName: "Vaswani", name: "Vaswani, Ashish"}],
    descriptions: [{descriptionType: "Abstract", description: "<p>A supplied abstract.</p>"}],
    url: "javascript:alert(1)",
  },
};
const sampleCitation = "Vaswani, A., et al. (2017). Attention Is All You Need. Advances in Neural Information Processing Systems. https://doi.org/10.48550/arXiv.1706.03762";

describe("reference normalization", () => {
  it("accepts DOI and DOI URLs, never arbitrary lookup URLs", () => {
    expect(doiFromQuery("https://doi.org/10.1000/Example")).toBe("10.1000/example");
    expect(doiFromQuery("doi: 10.1000/example")).toBe("10.1000/example");
    expect(doiFromQuery("http://169.254.169.254/latest/meta-data")).toBeNull();
    expect(doiFromQuery("A useful paper title")).toBeNull();
  });
  it("extracts an exact DOI from a full reference citation", () => {
    expect(doiFromQuery(sampleCitation)).toBe("10.48550/arxiv.1706.03762");
    expect(doiFromQuery("Author (2024). A useful paper. DOI: 10.1000/Example.")).toBe("10.1000/example");
    expect(doiFromQuery("[12] A paper (https://dx.doi.org/10.1000%2FExample)." )).toBe("10.1000/example");
  });
  it("removes citation wrappers while retaining balanced parentheses in DOI suffixes", () => {
    expect(doiFromQuery("A reference [doi:10.1000/example];")).toBe("10.1000/example");
    expect(doiFromQuery("A reference (https://doi.org/10.1000/example(2024)).")).toBe("10.1000/example(2024)");
    expect(doiFromQuery("https://doi.org.evil.example/10.1000/test")).toBeNull();
    expect(doiFromQuery(`10.1000/${"x".repeat(241)}`)).toBeNull();
  });
  it("converts JATS abstract markup to plain text", () => {
    expect(plainMetadata("<jats:p>A &amp; B</jats:p><script>steal()</script> &#xAC00;")).toBe("A & B\n 가");
  });
  it("never grants full-text evidence from metadata", () => {
    const work = {title: ["A paper"], DOI: "10.1000/test", author: [{given: "Ada", family: "Lovelace"}], published: {"date-parts": [[2024, 1]]}, URL: "javascript:alert(1)", abstract: "<p>An abstract.</p>"};
    const candidate = normalizeCrossref(work);
    expect(candidate).toMatchObject({title: "A paper", authors: "Ada Lovelace", year: 2024, doi: "10.1000/test", evidence: "abstract", abstract: "An abstract.", url: "https://doi.org/10.1000/test"});
    expect(normalizeCrossref({...work, abstract: undefined})?.evidence).toBe("metadata");
    expect(normalizeCrossref({DOI: "10.1000/test"})).toBeNull();
  });
  it("normalizes DataCite arXiv metadata without trusting result URLs", () => {
    expect(normalizeDataCite(arxivRecord)).toMatchObject({
      title: "Attention Is All You Need", authors: "Ashish Vaswani", year: 2017,
      doi: "10.48550/arxiv.1706.03762", url: "https://doi.org/10.48550/arxiv.1706.03762",
      abstract: "A supplied abstract.", evidence: "abstract",
    });
    expect(normalizeDataCite({...arxivRecord, attributes: {...arxivRecord.attributes, descriptions: [{descriptionType: "Methods", description: "Some methods"}]}})?.evidence).toBe("metadata");
  });
  it("falls back to DataCite for a DOI absent from Crossref", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {status: 404}))
      .mockResolvedValueOnce(Response.json({data: arxivRecord}));
    vi.stubGlobal("fetch", fetchMock);
    const results = await searchReferences(sampleCitation);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Attention Is All You Need");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.crossref.org/works/10.48550%2Farxiv.1706.03762");
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://api.datacite.org/dois/10.48550%2Farxiv.1706.03762");
  });
  it("does not make a second registry request after a Crossref match", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({message: {DOI: "10.1000/test", title: ["A paper"]}}));
    vi.stubGlobal("fetch", fetchMock);
    expect(await searchReferences("10.1000/test")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not return an unrelated Crossref record for an extracted DOI", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({message: {DOI: "10.1000/unrelated", title: ["An unrelated work"]}}))
      .mockResolvedValueOnce(Response.json({data: arxivRecord}));
    vi.stubGlobal("fetch", fetchMock);
    const results = await searchReferences(sampleCitation);
    expect(results.map(candidate => candidate.doi)).toEqual(["10.48550/arxiv.1706.03762"]);
  });
  it("returns no candidate for unknown or mismatched registry DOIs", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, {status: 404})).mockResolvedValueOnce(new Response(null, {status: 404}));
    vi.stubGlobal("fetch", fetchMock);
    expect(await searchReferences("10.1000/unknown")).toEqual([]);
    fetchMock.mockResolvedValueOnce(new Response(null, {status: 404})).mockResolvedValueOnce(Response.json({data: arxivRecord}));
    expect(await searchReferences("10.1000/different")).toEqual([]);
  });
  it("keeps bibliographic searches available for citations without a DOI", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({message: {items: [{DOI: "10.1000/test", title: ["A useful paper"]}]}}));
    vi.stubGlobal("fetch", fetchMock);
    expect(await searchReferences("Author (2024). A useful paper.")).toHaveLength(1);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("query.bibliographic")).toBe("Author (2024). A useful paper.");
  });
  it.runIf(process.env.PAPERDESK_LIVE_METADATA_TESTS === "true")("finds the sample citation through the live DOI registries", async () => {
    const results = await searchReferences(sampleCitation);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({title: "Attention Is All You Need", doi: "10.48550/arxiv.1706.03762", year: 2017});
  }, 30_000);
});
