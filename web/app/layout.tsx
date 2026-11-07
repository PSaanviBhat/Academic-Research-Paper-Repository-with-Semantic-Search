import type { Metadata } from "next";
import type { ReactNode } from "react";
import NavBar from "@/components/NavBar";
import { SessionProvider } from "@/components/Session";
import "./globals.css";

export const metadata: Metadata = {
  title: "Paper Repository",
  description: "Search academic papers by keyword, meaning, or both.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <NavBar />
          <main>{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
