import { Link } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

// Grows with A6 (clients, resources, users, audit, keys); only routes that exist are listed.
const NAV = [{ to: "/", label: "Dashboard", icon: LayoutDashboardIcon }] as const;

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader>
        <span className="px-2 text-sm font-semibold">SSO Admin</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label="Main">
              <SidebarMenu>
                {NAV.map(({ to, label, icon: Icon }) => (
                  <SidebarMenuItem key={to}>
                    {/* Link sets aria-current="page" when active; data-active drives the style. */}
                    <SidebarMenuButton asChild>
                      <Link
                        to={to}
                        activeOptions={{ exact: true }}
                        activeProps={{ "data-active": true }}
                      >
                        <Icon aria-hidden="true" />
                        <span>{label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
