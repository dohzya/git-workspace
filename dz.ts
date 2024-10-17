#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-run

import $ from "jsr:@david/dax@0.42.0";
import { exists } from "jsr:@std/fs";
import * as path from "jsr:@std/path/join";
import { parseArgs } from "jsr:@std/cli";
import { parse as parseYaml } from "jsr:@std/yaml";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

const BARE_REPO_DIRNAME = Deno.env.get("GIT_WP_BARE_REPO_NAME") || "bare.git";
const WORKTREES_DIRNAME = Deno.env.get("GIT_WP_WORKTREES_DIR") || ".";

function unmargin(str: string): string {
  const trimed = str.replace(/^\n*/g, "");
  const spaces = trimed.replace(/^(\s*).*/s, "$1");
  return trimed.replace(new RegExp(`^${spaces}`, "mg"), "");
}

function die(code: number, header: unknown, ...details: unknown[]): never {
  if (details.length === 0 || typeof header !== "string") {
    $.logError("ERROR", header);
  } else {
    $.logError(header, ...details);
  }
  Deno.exit(code);
}

let _displayInfo = true;
function displayInfo(display: boolean) {
  _displayInfo = display;
}

function emptyLog() {
  if (!_displayInfo) return;
  $.log();
}
function warn(header: string, ...details: unknown[]) {
  if (!_displayInfo) return;
  $.logWarn(header, ...(details.length ? details : [""]));
}
function info(header: string, ...details: unknown[]) {
  if (!_displayInfo) return;
  $.logStep(header, ...(details.length ? details : [""]));
}
function note(header: string, ...details: unknown[]) {
  if (!_displayInfo) return;
  $.logLight(header, ...(details.length ? details : [""]));
}
async function progress<T>(fn: () => Promise<T>) {
  if (!_displayInfo) return await fn();
  return await $.progress({}).with(fn);
}
async function progressIfConf<T>(cond: boolean, fn: () => Promise<T>) {
  if (_displayInfo && cond) {
    return await progress(fn);
  } else {
    return await fn();
  }
}

async function retrieveBareRepoPath(): Promise<string> {
  return await $`git rev-parse --path-format=absolute --git-common-dir`.text();
}

async function retrieveMainBranch(): Promise<string> {
  return Deno.env.get("GIT_WP_MAIN_BRANCH") ??
    await $`git config init.defaultBranch`.text() ?? "main";
}

async function retrieveMainWorktree(): Promise<string | undefined> {
  const mainBranch = await retrieveMainBranch();
  return findExistingWorktreeByBranch(
    mainBranch,
    await listWorktrees(),
  );
}

async function retrieveCurrentBranch(worktree?: string): Promise<string> {
  const cmd = $`git rev-parse --git-dir`;
  const gitDir = await (worktree === undefined ? cmd : cmd.cwd(worktree))
    .text();
  const rebaseHead = path.join(gitDir, "rebase-merge", "head-name");
  if (await exists(rebaseHead)) {
    return await Deno.readTextFile(rebaseHead);
  }
  return await $`git branch --show-current`.cwd(gitDir).text();
}

async function retrieveCurrentWorktree(): Promise<string> {
  return await $`git rev-parse --show-toplevel`.text();
}

async function retrieveProjectName(): Promise<string> {
  return await $`git config workspace.project-name`.text();
}

