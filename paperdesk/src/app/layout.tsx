import type { Metadata } from "next";
import "./globals.css";
export const metadata:Metadata = {title:"Paperdesk — 논문을 읽는 나만의 공간",description:"논문, 생각, 질문을 한곳에. 여러 AI와 함께 읽고 PC와 모바일에서 이어가는 연구 공간.",manifest:"/manifest.webmanifest"};
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="ko"><body>{children}</body></html>; }
