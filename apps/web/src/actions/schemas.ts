import { z } from "zod";

/** Action input schemas. None contains a user id: ownership always comes from the session. Unknown keys are stripped. */
export const credentialIdInput = z.object({ credentialId: z.uuid() });
