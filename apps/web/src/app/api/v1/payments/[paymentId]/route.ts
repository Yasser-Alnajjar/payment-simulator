import { handlers } from "@/server/api/handlers";
import { defaultDeps } from "@/server/api/deps-default";

export const dynamic = "force-dynamic";
export const GET = async (req: Request, ctx: { params: Promise<{ paymentId: string }> }) => handlers.getPayment(req, defaultDeps(), (await ctx.params).paymentId);
