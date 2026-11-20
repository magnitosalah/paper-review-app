"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { BookOpen, Plus, Search, Settings2, PanelLeftClose, PanelLeftOpen, FileText, Upload, Cloud, Check, X, ArrowUp, MessageSquare, Bookmark, Library, Link2, Download, LogIn, LogOut, LoaderCircle, Sparkles, MoreHorizontal, ExternalLink, Quote as QuoteIcon, RotateCcw, CircleHelp, ChevronDown, Laptop, Smartphone, CheckCircle2, AlertCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWorkspace } from "@/hooks/use-workspace";
import { authorizedFetch } from "@/lib/client/api";
import { openDrivePicker, loadDriveFile, reconnectDrive as authorizeDrive, prepareDrivePicker, driveConfigured, driveConnected, generateChatRequestId, googleAuthConfigured, prepareGoogleAuth } from "@/lib/client/drive";
import { extractReferences } from "@/lib/pdf-utils";
import { samplePdf } from "@/lib/sample";
import { exportMarkdown, downloadText } from "@/lib/export";
import type { Paper, Quote, Scrap, Reference, ProviderId, ProviderStatus, Message, Chat } from "@/lib/types";

const PdfViewer = dynamic(() => import("./pdf-viewer").then(m=>m.PdfViewer), {ssr:false,loading:()=> <div className="loading-pane"><LoaderCircle className="spin"/><span>논문 뷰어를 준비하고 있어요</span></div>});
const uid=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const providerNames:Record<ProviderId,string>={gemini:"Gemini",claude:"Claude",codex:"Codex"};
const evidenceLabel:Record<Reference["evidence"],string>={unverified:"문헌 확인 전",metadata:"서지정보만 있음",abstract:"초록 기반",fulltext:"원문 연결됨"};
const fallbackProviders:ProviderStatus[]=[{id:"gemini",name:"Gemini",configured:false,models:[]},{id:"claude",name:"Claude",configured:false,models:[]},{id:"codex",name:"Codex",configured:false,models:[]}];
type Panel = "chat"|"scraps"|"references";
type Candidate={id:string;title:string;authors:string;year?:number;doi?:string;url?:string;abstract?:string;evidence:"metadata"|"abstract"};