async function initWorkspace(projectName: string) {
  const mainBranch = await retrieveMainBranch();

  if (WORKTREES_DIRNAME === BARE_REPO_DIRNAME) {
    die(
      1,
      `Worktrees directory cannot be the same as the bare repo (${BARE_REPO_DIRNAME})`,
    );
  }

  const isEmpty = (await $`ls`.text()).trim().length === 0;

  if (isEmpty) {
    // no checks needed
  } else if (await exists(BARE_REPO_DIRNAME, { isDirectory: true })) {
    die(1, `Directory ${BARE_REPO_DIRNAME} already exists`);
  } else if (await exists(WORKTREES_DIRNAME, { isDirectory: true })) {
    die(1, `Directory ${WORKTREES_DIRNAME} already exists`);
  }

  info(`Creating base directies...`);
  await progress(async () => {
    await Deno.mkdir(BARE_REPO_DIRNAME, { recursive: true });
    await Deno.mkdir(WORKTREES_DIRNAME, { recursive: true });
  });

  const mainPath = path.join(Deno.cwd(), WORKTREES_DIRNAME, mainBranch);

  info(`Initializing workspace...`);
  await progress(async () => {
    await $`git init --bare`.cwd(BARE_REPO_DIRNAME);

    await $`git config workspace.project-name ${projectName}`
      .cwd(BARE_REPO_DIRNAME);
  });

  info(`Creating worktree for main branch...`);
  await progress(async () => {
    await $`git worktree add --orphan -b ${mainBranch} ${mainPath}`.cwd(
      BARE_REPO_DIRNAME,
    );
  });

  await initConfig(mainPath);

  info(`Creating first commit...`);
  await progress(async () => {
    await $`git commit --allow-empty -m "init"`.cwd(mainPath);
  });

  if (!isEmpty) {
    info(`Moving existing files into main worktree...`);
    await progress(async () => {
      for await (const file of Deno.readDir(Deno.cwd())) {
        if ([BARE_REPO_DIRNAME, WORKTREES_DIRNAME].includes(file.name)) {
          continue;
        }

        await Deno.rename(file.name, path.join(mainPath, file.name));
      }
    });
  }
}

type WorktreeListItem =
  & {
    readonly worktree: string;
  }
  & ({
    readonly HEAD: string;
    readonly branch: string;
    readonly bare: false;
    readonly detached: false;
  } | {
    readonly bare: true;
    readonly detached: false;
  } | {
    readonly bare: false;
    readonly detached: true;
  });
const WorktreeListItemSchema: z.ZodType<
  WorktreeListItem,
  z.ZodTypeDef,
  unknown
> = z.union([
  z.object({
    worktree: z.string().min(1),
    HEAD: z.string().min(1),
    branch: z.string().min(1),
    bare: z.literal(false).default(false),
    detached: z.literal(false).default(false),
  }),
  z.object({
    worktree: z.string().min(1),
    bare: z.literal(true),
    detached: z.literal(false).default(false),
  }),
  z.object({
    worktree: z.string().min(1),
    bare: z.literal(false).default(false),
    detached: z.literal(true),
  }),
]);

async function listWorktrees(): Promise<WorktreeListItem[]> {
  const output = await $`git worktree list --porcelain`.lines();

  const listing = new Array<WorktreeListItem>();
  let current: Record<string, string | boolean> | undefined = {};
  for (const line of output) {
    if (line.length === 0) {
      if (current !== undefined) {
        listing.push(current as unknown as WorktreeListItem);
      }
      current = {};
      continue;
    }

    const [field, value] = line.split(" ");

    switch (field) {
      case "worktree":
        current.worktree = value;
        break;
      case "HEAD":
        current.HEAD = value;
        break;
      case "branch":
        current.branch = value;
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
      default:
        throw new Error(`Unknown field from git worktree list: ${line}`);
    }
  }
  if (current !== undefined && Object.keys(current).length > 0) {
    listing.push(WorktreeListItemSchema.parse(current));
  }

  return listing;
}

function fullBranchName(branch: string): string {
  return `refs/heads/${branch.replace(/^refs\/heads\//, "")}`;
}

function findExistingWorktreeByBranch(
  branch: string,
  worktreeItems: WorktreeListItem[],
): string | undefined {
  const fullname = fullBranchName(branch);
  const worktreeItem = worktreeItems.find((item) =>
    !item.bare && !item.detached && item.branch === fullname
  );
  return worktreeItem?.worktree;
}

// function findExistingWorktree(
//   branchOrPath: string,
//   worktreeItems: WorktreeListItem[],
// ): string | undefined {
//   const fullname = `refs/heads/${branchOrPath.replace(/^refs\/heads\//, "")}`;
//   const worktreeItem = worktreeItems.find((item) =>
//     !item.bare && !item.detached &&
//     (item.branch === fullname || item.worktree === branchOrPath)
//   );
//   return worktreeItem?.worktree;
// }

