import { handlers } from "@/server/api/handlers";
import { defaultDeps } from "@/server/api/deps-default";

export const dynamic = "force-dynamic";
export const GET = (req: Request) => handlers.getDefaultPaymentMethod(req, defaultDeps());
