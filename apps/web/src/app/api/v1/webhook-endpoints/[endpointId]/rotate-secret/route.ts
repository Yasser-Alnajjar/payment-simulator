import { handlers } from "@/server/api/handlers";
import { defaultDeps } from "@/server/api/deps-default";

export const dynamic = "force-dynamic";
export const POST = async (req: Request, ctx: { params: Promise<{ endpointId: string }> }) => handlers.rotateWebhookSecret(req, defaultDeps(), (await ctx.params).endpointId);