function checkWorktreeExists(
  worktree: string,
  worktreeItems: WorktreeListItem[],
): void {
  const exists = worktreeItems.some((item) => item.worktree === worktree);
  if (!exists) die(1, `Worktree ${worktree} not found`);
}

interface CreateWorktreeOptions {
  readonly nocheck?: boolean;
}
async function createWorktree(
  currentWorktree: string,
  branch: string,
  { nocheck = false }: CreateWorktreeOptions = {},
): Promise<string> {
  if (!nocheck) {
    const worktree = findExistingWorktreeByBranch(
      branch,
      await listWorktrees(),
    );
    if (worktree !== undefined) {
      die(1, `Worktree for ${branch} already exists`);
    }
  }

  const mainBranch = await retrieveMainBranch();
  const mainWorktree = findExistingWorktreeByBranch(
    mainBranch,
    await listWorktrees(),
  );

  if (mainWorktree === undefined) {
    die(1, `Main branch ${mainBranch} not found`);
  }

  const worktree = mainWorktree.replace(mainBranch, branch);
  info(`Creating worktree for ${branch}...`);
  await progress(async () => {
    if ((await $`git branch --list ${branch}`.text()).trim().length === 0) {
      await $`git worktree add -b ${branch} ${worktree}`;
    } else {
      await $`git worktree add ${worktree} ${branch}`;
    }
  });

  // TODO
  info(`Copying dz config...`);
  await progress(async () => {
    const existingConfig = await Deno.open(
      path.join(currentWorktree, Config.CONFIG_FILENAME),
    );
    await Deno.writeFile(
      path.join(worktree, Config.CONFIG_FILENAME),
      existingConfig.readable,
    );
  });

  return worktree;
}

async function openTab(path: string, name: string): Promise<string> {
  const projectName = await retrieveProjectName();
  const tabname = projectName ? `${projectName}:${name}` : name;
  if (Deno.env.get("TERM_PROGRAM") === "WezTerm") {
    const paneId = await $`wezterm cli spawn --cwd ${path}`.text();
    await $`wezterm cli set-tab-title --pane-id ${paneId} ${tabname}`;
    return paneId;
  } else {
    die(1, "Can't open tabs in this terminal");
  }
}

async function closeTab(): Promise<string> {
  if (Deno.env.get("TERM_PROGRAM") === "WezTerm") {
    return await $`wezterm cli kill-pane`.text();
  } else {
    die(1, "Can't close tabs in this terminal");
  }
}

async function openWorktree(currentWorktree: string, branch: string) {
  const worktree = findExistingWorktreeByBranch(branch, await listWorktrees());
  if (worktree === undefined) {
    const createdWorktree = await createWorktree(currentWorktree, branch, {
      nocheck: true,
    });
    await openTab(createdWorktree, branch);
  } else {
    await openTab(worktree, branch);
  }
}

interface DeleteWorkspaceOptions {
  readonly force?: boolean;
  readonly deleteBranch?: boolean;
  readonly forceDeleteBranch?: boolean;
}
async function deleteWorktree(
  worktree: string,
  mainWorktree: string | undefined,
  options?: DeleteWorkspaceOptions,
) {
  checkWorktreeExists(worktree, await listWorktrees());

  const branch = options?.deleteBranch || options?.forceDeleteBranch
    ? await retrieveCurrentBranch(worktree)
    : undefined;
  if (
    mainWorktree !== undefined &&
    branch !== undefined &&
    options?.deleteBranch &&
    !options?.forceDeleteBranch
  ) {
    // must be performed on main worktree since it must be compared to the main branch
    const deletableBranches =
      await $`git branch --list --format '%(refname)' --merged`.cwd(
        mainWorktree,
      ).lines();
    if (!deletableBranches.some((b) => b.trim() === fullBranchName(branch))) {
      die(1, `Branch ${branch} is not fully merged`);
    }
  }

  const cwd = mainWorktree ?? await retrieveBareRepoPath();
  Deno.chdir(cwd);

  info(`Deleting worktree`, `${worktree}...`);
  await progress(async () => {
    if (options?.force) {
      await $`git worktree remove --force ${worktree}`;
    } else {
      await $`git worktree remove ${worktree}`;
    }
    if (
      branch !== undefined &&
      (options?.deleteBranch || options?.forceDeleteBranch)
    ) {
      if (options?.forceDeleteBranch) {
        await $`git branch -D ${branch}`;
      } else {
        await $`git branch -d ${branch}`;
      }
    }
  });
}

