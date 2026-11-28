import assert from "node:assert/strict";
import { j } from "./context.mjs";
assert.ok(
  j.id && Object.keys(j.acl).every((file) => j.guards?.includes(file)),
  "Primitive ACL restoration incomplete",
);
