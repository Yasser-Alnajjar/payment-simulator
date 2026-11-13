import { handlers } from "@/server/api/handlers";
import { defaultDeps } from "@/server/api/deps-default";

export const dynamic = "force-dynamic";
export const GET = async (req: Request, ctx: { params: Promise<{ methodId: string }> }) => handlers.getPaymentMethod(req, defaultDeps(), (await ctx.params).methodId);
export const DELETE = async (req: Request, ctx: { params: Promise<{ methodId: string }> }) => handlers.deletePaymentMethod(req, defaultDeps(), (await ctx.params).methodId);