export function Workspace(){
  const {state,setState,ready,status,user,cloudReady,signIn,signOut,syncNow,savePdf,loadPdf}=useWorkspace();
  const [activeId,setActiveId]=useState<string|null>(null);
  const [readerOverrideId,setReaderOverrideId]=useState<string|null>(null);
  const [blob,setBlob]=useState<Blob|null>(null);
  const [blobPaperId,setBlobPaperId]=useState<string|null>(null);
  const [loadingPdf,setLoadingPdf]=useState(false);
  const [panel,setPanel]=useState<Panel>("chat");
  const [mobilePane,setMobilePane]=useState<"reader"|"panel">("reader");
  const [sidebar,setSidebar]=useState(true);
  const [settings,setSettings]=useState(false);
  const [librarySearch,setLibrarySearch]=useState("");
  const [toast,setToast]=useState("");
  const [importing,setImporting]=useState(false);
  const [selection,setSelection]=useState<Quote|null>(null);
  const [focusQuote,setFocusQuote]=useState<Quote|null>(null);
  const [activeRef,setActiveRef]=useState<string|null>(null);
  const [providers,setProviders]=useState<ProviderStatus[]>(fallbackProviders);
  const [provider,setProvider]=useState<ProviderId>("gemini");
  const [model,setModel]=useState("");
  const [carryHistory,setCarryHistory]=useState(true);
  const [running,setRunning]=useState(false);
  const [refQuery,setRefQuery]=useState("");
  const [refSearch,setRefSearch]=useState(false);
  const [candidates,setCandidates]=useState<Candidate[]>([]);
  const [matchingRef,setMatchingRef]=useState<Reference|null>(null);
  const fileInput=useRef<HTMLInputElement>(null);
  const attachmentInput=useRef<HTMLInputElement>(null);
  const composer=useRef<HTMLTextAreaElement>(null);
  const scrollEnd=useRef<HTMLDivElement>(null);
  const abort=useRef<AbortController|null>(null);
  const restoredScope=useRef<string|null>(null);
  const accountScope=useRef<string|null>(null);
  const settledRequests=useRef(new Set<string>());
  const pendingFocusQuote=useRef<Quote|null>(null);
  const searchSequence=useRef(0);
  const candidateScope=useRef<{account:string;activePaperId:string;ownerPaperId:string;sequence:number}|null>(null);
  const liveScope=useRef(user?.id||"local");
  liveScope.current=user?.id||"local";
  const liveActiveId=useRef(activeId);
  liveActiveId.current=activeId;
  const activePaper=state.papers.find(p=>p.id===activeId)||null;
  const readerPaper=state.papers.find(p=>p.id===(readerOverrideId||activeId))||null;
  const liveReaderId=useRef(readerPaper?.id);
  liveReaderId.current=readerPaper?.id;
  const currentRef=state.references.find(r=>r.id===activeRef)||null;
  const currentChat=state.chats.find(c=>c.paperId===activeId&&(c.referenceId||null)===activeRef)||null;
  const messages=useMemo(()=>state.messages.filter(m=>m.chatId===currentChat?.id),[state.messages,currentChat?.id]);
  const scraps=state.scraps.filter(s=>s.paperId===readerPaper?.id);
  const references=state.references.filter(r=>r.paperId===activeId);
  const selectedProvider=providers.find(p=>p.id===provider);
  const reading=state.readingPositions[readerPaper?.id||""]||{page:1,scale:1,updatedAt:now()};
  const draft=state.drafts[currentChat?.id||""]||"";
  const quote=state.draftQuotes?.[currentChat?.id||""]||null;
  const setQuote=(value:Quote|null)=>{if(currentChat)setState(s=>({...s,draftQuotes:{...s.draftQuotes,[currentChat.id]:value}}));};

  useEffect(()=>{if(toast){const t=setTimeout(()=>setToast(""),6500);return()=>clearTimeout(t);}},[toast]);
  useEffect(()=>{const media=window.matchMedia("(max-width:950px)");const closeOnMobile=()=>{if(media.matches)setSidebar(false);};closeOnMobile();media.addEventListener("change",closeOnMobile);if(googleAuthConfigured())void prepareGoogleAuth().catch(()=>{});if(driveConfigured())void prepareDrivePicker().catch(()=>{});return()=>media.removeEventListener("change",closeOnMobile);},[]);
  useEffect(()=>{const scope=user?.id||"local";if(accountScope.current===scope)return;accountScope.current=scope;settledRequests.current.clear();abort.current?.abort();setRunning(false);setActiveId(null);setReaderOverrideId(null);setActiveRef(null);setBlob(null);setSelection(null);setFocusQuote(null);pendingFocusQuote.current=null;searchSequence.current+=1;candidateScope.current=null;setCandidates([]);setMatchingRef(null);setRefSearch(false);setImporting(false);},[user?.id]);
  useEffect(()=>{const scope=user?.id||"local";if(ready&&restoredScope.current!==scope){restoredScope.current=scope;const saved=localStorage.getItem(`paperdesk-active:${scope}`);if(state.papers.some(p=>p.id===saved))setActiveId(saved);}},[ready,user?.id,state.papers]);
  useEffect(()=>{if(activeId)localStorage.setItem(`paperdesk-active:${user?.id||"local"}`,activeId);},[activeId,user?.id]);
  useEffect(()=>{authorizedFetch("/api/providers").then(r=>r.json()).then(data=>{if(Array.isArray(data.providers))setProviders(data.providers);}).catch(()=>{});},[user?.id,settings]);
  useEffect(()=>{setModel(previous=>selectedProvider?.models.some(m=>m.id===previous)?previous:selectedProvider?.models[0]?.id||"");},[provider,selectedProvider?.models]);
  useEffect(()=>{const box=scrollEnd.current?.parentElement;if(box&&messages.length)box.scrollTo({top:box.scrollHeight,behavior:"smooth"});},[messages.length,messages.at(-1)?.content,panel]);
  useEffect(()=>{const listener=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key==="o"){e.preventDefault();fileInput.current?.click();}if(e.key==="Escape"){setSettings(false);setSelection(null);}};window.addEventListener("keydown",listener);return()=>window.removeEventListener("keydown",listener);},[]);
  useEffect(()=>{if(!activeId)return;setState(s=>s.chats.some(c=>c.paperId===activeId&&!c.referenceId)?s:{...s,chats:[...s.chats,{id:uid(),paperId:activeId,title:"본문 대화",createdAt:now()}]});},[activeId,setState]);
  useEffect(()=>{
    let cancelled=false;const scope=liveScope.current;
    setBlob(null);setBlobPaperId(null);setSelection(null);setFocusQuote(null);
    if(!readerPaper){setLoadingPdf(false);return;}
    setLoadingPdf(true);
    loadPdf(readerPaper).then(file=>{
      if(cancelled||liveScope.current!==scope)return;
      setBlob(file||(readerPaper.source==="sample"?samplePdf():null));
      setBlobPaperId(readerPaper.id);
      if(pendingFocusQuote.current?.paperId===readerPaper.id){setFocusQuote(pendingFocusQuote.current);pendingFocusQuote.current=null;}
    }).catch(e=>{if(!cancelled&&liveScope.current===scope)setToast(e.message||"PDF를 불러오지 못했어요.");}).finally(()=>{if(!cancelled&&liveScope.current===scope)setLoadingPdf(false);});
    return()=>{cancelled=true;};
  },[readerPaper?.id,readerPaper?.storagePath,readerPaper?.driveFileId,readerPaper?.contentHash,loadPdf]);
  const recoverableRequests=JSON.stringify(state.messages.filter(m=>m.role==="assistant"&&m.requestId&&m.status!=="complete").map(m=>({id:m.id,requestId:m.requestId,createdAt:m.createdAt})));
  useEffect(()=>{
    if(!ready||running||!user||recoverableRequests==="[]")return;
    const scope=liveScope.current;
    const requests=JSON.parse(recoverableRequests) as {id:string;requestId:string;createdAt:string}[];
    const controller=new AbortController();
    let alive=true;let checking=false;
    const current=()=>alive&&liveScope.current===scope;
    const recover=async()=>{
      if(checking||!current()||!driveConnected())return;
      checking=true;
      try{
        for(const {id,requestId,createdAt} of requests){
          if(!current()||!driveConnected())return;
          if(settledRequests.current.has(requestId))continue;
          const response=await authorizedFetch(`/api/chat?requestId=${encodeURIComponent(requestId)}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
          if(!current())return;
          if(response.status===404){
            // A new request may not have reached Drive yet. Confirm absence after a grace period.
            if(Date.now()-Date.parse(createdAt)>=60000){
              settledRequests.current.add(requestId);
              setState(s=>({...s,messages:s.messages.map(m=>m.id===id&&m.requestId===requestId&&m.status!=="complete"?{...m,status:"failed",error:"저장된 요청을 찾지 못했어요. 질문은 자동으로 다시 전송하지 않습니다."}:m)}));
            }
            continue;
          }
          // Authentication and temporary service failures remain eligible after reconnection.
          if(response.status===401||response.status===503)return;
          if(!response.ok)continue;
          const result=await response.json();
          if(!current())return;
          if(!["complete","failed","interrupted"].includes(result.status))continue;
          settledRequests.current.add(requestId);
          setState(s=>({...s,messages:s.messages.map(m=>m.id===id&&m.requestId===requestId&&(m.status!=="complete"||result.status==="complete")?{...m,content:typeof result.answer==="string"&&result.answer?result.answer:m.content,status:result.status,error:result.status==="complete"?undefined:typeof result.error==="string"?result.error:undefined}:m)}));
        }
      }catch{/* Keep unresolved requests available after a timeout, offline period, or reconnect. */}
      finally{checking=false;}
    };
    void recover();const timer=setInterval(()=>void recover(),8000);
    return()=>{alive=false;controller.abort();clearInterval(timer);};
  },[ready,running,recoverableRequests,user?.id,setState,loadPdf]);

  const notifyError=(e:unknown)=>setToast(e instanceof Error?e.message:"작업을 완료하지 못했어요. 다시 시도해 주세요.");
  const updateDraft=(value:string)=>{if(currentChat)setState(s=>({...s,drafts:{...s.drafts,[currentChat.id]:value}}));};
  const openPaper=(paper:Paper)=>{searchSequence.current+=1;candidateScope.current=null;setActiveId(paper.id);setReaderOverrideId(null);setActiveRef(null);setSelection(null);setFocusQuote(null);pendingFocusQuote.current=null;setMobilePane("reader");setMatchingRef(null);setCandidates([]);setRefSearch(false);if(window.innerWidth<=950)setSidebar(false);};
  const navigateQuote=(q:Quote)=>{
    if(!state.papers.some(p=>p.id===q.paperId)){setToast("인용문의 원본 논문을 먼저 연결해 주세요.");return;}
    if(q.paperId!==readerPaper?.id){pendingFocusQuote.current={...q};setReaderOverrideId(q.paperId===activeId?null:q.paperId);}
    else setFocusQuote({...q});
    setState(s=>({...s,readingPositions:{...s.readingPositions,[q.paperId]:{...(s.readingPositions[q.paperId]||{scale:1}),page:q.page,updatedAt:now()}}}));setMobilePane("reader");
  };
  const returnToMainPaper=()=>{setReaderOverrideId(null);setSelection(null);setFocusQuote(null);pendingFocusQuote.current=null;setMobilePane("reader");};
  const openLinkedReference=(ref:Reference)=>{
    const linked=state.papers.find(p=>p.id===ref.linkedPaperId);
    if(!linked){attachmentInput.current?.click();return;}
    setReaderOverrideId(linked.id===activeId?null:linked.id);setSelection(null);setFocusQuote(null);pendingFocusQuote.current=null;setMobilePane("reader");
  };
  const addScrap=(q:Quote)=>{if(state.scraps.some(s=>s.paperId===q.paperId&&s.page===q.page&&s.originalText===q.originalText)){setToast("이미 보관한 문장이에요.");return;}const scrap:Scrap={...q,id:uid(),note:"",createdAt:now(),updatedAt:now()};setState(s=>({...s,scraps:[scrap,...s.scraps]}));setSelection(null);setToast("스크랩에 문장을 보관했어요.");};
  const attachQuote=(q:Quote)=>{setQuote(q);setSelection(null);setPanel("chat");setMobilePane("panel");setTimeout(()=>composer.current?.focus({preventScroll:true}),50);};

  async function importPdf(file:Blob,name:string,source:Paper["source"]="local",drive?:{id:string;modifiedTime?:string},linkReference?:Reference|null){
    const scope=liveScope.current;const originActiveId=liveActiveId.current;
    setImporting(true);
    try{
      if(file.size>50*1024*1024)throw new Error("첫 버전에서는 50MB 이하의 PDF를 열 수 있어요.");
      const bytes=await file.arrayBuffer();if(!new TextDecoder().decode(bytes.slice(0,1024)).includes("%PDF-"))throw new Error("PDF 형식의 파일을 선택해 주세요.");
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(b=>b.toString(16).padStart(2,"0")).join("");
      if(liveScope.current!==scope)return;
      let paper=state.papers.find(p=>p.contentHash===hash);
      if(!paper){
        const id=uid();const stored=await savePdf(id,file,{localOnly:source==="drive"||source==="sample",filename:name});
        if(liveScope.current!==scope)return;
        paper={id,title:name.replace(/\.pdf$/i,""),filename:name,source,contentHash:hash,createdAt:now(),updatedAt:now(),...stored,...(drive?{driveFileId:drive.id,driveModifiedTime:drive.modifiedTime}:{})};
        const added=paper;setState(s=>({...s,papers:[added,...s.papers]}));
      }else{
        const stored=await savePdf(paper.id,file,{localOnly:source==="drive"||source==="sample",filename:name});
        if(liveScope.current!==scope)return;
        paper={...paper,...stored,updatedAt:now()};
        const refreshed=paper;setState(s=>({...s,papers:s.papers.map(p=>p.id===refreshed.id?refreshed:p)}));
      }
      if(linkReference){
        const linked=paper;setState(s=>({...s,references:s.references.map(r=>r.id===linkReference.id?{...r,linkedPaperId:linked.id,evidence:r.abstract?"abstract":r.evidence==="unverified"?"unverified":"metadata"}:r)}));
        if(liveActiveId.current===originActiveId){setReaderOverrideId(linked.id===activeId?null:linked.id);setActiveRef(linkReference.id);setSelection(null);setFocusQuote(null);setMobilePane("reader");setBlob(file);setBlobPaperId(linked.id);setToast("참고문헌 원문을 연결했어요. 문장을 선택하면 이 참고문헌 대화에 첨부됩니다.");}
      }else if(liveActiveId.current===originActiveId){openPaper(paper);setBlob(file);setBlobPaperId(paper.id);}
      else setToast("가져온 논문을 서재에 보관했어요.");
    }catch(e){if(liveScope.current===scope)notifyError(e);}finally{if(liveScope.current===scope)setImporting(false);}
  }
  async function importDrive(linkReference?:Reference){const scope=liveScope.current;setImporting(true);try{const file=await openDrivePicker();if(liveScope.current===scope)await importPdf(file.blob,file.name,"drive",file,linkReference);}catch(e){if(liveScope.current===scope)notifyError(e);}finally{if(liveScope.current===scope)setImporting(false);}}
  async function reconnectDrive(){
    if(!readerPaper?.driveFileId)return;const target=readerPaper;const scope=liveScope.current;
    setLoadingPdf(true);
    try{
      await authorizeDrive();if(liveScope.current!==scope)return;
      const file=await loadDriveFile(target.driveFileId!);if(liveScope.current!==scope||liveReaderId.current!==target.id)return;
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))).map(b=>b.toString(16).padStart(2,"0")).join("");
      if(liveScope.current!==scope||liveReaderId.current!==target.id)return;
      if(target.contentHash&&target.contentHash!==hash){
        await importPdf(file,target.filename,"drive",{id:target.driveFileId!},currentRef?.linkedPaperId===target.id?currentRef:null);
        if(liveScope.current===scope)setToast("Drive 원본이 바뀌었어요. 새 문서로 가져왔으며 이전 스크랩은 기존 버전에 남습니다.");return;
      }
      await savePdf(target.id,file,{localOnly:true});if(liveScope.current===scope&&liveReaderId.current===target.id){setBlob(file);setBlobPaperId(target.id);}
    }catch(e){if(liveScope.current===scope)notifyError(e);}finally{if(liveScope.current===scope&&liveReaderId.current===target.id)setLoadingPdf(false);}
  }
  const documentLoaded=useCallback(({pageCount,textByPage}:{pageCount:number;textByPage:string[]})=>{
    const readerId=readerPaper?.id;if(!readerId||liveReaderId.current!==readerId)return;
    const found=extractReferences(textByPage);
    const normalize=(value:string)=>value.replace(/\s+/g," ").trim().toLocaleLowerCase();
    const hasText=textByPage.some(text=>text.trim().length>0);
    setState(s=>{
      const existing=s.references.filter(r=>r.paperId===readerId);
      const missing=found.slice(0,150).filter(r=>!existing.some(e=>normalize(e.citation)===normalize(r.citation)||(/^\d+$/.test(r.label)&&e.label.replace(/[\[\]]/g,"")===r.label)));
      const refs=s.references.map(r=>hasText&&r.linkedPaperId===readerId&&r.evidence!=="fulltext"?{...r,evidence:"fulltext" as const}:r);
      return {...s,papers:s.papers.map(p=>p.id===readerId&&p.pageCount!==pageCount?{...p,pageCount,updatedAt:now()}:p),references:[...refs,...missing.map(r=>({id:uid(),paperId:readerId,label:r.label,citation:r.citation,title:r.citation,authors:"",evidence:"unverified" as const,createdAt:now()}))]};
    });
  },[readerPaper?.id,setState]);
  function openReference(ref:Reference){if(ref.paperId!==activeId)setActiveId(ref.paperId);setReaderOverrideId(null);setSelection(null);setActiveRef(ref.id);setPanel("chat");setMobilePane("panel");setState(s=>{const existing=s.chats.find(c=>c.referenceId===ref.id);const chat=existing||{id:uid(),paperId:ref.paperId,referenceId:ref.id,title:ref.title,createdAt:now()};return {...s,chats:existing?s.chats:[...s.chats,chat],draftQuotes:{...s.draftQuotes,[chat.id]:s.draftQuotes?.[chat.id]===undefined?(ref.contextQuote||null):s.draftQuotes[chat.id]}};});}
  async function findReferences(query=refQuery,ref:Reference|null=matchingRef){
    if(!query.trim()||!activeId)return;
    const request={account:liveScope.current,activePaperId:activeId,ownerPaperId:ref?.paperId||activeId,sequence:++searchSequence.current};
    const current=()=>liveScope.current===request.account&&liveActiveId.current===request.activePaperId&&searchSequence.current===request.sequence;
    candidateScope.current=request;setRefSearch(true);setMatchingRef(ref);setPanel("references");setMobilePane("panel");setCandidates([]);
    try{const r=await authorizedFetch(`/api/references?q=${encodeURIComponent(query.slice(0,500))}`);const data=await r.json();if(!current())return;if(!r.ok)throw new Error(data.error||"참고문헌을 찾지 못했어요.");setCandidates(data.results||[]);if(!data.results?.length)setToast("일치하는 문헌이 없어요. 제목이나 DOI를 바꿔 검색해 보세요.");}catch(e){if(current())notifyError(e);}finally{if(current())setRefSearch(false);}
  }
  function chooseCandidate(candidate:Candidate){const scope=candidateScope.current;if(!scope||scope.account!==liveScope.current||scope.activePaperId!==activeId||scope.sequence!==searchSequence.current)return;const reference:Reference={...matchingRef,...candidate,id:matchingRef?.id||uid(),paperId:scope.ownerPaperId,label:matchingRef?.label||"추가 문헌",citation:matchingRef?.citation||`${candidate.authors}. ${candidate.title}. ${candidate.year||""}`,createdAt:matchingRef?.createdAt||now(),contextQuote:matchingRef?.contextQuote||selection||undefined,evidence:matchingRef?.evidence==="fulltext"?"fulltext":candidate.evidence};setState(s=>({...s,references:s.references.some(r=>r.id===reference.id)?s.references.map(r=>r.id===reference.id?reference:r):[...s.references,reference]}));setCandidates([]);candidateScope.current=null;openReference(reference);}
  async function sendQuestion(){
    if(!currentChat||!draft.trim()||running)return;
    if(!selectedProvider?.configured||!model){setSettings(true);setToast("사용할 AI 연결을 먼저 설정해 주세요.");return;}
    if(currentRef?.evidence==="fulltext"&&!quote&&!currentRef.abstract&&!(carryHistory&&messages.some(m=>m.status==="complete"&&m.quote))){setToast("연결한 원문에서 질문할 구간을 선택하거나 초록을 첨부해 주세요.");return;}
    if(!user){setSettings(true);setToast("Google Drive에 연결하면 질문과 답변을 저장하며 AI를 사용할 수 있어요.");return;}
    const requestScope=liveScope.current;const chat=currentChat;
    setRunning(true);let requestId:string;try{requestId=await generateChatRequestId();}catch(e){if(liveScope.current===requestScope){setRunning(false);notifyError(e);}return;}if(liveScope.current!==requestScope)return;
    const q=quote?{...quote}:undefined;const content=draft.trim();const assistantId=uid();const timestamp=now();
    const userMessage:Message={id:uid(),chatId:chat.id,role:"user",content,provider,model,quote:q,createdAt:timestamp,status:"complete",requestId};
    const assistant:Message={id:assistantId,chatId:chat.id,role:"assistant",content:"",provider,model,createdAt:timestamp,status:"pending",requestId};
    const history=carryHistory?messages.filter(m=>m.status==="complete").slice(-20).map(m=>({role:m.role,content:m.quote?`${m.content}\n\n첨부 인용 (PDF ${m.quote.page}페이지): ${m.quote.text}`:m.content})):[];
    setState(s=>({...s,messages:[...s.messages,userMessage,assistant],drafts:{...s.drafts,[chat.id]:""},draftQuotes:{...s.draftQuotes,[chat.id]:null},scraps:q&&!s.scraps.some(v=>v.paperId===q.paperId&&v.page===q.page&&v.originalText===q.originalText)?[{...q,id:uid(),note:"",createdAt:timestamp,updatedAt:timestamp},...s.scraps]:s.scraps}));
    setRunning(true);abort.current=new AbortController();
    let complete=false;let accumulated="";
    const patch=(fields:Partial<Message>)=>{if(liveScope.current===requestScope)setState(s=>({...s,messages:s.messages.map(m=>m.id===assistantId?{...m,...fields}:m)}));};
    try{
      const response=await authorizedFetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId,provider,model,messages:[...history,{role:"user",content}],quote:q,reference:currentRef||undefined,paperTitle:currentRef?.title||activePaper?.title}),signal:abort.current.signal});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||`요청에 실패했어요 (${response.status}).`);}
      if(!response.body)throw new Error("응답을 읽을 수 없어요.");
      const reader=response.body.getReader();const decoder=new TextDecoder();let buffer="";
      const consume=(line:string)=>{if(!line.trim())return;const event=JSON.parse(line);if(event.type==="delta"){accumulated+=event.text;patch({content:accumulated,status:"streaming"});}else if(event.type==="done"){complete=true;patch({status:"complete"});}else if(event.type==="error")throw new Error(event.message||"답변이 중단되었어요.");};
      while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop()||"";for(const line of lines)consume(line);}buffer+=decoder.decode();if(buffer.trim())consume(buffer);if(!complete)patch({status:"interrupted",error:"연결이 끝났어요. 저장된 부분 답변을 확인해 주세요."});
    }catch(e){if(liveScope.current!==requestScope)return;const stopped=e instanceof Error&&e.name==="AbortError";const error=stopped?"답변 생성을 중지했어요.":e instanceof Error?e.message:"답변을 받지 못했어요.";patch({status:stopped?"interrupted":"failed",error});if(!stopped){setToast(error);setState(s=>({...s,drafts:{...s.drafts,[chat.id]:s.drafts[chat.id]||content},draftQuotes:{...s.draftQuotes,[chat.id]:s.drafts[chat.id]?s.draftQuotes?.[chat.id]||null:q||null}}));}}finally{if(liveScope.current===requestScope){setRunning(false);abort.current=null;}}
  }

  const filteredPapers=state.papers.filter(p=>p.title.toLowerCase().includes(librarySearch.toLowerCase()));
  return <div className={`app-shell ${sidebar?"":"sidebar-collapsed"} mobile-${mobilePane}`}>
    <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void importPdf(f,f.name);e.target.value="";}}/>
    <input ref={attachmentInput} type="file" accept="application/pdf,.pdf" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void importPdf(f,f.name,"local",undefined,currentRef);e.target.value="";}}/>
    {sidebar&&<button className="sidebar-scrim" aria-label="서재 닫기" onClick={()=>setSidebar(false)}/>}
    <aside className="sidebar">
      <button className="icon-button mobile-sidebar-close" aria-label="서재 메뉴 닫기" onClick={()=>setSidebar(false)}><X size={18}/></button>
      <a className="brand" href="/" aria-label="Paperdesk 홈"><span className="brand-mark"><BookOpen size={21}/></span><span>paperdesk<span className="brand-dot">.</span></span></a>
      <button className="button primary new-paper" onClick={()=>fileInput.current?.click()} disabled={importing}><Plus size={18}/>논문 가져오기</button>
      <div className="sidebar-nav"><button className="nav-item active" onClick={()=>{searchSequence.current+=1;candidateScope.current=null;setActiveId(null);setReaderOverrideId(null);setActiveRef(null);setCandidates([]);setMatchingRef(null);setRefSearch(false);setSidebar(true);}}><Library size={18}/>내 서재 <span>{state.papers.length}</span></button><button className="nav-item" onClick={()=>{setPanel("scraps");setMobilePane("panel");}}><Bookmark size={18}/>모아둔 문장 <span>{state.scraps.length}</span></button></div>
      <div className="sidebar-section-label">내 논문 <button className="icon-button" aria-label="논문 추가" onClick={()=>fileInput.current?.click()}><Plus size={15}/></button></div>
      <label className="sidebar-search"><Search size={15}/><input aria-label="서재 검색" placeholder="제목으로 찾기" value={librarySearch} onChange={e=>setLibrarySearch(e.target.value)}/></label>
      <div className="paper-list">{filteredPapers.map(p=><button key={p.id} className={`paper-item ${p.id===activeId?"selected":""}`} onClick={()=>openPaper(p)}><FileText size={18}/><span className="paper-item-text"><strong>{p.title}</strong><small>{p.source==="drive"?"Google Drive":p.source==="sample"?"사용 가이드":"PDF 문서"}{p.pageCount?` · ${p.pageCount}페이지`:""}</small></span></button>)}{!state.papers.length&&<p className="sidebar-hint">궁금한 논문을 가져와<br/>나만의 서재를 채워 보세요.</p>}</div>
      <div className="sidebar-bottom"><button className="drive-button" onClick={()=>void importDrive()} disabled={importing}><DriveIcon/><span>Google Drive에서 열기</span><Plus size={16}/></button><button className="account-button" onClick={()=>setSettings(true)}><span className="avatar">{user?.email?.charAt(0).toUpperCase()||"P"}</span><span><strong>{user?.email?.split("@")[0]||"나의 읽기 공간"}</strong><small>{user?"클라우드 계정":"이 브라우저에 저장"}</small></span><Settings2 size={17}/></button></div>
    </aside>
    <main className="main-workspace">
      <header className="workspace-header"><div className="header-title"><button className="icon-button sidebar-toggle" onClick={()=>setSidebar(s=>!s)} aria-label="서재 패널 전환">{sidebar?<PanelLeftClose size={19}/>:<PanelLeftOpen size={19}/>}</button><span className="breadcrumb">내 서재</span><span className="breadcrumb-slash">/</span><h1>{activePaper?.title||"읽고, 묻고, 연결하는 공간"}</h1>{activePaper?.source==="sample"&&<span className="tag">사용 가이드</span>}</div><div className="header-actions"><button className="sync-indicator" title="동기화 상태 확인" onClick={()=>user?void syncNow().catch(notifyError):setSettings(true)}>{status.includes("완료")?<CheckCircle2 size={14}/>:<Cloud size={14}/>}<span>{status}</span></button>{activePaper&&<button className="icon-button" title="Markdown 내보내기" aria-label="Markdown 내보내기" onClick={()=>downloadText(exportMarkdown(state,activePaper),`${activePaper.title.replace(/[\\/:*?"<>|]/g,"_")}.md`)}><Download size={18}/></button>}<button className="icon-button" aria-label="연결 설정" onClick={()=>setSettings(true)}><Settings2 size={18}/></button></div></header>
      {!ready?<div className="loading-pane"><LoaderCircle className="spin"/>서재를 열고 있어요</div>:!activePaper?<section className="welcome" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)void importPdf(f,f.name);}}><div className="welcome-eyebrow"><span/>YOUR READING SPACE</div><h2>읽는 순간,<br/><span>이해로 이어지도록.</span></h2><p>논문 옆에 질문을 두세요.<br/>문장 하나에서 시작한 생각이 더 깊은 이해가 됩니다.</p><div className="welcome-actions"><button className="button primary" onClick={()=>fileInput.current?.click()}><Upload size={18}/>내 기기에서 PDF 열기</button><button className="button secondary" onClick={()=>void importDrive()}><DriveIcon/>Drive에서 열기</button></div><span className="drop-hint">PDF 파일을 여기에 놓아도 좋아요 · 최대 50MB</span><div className="welcome-cards"><div><QuoteIcon size={22}/><h3>문장에서 시작하는 질문</h3><p>읽다가 궁금한 문장을 선택하면<br/>출처와 함께 질문에 첨부돼요.</p></div><div><MessageSquare size={22}/><h3>나에게 맞는 AI와 함께</h3><p>Gemini, Claude, Codex를 골라<br/>내 방식대로 이해해 보세요.</p></div><div><Link2 size={22}/><h3>참고문헌까지 이어 읽기</h3><p>인용된 연구를 찾아 별도 대화로<br/>생각의 연결을 따라가세요.</p></div></div><button className="sample-link" onClick={()=>void importPdf(samplePdf(),"Paperdesk 읽기 가이드.pdf","sample")}><BookOpen size={17}/>먼저 사용 가이드로 둘러보기</button><div className="welcome-footer"><Laptop size={15}/><Smartphone size={14}/><span>PC에서도, 폰에서도. 로그인하면 같은 서재로 이어져요.</span></div></section>:<div className="reading-layout">
        <section className="reader-pane" aria-label="논문 읽기" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)void importPdf(f,f.name);}}>
          {readerOverrideId&&readerPaper&&<div className="reader-context-bar"><span><Link2 size={14}/>참고문헌 원문 · {readerPaper.title}</span><button onClick={returnToMainPaper}><RotateCcw size={14}/>원 논문으로 돌아가기</button></div>}
          {loadingPdf?<div className="loading-pane"><LoaderCircle className="spin"/>PDF를 불러오고 있어요</div>:blob&&blobPaperId===readerPaper?.id?<PdfViewer key={readerPaper?.id} blob={blob} paper={readerPaper} page={reading.page} scale={reading.scale} highlights={scraps} focusQuote={focusQuote} onPageChange={page=>setState(s=>({...s,readingPositions:{...s.readingPositions,[readerPaper!.id]:{...reading,page,updatedAt:now()}}}))} onScaleChange={scale=>setState(s=>({...s,readingPositions:{...s.readingPositions,[readerPaper!.id]:{...reading,scale,updatedAt:now()}}}))} onSelect={setSelection} onDocumentLoad={documentLoaded} onError={setToast} onCitation={label=>{setPanel("references");setMobilePane("panel");const ref=state.references.filter(r=>r.paperId===readerPaper?.id).find(r=>r.label.replace(/[\[\]]/g,"")===label.replace(/[\[\]]/g,""));if(ref){setMatchingRef(ref);setRefQuery(ref.citation);}else setRefQuery(label);}}/>:<div className="empty-state"><FileText size={34}/><h3>원본 PDF를 연결해 주세요</h3><p>보관한 스크랩과 대화는 그대로 남아 있어요.</p><button className="button primary" onClick={()=>readerPaper?.driveFileId?void reconnectDrive():readerOverrideId&&currentRef?.linkedPaperId===readerPaper?.id?attachmentInput.current?.click():fileInput.current?.click()}>{readerPaper?.driveFileId?"Drive에서 다시 열기":"PDF 다시 선택"}</button></div>}
          {selection&&<div className="selection-toolbar"><span><QuoteIcon size={15}/>{selection.text.length}자 선택</span><button onClick={()=>attachQuote(selection)}><MessageSquare size={15}/>질문하기</button><button onClick={()=>addScrap(selection)}><Bookmark size={15}/>스크랩</button><button className="icon-button" aria-label="선택 닫기" onClick={()=>setSelection(null)}><X size={15}/></button></div>}
        </section>
        <aside className="context-panel"><div className="panel-tabs"><button className={panel==="chat"?"active":""} onClick={()=>setPanel("chat")}><MessageSquare size={16}/>질문</button><button className={panel==="scraps"?"active":""} onClick={()=>setPanel("scraps")}><Bookmark size={16}/>스크랩 <small>{scraps.length}</small></button><button className={panel==="references"?"active":""} onClick={()=>setPanel("references")}><Link2 size={16}/>참고문헌</button></div>
          {panel==="chat"?<><div className="conversation-toolbar"><select aria-label="대화 선택" value={activeRef||"main"} onChange={e=>{setActiveRef(e.target.value==="main"?null:e.target.value);setReaderOverrideId(null);setSelection(null);}}><option value="main">본문 대화</option>{references.filter(r=>state.chats.some(c=>c.referenceId===r.id)).map(r=><option value={r.id} key={r.id}>{r.label} · {r.title.slice(0,35)}</option>)}</select><button className="icon-button" title="대화의 Markdown 내보내기" aria-label="대화 내보내기" onClick={()=>downloadText(exportMarkdown(state,activePaper),"paperdesk-notes.md")}><MoreHorizontal size={18}/></button></div>{currentRef&&<div className="reference-context"><div><span className="tag">{evidenceLabel[currentRef.evidence]}</span>{currentRef.url&&<a href={currentRef.url} target="_blank" rel="noreferrer" aria-label="참고문헌 출처 열기"><ExternalLink size={14}/></a>}</div><strong>{currentRef.title}</strong><small>{currentRef.authors}{currentRef.year?` · ${currentRef.year}`:""}</small><button onClick={()=>currentRef.linkedPaperId?openLinkedReference(currentRef):attachmentInput.current?.click()}>{currentRef.linkedPaperId?"연결한 원문 읽기":"원문 PDF 연결"}</button>{!currentRef.linkedPaperId&&<button onClick={()=>void importDrive(currentRef)}>Drive에서 원문 연결</button>}</div>}
            <div className="message-list">{messages.length===0?<div className="chat-welcome"><div className="assistant-emblem"><Sparkles size={25}/></div><span className="eyebrow">THINK ALONGSIDE YOUR PAPER</span><h2>{currentRef?"인용 너머의 이야기를\n함께 살펴볼까요?":"궁금한 문장에서\n시작해 보세요."}</h2><p>{currentRef?"확보한 자료를 바탕으로 질문할 수 있어요. 원문을 연결하면 더 구체적으로 살펴볼 수 있습니다.":"논문에서 문장을 선택하거나,\n읽으며 떠오른 질문을 자유롭게 남겨 보세요."}</p><div className="suggested-questions">{["이 문장을 쉽게 설명해 줘","핵심 개념을 예시로 설명해 줘","이 주장에는 어떤 가정이 있어?"].map((q,i)=><button key={q} onClick={()=>{updateDraft(q);composer.current?.focus();}}><span>{i===0?<CircleHelp size={16}/>:i===1?<BookOpen size={16}/>:<Search size={16}/>}</span>{q}<Plus size={14}/></button>)}</div><small className="evidence-note"><Link2 size={13}/>질문에 첨부한 자료를 근거로 답변합니다</small></div>:messages.map(m=><article className={`message ${m.role}`} key={m.id}><div className="message-label">{m.role==="assistant"?<><span className="mini-spark"><Sparkles size={13}/></span>{providerNames[m.provider]}<small>{m.model}</small></>:<><span className="avatar tiny">나</span>나의 질문</>}</div>{m.quote&&<button className="message-quote" onClick={()=>navigateQuote(m.quote!)}><small>PDF {m.quote.page}페이지 <ExternalLink size={12}/></small><span>{m.quote.text}</span></button>}<div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>{!m.content&&(m.status==="pending"||m.status==="streaming")&&<span className="thinking"><span/><span/><span/></span>}</div>{m.error&&<div className="message-error"><AlertCircle size={14}/><span>{m.error}</span></div>}</article>)}<div ref={scrollEnd}/></div>
            <div className="composer-area">{quote&&<div className="quote-attachment"><div><span><QuoteIcon size={14}/>첨부 문장 · PDF {quote.page}페이지</span><button className="icon-button" aria-label="첨부 제거" onClick={()=>setQuote(null)}><X size={14}/></button></div><textarea aria-label="첨부 인용문 교정" disabled={running} value={quote.text} onChange={e=>setQuote({...quote,text:e.target.value})}/></div>}<div className="composer-box"><textarea ref={composer} aria-label="논문에 질문하기" disabled={running} placeholder={quote?"이 문장에 대해 무엇이 궁금한가요?":"논문에 대해 질문해 보세요…"} value={draft} maxLength={12000} onChange={e=>updateDraft(e.target.value)} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter"&&!e.nativeEvent.isComposing){e.preventDefault();void sendQuestion();}}}/><div className="composer-bottom"><div className="provider-select"><Sparkles size={14}/><select aria-label="AI 서비스 선택" value={provider} onChange={e=>setProvider(e.target.value as ProviderId)}>{providers.map(p=><option key={p.id} value={p.id}>{p.name}{!p.configured?" · 연결 필요":""}</option>)}</select></div>{running?<button className="send-button stop" aria-label="답변 생성 중지" onClick={()=>abort.current?.abort()}><span/></button>:<button className="send-button" aria-label="질문 전송" disabled={!draft.trim()||!currentChat} onClick={()=>void sendQuestion()}><ArrowUp size={19}/></button>}</div></div><div className="model-settings"><select aria-label="AI 모델 선택" value={model} onChange={e=>setModel(e.target.value)} disabled={!selectedProvider?.models.length}>{selectedProvider?.models.length?selectedProvider.models.map(m=><option value={m.id} key={m.id}>{m.name}</option>):<option value="">모델 연결 필요</option>}</select><label><input type="checkbox" checked={carryHistory} onChange={e=>setCarryHistory(e.target.checked)}/>이전 대화 포함</label></div><p className="composer-footnote">답변은 원문과 함께 확인해 주세요.</p></div>
          </>:panel==="scraps"?<div className="panel-scroll"><div className="section-heading"><h2>모아둔 문장 <span>{scraps.length}</span></h2><p>다시 읽고 싶은 생각을 한곳에.</p></div>{!scraps.length?<div className="small-empty"><Bookmark size={30}/><h3>아직 보관한 문장이 없어요</h3><p>PDF에서 문장을 선택하고<br/>스크랩을 눌러 보세요.</p></div>:scraps.map(s=><div className="scrap-card" key={s.id}><div className="scrap-card-heading"><button onClick={()=>navigateQuote(s)}>PDF {s.page}페이지 <ExternalLink size={12}/></button><button className="icon-button" aria-label="스크랩 삭제" onClick={()=>setState(v=>({...v,scraps:v.scraps.filter(x=>x.id!==s.id)}))}><X size={14}/></button></div><blockquote>{s.text}</blockquote><textarea aria-label="스크랩 메모" placeholder="나의 생각을 덧붙여 보세요…" value={s.note} onChange={e=>setState(v=>({...v,scraps:v.scraps.map(x=>x.id===s.id?{...x,note:e.target.value,updatedAt:now()}:x)}))}/><button className="text-button" onClick={()=>attachQuote(s)}><MessageSquare size={14}/>이 문장 질문하기</button></div>)}</div>:<div className="panel-scroll"><div className="section-heading"><h2>참고문헌 탐색</h2><p>한 편의 논문에서 더 넓은 생각으로.</p></div><form className="reference-search" onSubmit={e=>{e.preventDefault();void findReferences();}}><Search size={16}/><input aria-label="참고문헌 검색" placeholder="논문 제목 또는 DOI" value={refQuery} onChange={e=>{setRefQuery(e.target.value);setMatchingRef(null);searchSequence.current+=1;candidateScope.current=null;setCandidates([]);setRefSearch(false);}}/><button type="submit" className="icon-button" aria-label="참고문헌 찾기" disabled={refSearch}>{refSearch?<LoaderCircle className="spin" size={16}/>:<ArrowUp size={17}/>}</button></form>{candidates.length>0&&<div className="search-results"><h3>일치하는 문헌을 선택해 주세요</h3>{candidates.map(c=><button key={c.id} className="candidate-card" onClick={()=>chooseCandidate(c)}><strong>{c.title}</strong><small>{c.authors} · {c.year||"연도 미상"}</small><span>{c.doi||c.url}<Plus size={14}/></span></button>)}</div>}<div className="reference-list-label">이 논문의 참고문헌 <span>{references.length}</span></div>{!references.length?<div className="small-empty"><Link2 size={28}/><h3>참고문헌을 찾아보세요</h3><p>자동으로 찾지 못한 문헌은<br/>제목이나 DOI로 검색할 수 있어요.</p></div>:references.map(r=><div className={`reference-card ${matchingRef?.id===r.id?"focused":""}`} key={r.id}><div className="reference-number">{r.label}</div><strong>{r.title}</strong><small>{r.authors}{r.year?` · ${r.year}`:""}</small><span className="tag">{evidenceLabel[r.evidence]}</span><div>{r.evidence==="unverified"?<button className="text-button" onClick={()=>{setRefQuery(r.citation);void findReferences(r.citation,r);}}><Search size={14}/>문헌 확인</button>:null}<button className="text-button" onClick={()=>openReference(r)}><MessageSquare size={14}/>대화 열기</button></div></div>)}</div>}
        </aside>
      </div>}
      {activePaper&&<nav className="mobile-tabs"><button className={mobilePane==="reader"?"active":""} onClick={()=>setMobilePane("reader")}><BookOpen size={19}/>논문</button>{([["chat",MessageSquare,"질문"],["scraps",Bookmark,"스크랩"],["references",Link2,"참조"]] as const).map(([p,Icon,label])=><button key={p} className={mobilePane==="panel"&&panel===p?"active":""} onClick={()=>{setPanel(p);setMobilePane("panel");}}><Icon size={19}/>{label}</button>)}</nav>}
    </main>
    {importing&&<div className="import-progress"><LoaderCircle className="spin" size={18}/><span>논문을 가져오고 있어요…</span></div>}
    {toast&&<div className="toast" role="status"><span>{toast}</span><button className="icon-button" aria-label="알림 닫기" onClick={()=>setToast("")}><X size={15}/></button></div>}
    {settings&&<div className="modal-overlay" onClick={()=>setSettings(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={e=>e.stopPropagation()}><header><div><span className="eyebrow">YOUR WORKSPACE</span><h2 id="settings-title">연결 설정</h2></div><button className="icon-button" aria-label="설정 닫기" onClick={()=>setSettings(false)}><X size={20}/></button></header><div className="settings-section"><h3><Cloud size={17}/>어디서든 같은 서재</h3><p>{user?`${user.email} 계정으로 연결되어 있어요.`:cloudReady?"Google Drive에 연결하면 논문과 기록을 PC·폰에서 이어볼 수 있어요.":"현재 이 브라우저에 기록을 보관하고 있어요. Google OAuth 설정 후 Drive로 기기 간 동기화를 사용할 수 있습니다."}</p>{!user&&<p className="settings-note">로그인 전 기록과 계정 서재는 따로 보관합니다. 계정 서재에서 읽을 PDF는 로그인 후 가져와 주세요.</p>}<button className="button secondary" disabled={!cloudReady} onClick={()=>void (user?signOut():signIn()).catch(notifyError)}>{user?<LogOut size={16}/>:<LogIn size={16}/ >}{user?"로그아웃":"Google Drive로 연결"}</button>{user&&<button className="button secondary" onClick={()=>void signIn().catch(notifyError)}><RotateCcw size={16}/>Google 다시 연결</button>}</div><div className="settings-section"><h3><Sparkles size={17}/>함께 읽을 AI</h3>{providers.map(p=><div className="provider-status" key={p.id}><span className={`provider-logo ${p.id}`}>{p.name.charAt(0)}</span><div><strong>{p.name}</strong><small>{p.configured?`${p.models.length}개 모델 설정됨`:p.reason||"연결 설정이 필요해요"}</small></div><span className={p.configured?"connection-ready":"connection-pending"}>{p.configured?<Check size={15}/>:<span/>}{p.configured?"설정됨":"미연결"}</span></div>)}</div><div className="settings-section"><h3><DriveIcon/>Google Drive</h3><p>직접 선택한 PDF를 가져와 읽고 질문할 수 있어요.</p><button className="button secondary" onClick={()=>{setSettings(false);void importDrive();}}>Drive에서 논문 선택</button></div><p className="settings-note">API 비밀키는 화면에 입력하지 않습니다. 배포 설정을 통해 서버에서 안전하게 연결합니다.</p></section></div>}
  </div>;
}

function DriveIcon(){return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 3 5 0 9 16-5 0z" fill="#f9bc15"/><path d="m8 3-7 13 3 5 8-14z" fill="#22a566"/><path d="m4 21 16 0 3-5H7z" fill="#4385f4"/></svg>;}
