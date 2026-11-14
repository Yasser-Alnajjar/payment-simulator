import { handlers } from "@/server/api/handlers";
import { defaultDeps } from "@/server/api/deps-default";

export const dynamic = "force-dynamic";
type P = { params: Promise<{ endpointId: string }> };
export const GET = async (req: Request, ctx: P) => handlers.getWebhookEndpoint(req, defaultDeps(), (await ctx.params).endpointId);
export const PATCH = async (req: Request, ctx: P) => handlers.updateWebhookEndpoint(req, defaultDeps(), (await ctx.params).endpointId);
export const DELETE = async (req: Request, ctx: P) => handlers.deleteWebhookEndpoint(req, defaultDeps(), (await ctx.params).endpointId);
