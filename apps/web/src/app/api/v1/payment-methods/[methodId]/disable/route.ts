import { handlers } from "@/server/api/handlers";
import { defaultDeps } from "@/server/api/deps-default";

export const dynamic = "force-dynamic";
export const POST = async (req: Request, ctx: { params: Promise<{ methodId: string }> }) => handlers.disablePaymentMethod(req, defaultDeps(), (await ctx.params).methodId);
