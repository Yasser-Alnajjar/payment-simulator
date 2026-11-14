import { handlers } from "@/server/api/handlers";
import { defaultDeps } from "@/server/api/deps-default";

export const dynamic = "force-dynamic";
export const GET = async (req: Request, ctx: { params: Promise<{ deliveryId: string }> }) => handlers.getWebhookDelivery(req, defaultDeps(), (await ctx.params).deliveryId);
