"use client";

/** Google access tokens deliberately live only in memory, never localStorage. */
interface TokenResponse { access_token?: string; expires_in?: number; scope?:string; error?: string; error_description?: string }
interface TokenClient { requestAccessToken(options?: {prompt?:string}): void }
interface PickerDocument { id:string; name?:string; mimeType?:string }
interface PickerResult { action:string; docs?:PickerDocument[] }
interface PickerView { setMimeTypes(value:string):PickerView; setIncludeFolders(value:boolean):PickerView; setSelectFolderEnabled(value:boolean):PickerView }
interface PickerInstance { setVisible(value:boolean):void; dispose?():void }
interface PickerBuilder {
  addView(view:PickerView):PickerBuilder;
  setOAuthToken(token:string):PickerBuilder;
  setDeveloperKey(key:string):PickerBuilder;
  setAppId(id:string):PickerBuilder;
  setOrigin(origin:string):PickerBuilder;
  setTitle(title:string):PickerBuilder;
  setLocale(locale:string):PickerBuilder;
  setCallback(callback:(result:PickerResult)=>void):PickerBuilder;
  build():PickerInstance;
}
interface GoogleApi {
  accounts:{oauth2:{initTokenClient(config:{client_id:string;scope:string;login_hint?:string;callback:(result:TokenResponse)=>void;error_callback:(error:{type:string})=>void}):TokenClient;revoke(token:string,callback:()=>void):void;hasGrantedAllScopes(response:TokenResponse,...scopes:string[]):boolean}};
  picker:{PickerBuilder:new()=>PickerBuilder;DocsView:new()=>PickerView;Action:{PICKED:string;CANCEL:string}};
}
declare global {
  interface Window { google?:GoogleApi; gapi?:{load(name:string,options:{callback:()=>void;onerror:()=>void;timeout:number;ontimeout:()=>void}):void} }
}

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
const APP_ID = process.env.NEXT_PUBLIC_GOOGLE_APP_ID ?? "";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const WORKSPACE_SCOPES = ["openid","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/userinfo.profile",SCOPE,"https://www.googleapis.com/auth/drive.appdata"];
const MAX_FILE_SIZE = 50 * 1024 * 1024;
let accessToken: string | null = null;
let expiresAt = 0;
let preparation:Promise<void>|null = null;
let authPending:Promise<void>|null = null;
let pickerOpen = false;
let grantedScopes = new Set<string>();
let googleUser:{id:string;email:string}|null = null;
let authGeneration = 0;
const scriptPromises = new Map<string,Promise<void>>();

export class DriveError extends Error {
  constructor(message:string, readonly code:string) { super(message); this.name = "DriveError"; }
}
export interface DriveFile { id:string; name:string; modifiedTime?:string; blob:Blob }
export function driveConfigured():boolean { return Boolean(CLIENT_ID && API_KEY && APP_ID); }
export function googleAuthConfigured():boolean { return Boolean(CLIENT_ID); }
export function driveConnected():boolean { return Boolean(accessToken && Date.now() < expiresAt); }

function loadScript(src:string):Promise<void> {
  const cached = scriptPromises.get(src);
  if (cached) return cached;
  const promise = new Promise<void>((resolve,reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    const timeout = setTimeout(() => { script.remove(); reject(new DriveError("Google 연결을 불러오는 데 시간이 걸립니다. 연결을 확인하고 다시 시도해 주세요.","SCRIPT_TIMEOUT")); },20000);
    script.onload = () => {clearTimeout(timeout);resolve();};
    script.onerror = () => {clearTimeout(timeout);script.remove();reject(new DriveError("Google 연결을 불러오지 못했습니다. 브라우저의 콘텐츠 차단 설정을 확인해 주세요.","SCRIPT_LOAD_FAILED"));};
    document.head.appendChild(script);
  }).catch(error => {scriptPromises.delete(src);throw error;});
  scriptPromises.set(src,promise);
  return promise;
}

/** Call after mount so an explicit button click can request the OAuth popup. */
export function prepareGoogleAuth():Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new DriveError("Google 연결은 브라우저에서 사용할 수 있습니다.","BROWSER_REQUIRED"));
  if (!googleAuthConfigured()) return Promise.reject(new DriveError("Google OAuth 클라이언트 설정이 필요합니다.","NOT_CONFIGURED"));
  return loadScript("https://accounts.google.com/gsi/client");
}

export function prepareDrivePicker():Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new DriveError("Drive는 브라우저에서 연결할 수 있습니다.","BROWSER_REQUIRED"));
  if (!driveConfigured()) return Promise.reject(new DriveError("Google Drive 설정이 필요합니다. 설정에서 Google OAuth·Picker 환경변수를 확인해 주세요.","NOT_CONFIGURED"));
  if (!preparation) preparation = Promise.all([
    loadScript("https://accounts.google.com/gsi/client"),
    loadScript("https://apis.google.com/js/api.js"),
  ]).then(() => new Promise<void>((resolve,reject) => {
    if (!window.gapi) return reject(new DriveError("Google Picker를 초기화하지 못했습니다.","SCRIPT_LOAD_FAILED"));
    window.gapi.load("picker",{callback:resolve,onerror:()=>reject(new DriveError("Google Picker를 열 수 없습니다.","PICKER_LOAD_FAILED")),timeout:20000,ontimeout:()=>reject(new DriveError("Google Picker 연결 시간이 초과되었습니다.","PICKER_TIMEOUT"))});
  })).catch(error => {preparation=null;throw error;});
  return preparation;
}

