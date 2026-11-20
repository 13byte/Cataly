import assert from "node:assert/strict";
import { join } from "node:path";
import { requiredSourceRequest } from "./required-source.ts";

const [boundary, availability] = process.argv.slice(2);
assert(boundary === "session" || boundary === "provider");
assert(availability === "available" || availability === "unavailable");
const available = availability === "available";
const result = await requiredSourceRequest(
  join(import.meta.dir, "../../../extension/index.ts"),
  process.cwd(),
  "lane",
  boundary,
  available ? "openai/required-source-local" : "openai/absent",
);
assert.deepEqual(result.errors.filter((error) => error.event === "session_start"), []);
assert.equal(result.requests, available ? 1 : 0);
if (!available) assert(result.errors.some((error) => error.error.includes("STARTUP_MODEL_HOLD")));
