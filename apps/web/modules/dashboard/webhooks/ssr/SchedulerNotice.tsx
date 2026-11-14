import { fmtTime } from "@/lib/scenarios";
import type { SchedulerStatus } from "@/lib/types/webhook";

/** Server-rendered scheduler status: deliveries are sent by a tick that Supabase Cron triggers every minute. */
export function SchedulerNotice({ s }: { s: SchedulerStatus }) {
  if (!s.stale) return <p className="text-xs text-neutral-500">Scheduler: last run finished {fmtTime(s.lastFinishedAt)}{s.lastDurationMs !== null ? ` in ${(s.lastDurationMs / 1000).toFixed(1)} s` : ""}. Deliveries are attempted about once a minute.</p>;
  return (
    <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">The delivery scheduler has not run in the last 3 minutes.</p>
      <p>Webhooks stay queued and are sent once it runs again. Last finished run: {fmtTime(s.lastFinishedAt)}.</p>
    </div>
  );
}
