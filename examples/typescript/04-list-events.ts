import { SandboxClient } from "./client";

/** Prints the latest events (newest first), following the cursor.   npx tsx examples/typescript/04-list-events.ts [event.type] */
const client = new SandboxClient();
const type = process.argv[2]; // e.g. payment.succeeded

let shown = 0;
for await (const event of client.paginate<{ id: string; type: string; created: string }>("/api/v1/events", { type })) {
  console.log(event.created, event.type, event.id);
  if (++shown >= 25) break; // stop early: the generator fetches the next page only when asked
}