interface WorktreeActionOptions {
  worktree: string | undefined;
  actionName: string;
  args: string[];
  config: Config.Config;
  nested?: boolean;
  env?: Record<string, string | undefined>;
}
async function worktreeAction(options: WorktreeActionOptions) {
  const {
    worktree,
    actionName,
    args,
    config,
    nested = false,
    env = {
      DZ_WORKTREE: worktree,
      DZ_BRANCH: await retrieveCurrentBranch(worktree),
      DZ_ACTION: actionName,
      DZ_PROJECT: await retrieveProjectName(),
    },
  } = options;
  if (!nested && worktree !== undefined) Deno.chdir(worktree);

  const action = config[actionName];
  if (action === undefined) {
    die(
      1,
      `No config found for action "${actionName}" in worktree ${worktree}`,
    );
  }

  if (nested) {
    emptyLog();
    note(`Performing action "${actionName}"`);
  } else {
    info(`Performing action "${actionName}"`, `on worktree ${worktree}...`);
  }
  await progressIfConf(!nested, async () => {
    for (const [idx, task] of action.tasks.entries()) {
      try {
        if (task.type === "action") {
          await worktreeAction({
            ...options,
            actionName: task.action,
            args: task.args ?? args,
            nested: true,
            env,
          });
        } else if (task.type === "bash") {
          const cmd = $`bash`.env({ ...env, DZ_ACTION: actionName }).stdinText(`
            function action() {
              ${task.script}
            }
            action ${args.map($.escapeArg).join(" ")}
          `).spawn();
          const killCmd = () => cmd.kill("SIGINT");
          Deno.addSignalListener("SIGINT", killCmd);
          await cmd;
          Deno.removeSignalListener("SIGINT", killCmd);
        } else {
          die(1, `Unknown task type: ${JSON.stringify(task)}`);
        }
      } catch (err) {
        if (task.stop_on_error === false) {
          emptyLog();
          warn(`Ignored error happening while performing task #${idx}`, err);
        } else {
          throw err;
        }
      }
    }
  });
}

async function initConfig(workspace: string): Promise<void> {
  info(`Create default dz config...`);
  await progress(async () => {
    await Deno.writeTextFile(
      path.join(workspace, Config.CONFIG_FILENAME),
      Config.DEFAULT_CONFIG,
    );
  });
}

interface CopyConfigOptions {
  readonly from: string;
  readonly force?: boolean;
}
async function copyConfig(
  workspace: string,
  { from, force = false }: CopyConfigOptions,
) {
  const configPath = path.join(workspace, Config.CONFIG_FILENAME);
  if (!force && await exists(configPath)) {
    die(
      1,
      `Config file already exists at ${configPath}`,
    );
  }
  const origConfigPath = path.join(from, Config.CONFIG_FILENAME);

  info(`Copying config`, `from ${from}...`);
  await progress(async () => {
    await Deno.copyFile(origConfigPath, configPath);
  });
}

// deno-lint-ignore no-namespace
namespace Config {
  export const CONFIG_FILENAME = "dz.config.yml";

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
    }).transform(({ action }) => ({ type: "action" as const, action })),
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
action1:
  tasks:
    - action: action2
    - type: action
      args: --foo
      action: action3

action2:
  tasks:
    - bash: |
        echo "This is action 2, called with $*"

