import { handlers } from "@/server/api/handlers";
import { defaultDeps } from "@/server/api/deps-default";

export const dynamic = "force-dynamic";
export const GET = async (req: Request, ctx: { params: Promise<{ eventId: string }> }) => handlers.getEvent(req, defaultDeps(), (await ctx.params).eventId);
