export type ProviderId = "gemini" | "claude" | "codex";
export interface PdfRect { x1: number; y1: number; x2: number; y2: number }
export interface Paper { id:string; title:string; filename:string; source:"local"|"drive"|"sample"; createdAt:string; updatedAt:string; pageCount?:number; contentHash?:string; storagePath?:string; driveFileId?:string; driveModifiedTime?:string }
export interface Quote { id:string; paperId:string; paperVersion?:string; page:number; text:string; originalText:string; rects:PdfRect[] }
export interface Scrap extends Quote { note:string; createdAt:string; updatedAt:string }
export interface Reference { id:string; paperId:string; label:string; citation:string; title:string; authors:string; year?:number; doi?:string; url?:string; abstract?:string; evidence:"unverified"|"metadata"|"abstract"|"fulltext"; contextQuote?:Quote; linkedPaperId?:string; createdAt:string }
export interface Chat { id:string; paperId:string; referenceId?:string; title:string; createdAt:string }
export interface Message { id:string; chatId:string; role:"user"|"assistant"; content:string; provider:ProviderId; model:string; quote?:Quote; createdAt:string; status:"pending"|"streaming"|"complete"|"interrupted"|"failed"; requestId?:string; error?:string }
export interface ReadingPosition { page:number; scale:number; updatedAt:string }
export interface WorkspaceState { version:1; papers:Paper[]; scraps:Scrap[]; references:Reference[]; chats:Chat[]; messages:Message[]; readingPositions:Record<string,ReadingPosition>; drafts:Record<string,string>; draftQuotes?:Record<string,Quote|null> }
export interface ProviderStatus { id:ProviderId; name:string; configured:boolean; models:{id:string;name:string}[]; reason?:string }
export const emptyWorkspace = ():WorkspaceState => ({version:1,papers:[],scraps:[],references:[],chats:[],messages:[],readingPositions:{},drafts:{},draftQuotes:{}});