/** Must be called from a user action; no silent popup on ordinary page loading. */
async function authorizeScopes(scopes:string[]):Promise<void> {
  await prepareGoogleAuth();
  if (driveConnected() && expiresAt-Date.now()>180000 && scopes.every(scope=>grantedScopes.has(scope))) return;
  if (authPending) {await authPending;if(driveConnected()&&scopes.every(scope=>grantedScopes.has(scope)))return;throw new DriveError("다른 Google 연결이 진행 중입니다. 연결 후 다시 눌러 주세요.","AUTH_PENDING");}
  const generation=authGeneration;
  authPending = new Promise<void>((resolve,reject) => {
    const oauth = window.google?.accounts.oauth2;
    if (!oauth) return reject(new DriveError("Google 인증을 시작하지 못했습니다.","AUTH_UNAVAILABLE"));
    const client = oauth.initTokenClient({
      client_id:CLIENT_ID,scope:scopes.join(" "),login_hint:googleUser?.email,
      callback:(response) => {
        if(generation!==authGeneration){reject(new DriveError("Google 연결이 취소되었습니다.","CANCELLED"));return;}
        if (response.error || !response.access_token) {
          reject(new DriveError(response.error === "access_denied" ? "Drive 접근이 취소되었습니다." : "Drive 인증을 완료하지 못했습니다. 다시 연결해 주세요.","AUTH_FAILED"));
          return;
        }
        if(!oauth.hasGrantedAllScopes(response,...scopes)){reject(new DriveError("선택한 기능에 필요한 권한이 허용되지 않았습니다. 다시 연결해 주세요.","SCOPE_REQUIRED"));return;}
        accessToken = response.access_token;
        grantedScopes = new Set((response.scope||scopes.join(" ")).split(" "));
        expiresAt = Date.now() + Math.max(0,(Number(response.expires_in) || 3600) - 60)*1000;
        resolve();
      },
      error_callback:(error) => reject(new DriveError(error.type === "popup_closed" ? "Google 연결 창이 닫혔습니다." : "Google 연결 팝업을 열지 못했습니다. 팝업을 허용한 뒤 다시 눌러 주세요.",error.type === "popup_closed" ? "CANCELLED" : "POPUP_BLOCKED")),
    });
    client.requestAccessToken({prompt:""});
  }).finally(() => {authPending=null;});
  return authPending;
}

/** Must be called from a user action; background requests never open a popup. */
export async function reconnectDrive():Promise<void> { await authorizeScopes(googleUser?WORKSPACE_SCOPES:[SCOPE]);if(googleUser)await getGoogleUser(); }
export async function getDriveAccessToken(interactive=false):Promise<string> {
  if(!driveConnected()&&interactive)await reconnectDrive();
  if(!driveConnected()||!accessToken)throw new DriveError("Google Drive 연결이 만료되었습니다. 연결 설정에서 다시 연결해 주세요.","DRIVE_RECONNECT_REQUIRED");
  return accessToken;
}
export async function getGoogleUser():Promise<{id:string;email:string}> {
  const token=await getDriveAccessToken();
  const response=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new DriveError("Google 계정을 확인하지 못했습니다. 다시 연결해 주세요.","AUTH_FAILED");
  const data=await response.json();
  if(!data.sub||!data.email||data.email_verified!==true)throw new DriveError("확인된 이메일이 있는 Google 계정으로 연결해 주세요.","AUTH_FAILED");
  if(token!==accessToken)throw new DriveError("Google 계정 연결이 바뀌었습니다. 다시 연결해 주세요.","ACCOUNT_CHANGED");
  if(googleUser&&googleUser.id!==data.sub){disconnectDrive();throw new DriveError("다른 Google 계정을 선택했습니다. 로그아웃 후 해당 계정으로 연결해 주세요.","ACCOUNT_CHANGED");}
  return googleUser={id:data.sub,email:data.email};
}
export async function authorizeDriveWorkspace():Promise<{id:string;email:string}> { await authorizeScopes(WORKSPACE_SCOPES);return getGoogleUser(); }

