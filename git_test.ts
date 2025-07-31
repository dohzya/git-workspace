import { assertEquals } from "jsr:@std/assert";
import { retrieveMainBranch } from "./git.ts";

Deno.test("retrieveMainBranch falls back to 'main' when no config", async () => {
  const oldEnv = Deno.env.get("GIT_WP_MAIN_BRANCH");
  if (oldEnv) Deno.env.delete("GIT_WP_MAIN_BRANCH");
  const branch = await retrieveMainBranch();
  assertEquals(branch, "main");
  if (oldEnv) Deno.env.set("GIT_WP_MAIN_BRANCH", oldEnv);
});

Deno.test("retrieveMainBranch uses env variable when set", async () => {
  const oldEnv = Deno.env.get("GIT_WP_MAIN_BRANCH");
  Deno.env.set("GIT_WP_MAIN_BRANCH", "develop");
  const branch = await retrieveMainBranch();
  assertEquals(branch, "develop");
  if (oldEnv) {
    Deno.env.set("GIT_WP_MAIN_BRANCH", oldEnv);
  } else {
    Deno.env.delete("GIT_WP_MAIN_BRANCH");
  }
});
