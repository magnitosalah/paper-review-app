"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, LoaderCircle, Maximize, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import type { Paper, PdfRect, Quote, Scrap } from "@/lib/types";
import { findMatchingPages, normalizeQuoteText, textItemsToText } from "@/lib/pdf-utils";
import styles from "./pdf-viewer.module.css";

export interface PdfViewerProps {
  blob: Blob | null;
  paper: Paper | null;
  page: number;
  scale: number;
  highlights: Scrap[];
  focusQuote?: Quote | null;
  onPageChange: (page: number) => void;
  onScaleChange: (scale: number) => void;
  onSelect: (quote: Quote) => void;
  onDocumentLoad: (info: { pageCount: number; textByPage: string[] }) => void;
  onError?: (message: string) => void;
  onCitation?: (label: string) => void;
}

export function PdfViewer(props: PdfViewerProps) {
  const { blob, paper, page, scale, highlights, focusQuote } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [textByPage, setTextByPage] = useState<string[]>([]);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [width, setWidth] = useState(700);
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pageInput, setPageInput] = useState(String(page));
  const [noText, setNoText] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const renderHost = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PageViewport | null>(null);
  const selectionKey = useRef("");
  const searchInput = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<Quote | null>(null);
  const matches = useMemo(() => findMatchingPages(textByPage, query), [textByPage, query]);
  const currentMatch = matches.indexOf(page);
  const actualPage = Math.min(Math.max(1, page), pdf?.numPages ?? 1);

  useEffect(() => setPageInput(String(page)), [page]);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width;
      if (nextWidth && nextWidth > 0) setWidth(nextWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let loadingTask: ReturnType<typeof import("pdfjs-dist")["getDocument"]> | undefined;
    setPdf(null);
    setViewport(null);
    setTextByPage([]);
    setError("");
    setLoading(Boolean(blob));
    selectionKey.current = "";
    renderHost.current?.replaceChildren();
    if (!blob) return;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        if (disposed) return;
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const data = new Uint8Array(await blob.arrayBuffer());
        if (disposed) return;
        loadingTask = pdfjs.getDocument({ data, enableXfa:false, cMapUrl:"/pdf/cmaps/", cMapPacked:true, standardFontDataUrl:"/pdf/standard_fonts/", wasmUrl:"/pdf/wasm/" });
        const document = await loadingTask.promise;
        if (disposed) return;
        setPdf(document);
        setLoading(false);
        const texts: string[] = [];
        for (let i = 1; i <= document.numPages; i += 1) {
          if (disposed) return;
          const current = await document.getPage(i);
          const content = await current.getTextContent();
          texts.push(textItemsToText(content.items.filter(item => "str" in item)));
          if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (disposed) return;
        setTextByPage(texts);
        callbacks.current.onDocumentLoad({ pageCount: document.numPages, textByPage: texts });
      } catch (reason) {
        if (disposed) return;
        const name = reason instanceof Error ? reason.name : "";
        const message = name === "PasswordException" ? "암호가 설정된 PDF입니다. 암호를 해제한 파일을 열어 주세요." : "PDF를 열지 못했습니다. 파일이 올바른 PDF인지 확인해 주세요.";
        setError(message);
        setLoading(false);
        callbacks.current.onError?.(message);
      }
    })();
    return () => { disposed = true; void loadingTask?.destroy().catch(() => undefined); };
  }, [blob, paper?.id]);

  useEffect(() => {
    if (!pdf || !renderHost.current) return;
    let disposed = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let textLayer: InstanceType<typeof import("pdfjs-dist")["TextLayer"]> | undefined;
    const host = renderHost.current;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const textContainer = document.createElement("div");
    textContainer.className = "textLayer";
    host.replaceChildren(canvas, textContainer);
    setRendering(true);
    selectionKey.current = "";
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const current = await pdf.getPage(actualPage);
        if (disposed) return;
        const natural = current.getViewport({ scale: 1 });
        const fitScale = Math.max(0.25, (width - (width < 500 ? 20 : 48)) / natural.width);
        const nextViewport = current.getViewport({ scale: fitScale * Math.min(3, Math.max(.5, scale)) });
        viewportRef.current = nextViewport;
        setViewport(nextViewport);
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(nextViewport.width * ratio);
        canvas.height = Math.ceil(nextViewport.height * ratio);
        canvas.style.width = `${nextViewport.width}px`;
        canvas.style.height = `${nextViewport.height}px`;
        host.style.setProperty("--scale-factor", String(nextViewport.scale));
        host.style.setProperty("--total-scale-factor", String(nextViewport.scale * nextViewport.userUnit));
        host.style.setProperty("--user-unit", String(nextViewport.userUnit));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        renderTask = current.render({ canvas, canvasContext: context, viewport: nextViewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        // A resize can cancel rendering while getTextContent is still pending.
        // Attach a handler immediately; Promise.all below still receives errors.
        const canvasPromise = renderTask.promise;
        void canvasPromise.catch(() => undefined);
        const text = await current.getTextContent();
        if (disposed) return;
        setNoText(!text.items.some(item => "str" in item && item.str.trim()));
        textLayer = new pdfjs.TextLayer({ textContentSource: text, container: textContainer, viewport: nextViewport });
        const textPromise = textLayer.render();
        void textPromise.catch(() => undefined);
        await Promise.all([canvasPromise, textPromise]);
        if (disposed) return;
        const needle = query.trim().toLocaleLowerCase();
        if (needle) for (const span of textContainer.querySelectorAll("span")) {
          if (span.textContent?.toLocaleLowerCase().includes(needle)) span.classList.add(styles.searchHit);
        }
        setRendering(false);
      } catch (reason) {
        if (disposed || (reason instanceof Error && reason.name === "RenderingCancelledException")) return;
        setRendering(false);
        const message = "이 페이지를 표시하지 못했습니다. 다른 페이지로 이동하거나 파일을 다시 열어 주세요.";
        setError(message);
        callbacks.current.onError?.(message);
      }
    })();
    return () => { disposed = true; renderTask?.cancel(); textLayer?.cancel(); };
  }, [pdf, actualPage, scale, width, query]);

  const captureSelection = useCallback(() => {
    const selection = window.getSelection();
    const container = surface.current;
    const currentViewport = viewportRef.current;
    if (!selection || selection.isCollapsed) { selectionKey.current = ""; return; }
    if (!selection.rangeCount || !container || !currentViewport || !paper) return;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;
    const originalText = selection.toString().trim();
    if (!originalText) return;
    if (originalText.length > 24000) {
      callbacks.current.onError?.("한 번에 선택할 수 있는 인용문은 24,000자입니다. 더 짧은 구간을 선택해 주세요.");
      return;
    }
    const key = `${paper.id}:${actualPage}:${originalText}`;
    if (selectionKey.current === key) return;
    const boundary = container.getBoundingClientRect();
    const rects: PdfRect[] = [];
    const seen = new Set<string>();
    for (const rect of Array.from(range.getClientRects())) {
      const left = Math.max(0, rect.left - boundary.left);
      const top = Math.max(0, rect.top - boundary.top);
      const right = Math.min(boundary.width, rect.right - boundary.left);
      const bottom = Math.min(boundary.height, rect.bottom - boundary.top);
      if (right - left < 1 || bottom - top < 1) continue;
      const rectKey = [left, top, right, bottom].map(Math.round).join(":");
      if (seen.has(rectKey)) continue;
      seen.add(rectKey);
      const [a, b] = currentViewport.convertToPdfPoint(left, top);
      const [c, d] = currentViewport.convertToPdfPoint(right, bottom);
      rects.push({ x1: Math.min(a, c), y1: Math.min(b, d), x2: Math.max(a, c), y2: Math.max(b, d) });
    }
    if (!rects.length) return;
    selectionKey.current = key;
    callbacks.current.onSelect({ id: crypto.randomUUID(), paperId: paper.id, paperVersion: paper.contentHash, page: actualPage, text: normalizeQuoteText(originalText), originalText, rects });
  }, [actualPage, paper]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(captureSelection, 300);
    };
    document.addEventListener("selectionchange", handle);
    return () => { document.removeEventListener("selectionchange", handle); if (timer) clearTimeout(timer); };
  }, [captureSelection]);

  useEffect(() => {
    if (!focusQuote || focusQuote.paperId !== paper?.id) return;
    pendingFocus.current = focusQuote;
    if (focusQuote.page !== callbacks.current.page) callbacks.current.onPageChange(focusQuote.page);
  }, [focusQuote, paper?.id]);

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target || target.page !== page || !viewport || rendering) return;
    const rect = target.rects[0];
    if (!rect) return;
    // Let a mobile tab become visible before measuring. Scroll only this PDF
    // container; scrollIntoView would also move the app/document ancestors.
    const frame = requestAnimationFrame(() => {
      const container = scroller.current;
      const pageSurface = surface.current;
      if (!container || !pageSurface || container.clientHeight === 0 || pendingFocus.current !== target) return;
      const [left, top] = viewport.convertToViewportPoint(rect.x1, rect.y1);
      const [right, bottom] = viewport.convertToViewportPoint(rect.x2, rect.y2);
      const containerBounds = container.getBoundingClientRect();
      const pageBounds = pageSurface.getBoundingClientRect();
      const pageTop = pageBounds.top - containerBounds.top + container.scrollTop;
      const pageLeft = pageBounds.left - containerBounds.left + container.scrollLeft;
      const focusLeft = pageLeft + Math.min(left, right);
      const nextLeft = focusLeft < container.scrollLeft || focusLeft > container.scrollLeft + container.clientWidth - 30 ? focusLeft - 20 : container.scrollLeft;
      container.scrollTo({
        top: Math.min(Math.max(0, container.scrollHeight - container.clientHeight), Math.max(0, pageTop + Math.min(top, bottom) - 70)),
        left: Math.min(Math.max(0, container.scrollWidth - container.clientWidth), Math.max(0, nextLeft)),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
      pendingFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusQuote, viewport, page, rendering]);

  const visibleHighlights = highlights.filter(item => item.paperId === paper?.id && item.page === actualPage && (!item.paperVersion || !paper?.contentHash || item.paperVersion === paper.contentHash));
  const overlayQuotes: {quote: Quote; focused:boolean}[] = visibleHighlights.map(quote => ({ quote, focused: false }));
  if (focusQuote && paper && focusQuote.paperId === paper.id && focusQuote.page === actualPage && (!focusQuote.paperVersion || !paper.contentHash || focusQuote.paperVersion === paper.contentHash)) overlayQuotes.push({ quote: focusQuote, focused: true });

  function submitPage() {
    const next = Math.min(pdf?.numPages ?? 1, Math.max(1, Number.parseInt(pageInput, 10) || page));
    setPageInput(String(next));
    callbacks.current.onPageChange(next);
    scroller.current?.scrollTo({ top: 0 });
  }
  function searchMove(direction: number) {
    if (!matches.length) return;
    const index = currentMatch < 0 ? (direction > 0 ? 0 : matches.length - 1) : (currentMatch + direction + matches.length) % matches.length;
    callbacks.current.onPageChange(matches[index]);
    scroller.current?.scrollTo({ top: 0 });
  }

  function handleCitationClick(event: React.MouseEvent<HTMLDivElement>) {
    const selection = window.getSelection();
    if (!selection?.isCollapsed || !callbacks.current.onCitation) return;
    const span = (event.target as HTMLElement).closest(".textLayer span");
    if (!span) return;
    const text = span.textContent ?? "";
    const offset = selection.anchorNode && span.contains(selection.anchorNode) ? selection.anchorOffset : -1;
    const pattern = /\[(\d{1,3})\]|\(([A-Z][^()]{0,70}?,?\s(?:18|19|20)\d{2}[a-z]?)\)/g;
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (text.trim() === match[0] || (offset >= start && offset <= start + match[0].length)) {
        callbacks.current.onCitation(match[1] ?? match[2]);
        break;
      }
    }
  }

  return <section className={styles.viewer} aria-label="논문 PDF 뷰어">
    <div className={styles.toolbar}>
      <div className={styles.pageControls}>
        <button type="button" aria-label="이전 페이지" disabled={!pdf || actualPage <= 1} onClick={() => { callbacks.current.onPageChange(actualPage - 1); scroller.current?.scrollTo({top:0}); }}><ChevronLeft size={18}/></button>
        <form onSubmit={event => { event.preventDefault(); submitPage(); }}><input aria-label="PDF 페이지" inputMode="numeric" value={pageInput} disabled={!pdf} onChange={event => setPageInput(event.target.value.replace(/\D/g, ""))} onBlur={submitPage}/><span>/ {pdf?.numPages ?? "–"}</span></form>
        <button type="button" aria-label="다음 페이지" disabled={!pdf || actualPage >= pdf.numPages} onClick={() => { callbacks.current.onPageChange(actualPage + 1); scroller.current?.scrollTo({top:0}); }}><ChevronRight size={18}/></button>
      </div>
      <div className={styles.zoomControls}>
        <button type="button" aria-label="축소" disabled={!pdf || scale <= .5} onClick={() => callbacks.current.onScaleChange(Math.max(.5, Number((scale - .25).toFixed(2))))}><ZoomOut size={17}/></button>
        <span className={styles.scaleLabel}>{Math.round(scale * 100)}%</span>
        <button type="button" aria-label="확대" disabled={!pdf || scale >= 3} onClick={() => callbacks.current.onScaleChange(Math.min(3, Number((scale + .25).toFixed(2))))}><ZoomIn size={17}/></button>
        <button type="button" aria-label="화면 너비에 맞추기" title="화면 너비에 맞추기" disabled={!pdf} onClick={() => callbacks.current.onScaleChange(1)}><Maximize size={16}/></button>
        <button type="button" aria-label="논문 안에서 검색" aria-expanded={searchOpen} disabled={!pdf} className={searchOpen ? styles.active : ""} onClick={() => { setSearchOpen(!searchOpen); setTimeout(() => searchInput.current?.focus({preventScroll:true}), 0); }}><Search size={18}/></button>
      </div>
    </div>
    {searchOpen && <form className={styles.searchBar} onSubmit={event => { event.preventDefault(); searchMove(1); }}>
      <Search size={16}/><input ref={searchInput} value={query} placeholder="논문 안에서 검색" aria-label="논문 검색어" onChange={event => setQuery(event.target.value)}/>
      <span aria-live="polite">{query ? `${currentMatch >= 0 ? currentMatch + 1 : 0} / ${matches.length}쪽` : ""}</span>
      <button type="button" aria-label="이전 검색 결과" disabled={!matches.length} onClick={() => searchMove(-1)}><ChevronLeft size={16}/></button>
      <button type="submit" aria-label="다음 검색 결과" disabled={!matches.length}><ChevronRight size={16}/></button>
      <button type="button" aria-label="검색 닫기" onClick={() => {setSearchOpen(false);setQuery("");}}><X size={16}/></button>
    </form>}
    <div ref={scroller} className={styles.scroller} onPointerUp={() => setTimeout(captureSelection, 0)} onKeyUp={captureSelection} onClick={handleCitationClick}>
      {loading && <div className={styles.state}><LoaderCircle className={styles.spin} size={28}/><p>논문을 불러오고 있어요</p></div>}
      {error && <div className={styles.error} role="alert">{error}</div>}
      {!blob && !loading && <div className={styles.state}><FileText size={36}/><p>논문을 열어 읽기를 시작하세요</p><span>PDF 문장을 선택하면 바로 질문할 수 있어요.</span></div>}
      {blob && <div ref={surface} className={styles.paper} style={{ width: viewport?.width ?? 1, height: viewport?.height ?? 1, visibility: viewport ? "visible" : "hidden" }}>
        <div ref={renderHost} className={styles.renderHost}/>
        {viewport && <div className={styles.overlays} aria-hidden="true">{overlayQuotes.flatMap(({quote,focused}, quoteIndex) => quote.rects.map((rect, index) => {
          const [x1,y1] = viewport.convertToViewportPoint(rect.x1,rect.y1);
          const [x2,y2] = viewport.convertToViewportPoint(rect.x2,rect.y2);
          return <div key={`${quote.id}-${quoteIndex}-${index}`} className={focused ? styles.focusHighlight : styles.highlight} style={{left:Math.min(x1,x2),top:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1)}}/>;
        }))}</div>}
      </div>}
      {rendering && !loading && <div className={styles.rendering} role="status"><LoaderCircle className={styles.spin} size={14}/> 페이지 표시 중</div>}
      {noText && pdf && !rendering && <p className={styles.scanNotice}>이 페이지에는 선택 가능한 텍스트가 없습니다. 스캔 PDF의 OCR은 아직 지원하지 않습니다.</p>}
    </div>
    {pdf && <div className={styles.footer}><span>문장을 드래그해 질문하거나 스크랩하세요</span><span>PDF {actualPage}페이지</span></div>}
  </section>;
}
