import { exists } from "@std/fs/exists";
import * as path from "@std/path/join";
import { parse as parseYaml } from "@std/yaml/parse";
import { z } from "zod";

export const CONFIG_FILENAME = "dz.config.yml";

function unmargin(str: string): string {
  const trimed = str.replace(/^\n*/g, "");
  const spaces = trimed.replace(/^(\s*).*/s, "$1");
  return trimed.replace(new RegExp(`^${spaces}`, "mg"), "");
}

export const Check = {
  create: "create",
  local: "local",
  notLocal: "not_local",
} as const;
export type Check = (typeof Check)[keyof typeof Check];
export const Checks = Object.freeze(
  Object.values(Check) as [Check, ...Check[]],
);
export const CheckSchema: z.ZodType<Check, z.ZodTypeDef, unknown> = z.enum(
  Checks,
);

export type Task = {
  type: "bash";
  script: string;
  stop_on_error?: boolean;
} | {
  type: "action";
  action: string;
  stop_on_error?: boolean;
  args?: string[];
};
export const TaskSchema: z.ZodType<Task, z.ZodTypeDef, unknown> = z.union([
  z.object({
    type: z.literal("action"),
    action: z.string().min(1),
    args: z.optional(z.array(z.string())),
    stop_on_error: z.optional(z.boolean()),
  }),
  z.object({
    action: z.string().min(1),
    args: z.optional(z.array(z.string())),
    stop_on_error: z.optional(z.boolean()),
  }).transform(({ action, args, stop_on_error }) => ({
    type: "action" as const,
    action,
    args,
    stop_on_error,
  })),
  z.object({
    type: z.literal("bash"),
    script: z.string().min(1),
    stop_on_error: z.optional(z.boolean()),
  }),
  z.object({
    bash: z.string().min(1),
  }).transform(({ bash }) => ({ type: "bash" as const, script: bash })),
]);

export type Action = {
  checks?: Record<string, Check>;
  tasks: Task[];
};
export const ActionSchema: z.ZodType<Action, z.ZodTypeDef, unknown> = z
  .object({
    checks: z.optional(z.record(CheckSchema)),
    tasks: z.array(TaskSchema),
  });

export type Config = Record<string, Action>;
export const ConfigSchema: z.ZodType<Config, z.ZodTypeDef, unknown> = z
  .record(ActionSchema);

export const DEFAULT_CONFIG = unmargin(`
  "tab:title":
    tasks:
      - bash: |
          args="$GIT_WP_PROJECT:$GIT_WP_BRANCH"
          for arg in "$@"; do args="\${args}:\${arg}"; done
          wezterm cli set-tab-title "$(echo "$args" | sed -e 's/^://' -e 's/::*/:/g')"
  "vscode:wp:create":
    tasks:
      - bash: |
          filename="$(echo "\${GIT_WP_PROJECT}⸬\${GIT_WP_BRANCH}" | sed 's#/#⧸#g').code-workspace"
          if [[ ! -f "$filename" ]]; then
            echo '{"folders":[{"path": "."}],"settings":{}}' > "$filename"
          fi
  "vscode:wp:open":
    tasks:
      - action: vscode:wp:create
      - bash: |
          filename="$(echo "\${GIT_WP_PROJECT}⸬\${GIT_WP_BRANCH}" | sed 's#/#⧸#g').code-workspace"
          open "$filename"
`);

type ReadConfigOptions =
  | { content: string | undefined; path?: undefined; dir?: undefined }
  | { content?: undefined; path: string | undefined; dir?: undefined }
  | { content?: undefined; path?: undefined; dir: string | undefined };
export async function readConfig(options: ReadConfigOptions): Promise<Config> {
  const configPath = options.path ??
    (options.dir && path.join(options.dir, CONFIG_FILENAME));
  console.log(configPath);

  const configStr = options.content ?? (
    configPath &&
    await exists(configPath, { isFile: true }) &&
    await Deno.readTextFile(configPath)
  );

  if (!configStr) {
    return {};
  }

  const parsed = parseYaml(configStr);

  return ConfigSchema.parse(parsed);
}