action3:
  tasks:
    - type: bash
      stop_on_error: false
      script: |
        echo "This is action 3"

"tab:title":
  tasks:
    - bash: |
        wezterm cli set-tab-title "\${DZ_PROJECT}:\${DZ_BRANCH}"
`);
}

async function readConfig(worktree?: string): Promise<Config.Config> {
  const configPath = worktree
    ? path.join(worktree, Config.CONFIG_FILENAME)
    : path.join(Deno.cwd(), Config.CONFIG_FILENAME);

  const fileContent = await exists(configPath, { isFile: true }) &&
    await Deno.readTextFile(configPath);

  if (!fileContent) {
    die(1, `Config file not found at ${configPath}`);
  }

  const parsed = parseYaml(fileContent);

  return Config.ConfigSchema.parse(parsed);
}

if (import.meta.main) {
  try {
    const { _: [cmd, ...rest], quiet, worktree } = parseArgs(Deno.args, {
      stopEarly: true,
      string: ["worktree"],
      boolean: ["quiet"],
      alias: {
        "wk": "worktree",
        "q": "quiet",
      },
    });
    if (cmd === undefined) {
      die(1, "Missing command");
    }
    const args = rest.map((a) => a.toString());

    if (quiet) {
      displayInfo(false);
    }

    if (cmd === "init") {
      const projectName = Deno.args.at(1) ?? die(1, "Missing project name");
      await initWorkspace(projectName);
    } else {
      const mainWorktree = await retrieveMainWorktree();
      const currentWorktree = await retrieveCurrentWorktree();
      const config = await readConfig(worktree ?? currentWorktree);

      const WorktreeActions = Object.keys(config);
      const isWorktreeAction = (action: string | number): action is string => {
        return WorktreeActions.includes(action as string);
      };

      if (cmd === "add") {
        const branch = Deno.args.at(1) ?? die(1, "Missing branch name");
        await createWorktree(currentWorktree, branch);
      } else if (cmd === "open") {
        const branch = Deno.args.at(1) ?? die(1, "Missing branch name");
        await openWorktree(currentWorktree, branch);
      } else if (cmd === "delete") {
        const {
          force,
          ["delete-branch"]: deleteBranch,
          ["force-delete-branch"]: forceDeleteBranch,
        } = parseArgs(args, {
          boolean: ["force", "delete-branch", "force-delete-branch"],
          negatable: ["force", "delete-branch", "force-delete-branch"],
          alias: {
            f: "force",
            d: "delete-branch",
            D: "force-delete-branch",
          },
        });

        await deleteWorktree(
          worktree ?? currentWorktree,
          mainWorktree,
          { force, deleteBranch, forceDeleteBranch },
        );

        if (worktree === undefined) {
          await closeTab();
        }
      } else if (cmd === "config:init") {
        await initConfig(worktree ?? currentWorktree);
      } else if (cmd === "config:copy") {
        const { _: [from], force } = parseArgs(args, {
          boolean: ["force"],
          negatable: ["force"],
          alias: {
            f: "force",
          },
        });
        const fromWorktree = from ? from.toString() : mainWorktree;
        if (fromWorktree === undefined) {
          die(1, "Missing source worktree");
        }
        const toWorktree = worktree ?? currentWorktree;
        if (fromWorktree === toWorktree) {
          die(1, "Cannot copy config from current worktree");
        }

        await copyConfig(toWorktree, { from: fromWorktree, force });
      } else if (cmd === "action") {
        const { _: [action, ...rest] } = parseArgs(args, { stopEarly: true });
        await worktreeAction({
          worktree: worktree ?? currentWorktree,
          actionName: action.toString(),
          args: rest.map((a) => a.toString()),
          config,
        });
      } else if (isWorktreeAction(cmd)) {
        await worktreeAction({
          worktree: worktree ?? currentWorktree,
          actionName: cmd,
          args,
          config,
        });
      } else {
        die(1, `Unknown command: "${cmd}"`);
      }
    }
  } catch (err) {
    die(3, err as string);
  }
}
