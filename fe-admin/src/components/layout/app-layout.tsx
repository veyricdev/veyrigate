import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ThemeToggle } from "@/features/theme/theme-toggle";
import { AppSidebar } from "./app-sidebar";

export function AppLayout({ sidebarOpen, children }: { sidebarOpen: boolean; children: ReactNode }) {
  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 p-4 outline-none md:p-6">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
