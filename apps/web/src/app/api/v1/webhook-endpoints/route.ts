import { handlers } from "@/server/api/handlers";
import { defaultDeps } from "@/server/api/deps-default";

export const dynamic = "force-dynamic";
export const POST = (req: Request) => handlers.createWebhookEndpoint(req, defaultDeps());
export const GET = (req: Request) => handlers.listWebhookEndpoints(req, defaultDeps());
