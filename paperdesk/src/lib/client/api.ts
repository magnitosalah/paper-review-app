"use client";

import { driveConnected, getDriveAccessToken } from "./drive";

export async function authorizedFetch(input:RequestInfo|URL,init:RequestInit={}):Promise<Response> {
  const headers=new Headers(input instanceof Request?input.headers:undefined);
  new Headers(init.headers).forEach((value,name)=>headers.set(name,value));
  const target=new URL(input instanceof Request?input.url:input.toString(),window.location.href);
  if(target.origin!==window.location.origin)throw new Error("인증 정보는 앱 내부 요청에만 전송할 수 있습니다.");
  if(driveConnected())headers.set("Authorization",`Bearer ${await getDriveAccessToken()}`);
  return fetch(input,{...init,headers,credentials:"same-origin"});
}
