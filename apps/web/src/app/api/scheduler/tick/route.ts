import { handleSchedulerTick } from "@/server/webhooks/tick-handler";
import { defaultTickDeps } from "@/server/webhooks/tick-deps-default";

// Called by Supabase Cron every minute. The tick's own work budget is 25 s (see server/webhooks/scheduler.ts); 60 s is the hard
// platform limit for this function (Vercel Hobby allows up to 300 s).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const POST = (req: Request) => handleSchedulerTick(req, defaultTickDeps());
