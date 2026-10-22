import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: DashboardPage });

// Placeholder until A6.6 (dashboard from the admin API).
function DashboardPage() {
  return (
    <section aria-labelledby="dashboard-title" className="space-y-2">
      <h1 id="dashboard-title" className="text-2xl font-semibold">
        Dashboard
      </h1>
      <p className="text-muted-foreground">Administration console. Sections arrive with A6.</p>
    </section>
  );
}