/** A pre-generated Drive ID lets the server atomically claim a billable AI request. */
export async function generateChatRequestId():Promise<string> {
  if(expiresAt-Date.now()<150000)throw new DriveError("Google 연결이 곧 만료됩니다. 연결 설정에서 Google 다시 연결을 눌러 주세요.","DRIVE_RECONNECT_REQUIRED");
  const token=await getDriveAccessToken();
  const response=await fetch("https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=appDataFolder&type=files",{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new DriveError("질문 저장 공간을 준비하지 못했습니다. Google Drive를 다시 연결해 주세요.","REQUEST_ID_FAILED");
  const data=await response.json();const id=data.ids?.[0];
  if(typeof id!=="string"||! /^[\w-]{16,200}$/.test(id))throw new DriveError("질문 식별자를 만들지 못했습니다.","REQUEST_ID_FAILED");
  return id;
}

async function driveFetch(path:string):Promise<Response> {
  if (!driveConnected()) throw new DriveError("Drive를 다시 연결한 뒤 논문을 열어 주세요.","DRIVE_RECONNECT_REQUIRED");
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`,{headers:{Authorization:`Bearer ${accessToken}`}});
  if (response.status === 401) {
    accessToken=null;expiresAt=0;
    throw new DriveError("Drive 연결이 만료되었습니다. 다시 연결해 주세요.","DRIVE_RECONNECT_REQUIRED");
  }
  if (response.status === 403) throw new DriveError("이 파일을 읽거나 다운로드할 권한이 없습니다. Drive에서 파일 접근 권한을 확인해 주세요.","FILE_FORBIDDEN");
  if (response.status === 404) throw new DriveError("Drive 파일을 찾지 못했습니다. 파일이 삭제되었거나 앱에서 선택한 계정에 접근 권한이 없을 수 있습니다.","FILE_NOT_FOUND");
  if (!response.ok) throw new DriveError("Drive에서 파일을 가져오지 못했습니다. 잠시 뒤 다시 시도해 주세요.","DOWNLOAD_FAILED");
  return response;
}

export async function getDriveMetadata(fileId:string):Promise<{id:string;name:string;modifiedTime?:string;size?:string;mimeType:string;capabilities?:{canDownload?:boolean}}> {
  if (!/^[\w-]+$/.test(fileId)) throw new DriveError("올바른 Drive 파일 식별자가 아닙니다.","INVALID_FILE_ID");
  const response = await driveFetch(`files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime,capabilities(canDownload)&supportsAllDrives=true`);
  return response.json();
}

export async function loadDriveFile(fileId:string):Promise<Blob> {
  const metadata = await getDriveMetadata(fileId);
  if (metadata.mimeType !== "application/pdf") throw new DriveError("현재는 PDF 파일만 열 수 있습니다.","NOT_PDF");
  if (metadata.capabilities?.canDownload === false) throw new DriveError("파일 소유자가 다운로드를 제한한 PDF입니다.","FILE_FORBIDDEN");
  if (Number(metadata.size) > MAX_FILE_SIZE) throw new DriveError("첫 버전에서는 50MB 이하의 PDF를 열 수 있습니다.","FILE_TOO_LARGE");
  const response = await driveFetch(`files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  if (Number(response.headers.get("content-length")) > MAX_FILE_SIZE) throw new DriveError("첫 버전에서는 50MB 이하의 PDF를 열 수 있습니다.","FILE_TOO_LARGE");
  const blob = await response.blob();
  if (blob.size > MAX_FILE_SIZE) throw new DriveError("첫 버전에서는 50MB 이하의 PDF를 열 수 있습니다.","FILE_TOO_LARGE");
  const signature = await blob.slice(0,1024).text();
  if (!signature.includes("%PDF-")) throw new DriveError("가져온 파일을 PDF로 확인할 수 없습니다.","NOT_PDF");
  return new Blob([blob],{type:"application/pdf"});
}

export async function openDrivePicker():Promise<DriveFile> {
  if (pickerOpen) throw new DriveError("이미 Drive 파일 선택창이 열려 있습니다.","PICKER_ALREADY_OPEN");
  await prepareDrivePicker();
  await reconnectDrive();
  const pickerApi = window.google?.picker;
  if (!pickerApi || !accessToken) throw new DriveError("Google 파일 선택창을 준비하지 못했습니다.","PICKER_LOAD_FAILED");
  pickerOpen=true;
  try {
    const selected = await new Promise<PickerDocument>((resolve,reject) => {
      const view = new pickerApi.DocsView().setMimeTypes("application/pdf").setIncludeFolders(true).setSelectFolderEnabled(false);
      const picker = new pickerApi.PickerBuilder().addView(view).setOAuthToken(accessToken!).setDeveloperKey(API_KEY).setAppId(APP_ID).setOrigin(window.location.origin).setLocale("ko").setTitle("논문 PDF 선택").setCallback(result => {
        if (result.action === pickerApi.Action.PICKED) {
          picker.setVisible(false);
          const item = result.docs?.[0];
          if (item) resolve(item); else reject(new DriveError("선택한 파일을 확인하지 못했습니다.","NO_FILE"));
        } else if (result.action === pickerApi.Action.CANCEL) reject(new DriveError("파일 선택을 취소했습니다.","CANCELLED"));
      }).build();
      picker.setVisible(true);
    });
    const metadata = await getDriveMetadata(selected.id);
    const blob = await loadDriveFile(selected.id);
    return {id:metadata.id,name:metadata.name,modifiedTime:metadata.modifiedTime,blob};
  } finally {pickerOpen=false;}
}

export function disconnectDrive():void { authGeneration+=1;accessToken=null;expiresAt=0;googleUser=null;grantedScopes.clear(); }
