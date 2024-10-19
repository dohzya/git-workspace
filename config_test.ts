import { assertEquals } from "jsr:@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

import { ConfigSchema, DEFAULT_CONFIG, readConfig } from "./config.ts";

Deno.test("DEFAULT_CONFIG is a valid config", function () {
  // throws is invalid
  ConfigSchema.parse(parseYaml(DEFAULT_CONFIG));
});

Deno.test("readConfig returns a valid config", async function () {
  const config = await readConfig({
    content: `
      action1:
        tasks:
          - action: action2
          - type: action
            args: --foo
            action: action3
    `,
  });
  assertEquals(config.action1.tasks[0], { type: "action", action: "action2" });
});
