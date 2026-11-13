import "server-only";
import { getPrisma } from "@sandbox/db";

export const db = () => getPrisma();
