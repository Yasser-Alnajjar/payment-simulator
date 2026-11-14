import { fmtTime } from "@/lib/scenarios";
import type { SchedulerStatus } from "@/lib/types/webhook";
import { Notice } from "@components/ui/form";

/** Server-rendered scheduler status: deliveries are sent by a tick that Supabase Cron triggers every minute. */
export function SchedulerNotice({ s }: { s: SchedulerStatus }) {
  if (!s.stale) return <p className="text-xs text-neutral-500">Scheduler: last run finished {fmtTime(s.lastFinishedAt)}{s.lastDurationMs !== null ? ` in ${(s.lastDurationMs / 1000).toFixed(1)} s` : ""}. Deliveries are attempted about once a minute.</p>;
  return (
    <Notice tone="warning" title="The delivery scheduler has not run in the last 3 minutes.">
      Webhooks stay queued and are sent once it runs again. Last finished run: {fmtTime(s.lastFinishedAt)}.
    </Notice>
  );
}
