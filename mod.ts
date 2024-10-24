#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-run

import $ from "@david/dax";
import { parseArgs } from "@std/cli";
import { exists } from "@std/fs/exists";
import * as path from "@std/path/join";

import {
  die,
  displayInfo,
  emptyLog,
  info,
  note,
  progress,
  progressIfConf,
  warn,
} from "./_utils.ts";
import * as Config from "./config.ts";
import { readConfig } from "./config.ts";
import * as Git from "./git.ts";

interface InitWorkspaceOptions {
  readonly mainBranch?: string;
  readonly bareRepoDirname?: string;
  readonly worktreesDir?: string;
}
async function initWorkspace(
  projectName: string,
  options: InitWorkspaceOptions = {},
) {
  const mainBranch = options.mainBranch ?? await Git.retrieveMainBranch();
  const worktreeDirname =
    (options.worktreesDir ?? Deno.env.get("GIT_WP_BARE_REPO_NAME")) ||
    "bare.git";
  const bareRepoDirname =
    (options.bareRepoDirname ?? Deno.env.get("GIT_WP_WORKTREES_DIR")) || ".";

  if (worktreeDirname === bareRepoDirname) {
    die(
      1,
      `Worktrees directory cannot be the same as the bare repo (${bareRepoDirname})`,
    );
  }

  const isEmpty = (await $`\ls -a`.text()).trim().length === 0;

  if (isEmpty) {
    // no checks needed
  } else if (await exists(".git")) {
    die(
      1,
      `Directory is already a git repository. To convert it in a workspace, use convert)`,
    );
  } else if (await exists(bareRepoDirname, { isDirectory: true })) {
    die(1, `Directory ${bareRepoDirname} already exists`);
  } else if (
    worktreeDirname !== "." &&
    await exists(worktreeDirname, { isDirectory: true })
  ) {
    die(1, `Directory ${worktreeDirname} already exists`);
  }

  info(`Creating base directies...`);
  await progress(async () => {
    await Deno.mkdir(bareRepoDirname, { recursive: true });
    await Deno.mkdir(worktreeDirname, { recursive: true });
  });

  const mainPath = path.join(Deno.cwd(), worktreeDirname, mainBranch);

  info(`Initializing workspace...`);
  await progress(async () => {
    await $`git init --bare`.cwd(bareRepoDirname);

    await $`git config workspace.project-name ${projectName}`
      .cwd(bareRepoDirname);
  });

  info(`Creating worktree for main branch...`);
  await progress(async () => {
    await $`git worktree add --orphan -b ${mainBranch} ${mainPath}`.cwd(
      bareRepoDirname,
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
        if ([bareRepoDirname, worktreeDirname].includes(file.name)) {
          continue;
        }

        await Deno.rename(file.name, path.join(mainPath, file.name));
      }
    });
  }
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
    const worktree = await Git.retrieveWorktree(branch);
    if (worktree !== undefined) {
      die(1, `Worktree for ${branch} already exists`);
    }
  }

  const mainBranch = await Git.retrieveMainBranch();
  const mainWorktree = Git.findExistingWorktreeByBranch(
    mainBranch,
    await Git.listWorktrees(),
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
  const projectName = await Git.retrieveProjectName();
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
  const worktree = Git.findExistingWorktreeByBranch(
    branch,
    await Git.listWorktrees(),
  );
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
  readonly forceDeleteMain?: boolean;
}
async function deleteWorktree(
  worktree: string,
  mainWorktree: string | undefined,
  options?: DeleteWorkspaceOptions,
) {
  if (worktree === mainWorktree && !options?.forceDeleteMain) {
    die(1, "Cannot delete the main worktree");
  }

  const worktrees = await Git.listWorktrees();
  if (!worktrees.some((item) => item.worktree === worktree)) {
    die(1, `Worktree ${worktree} not found`);
  }

  const branch = options?.deleteBranch || options?.forceDeleteBranch
    ? await Git.retrieveCurrentBranch(worktree)
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
    if (
      !deletableBranches.some((b) => b.trim() === Git.fullBranchName(branch))
    ) {
      die(1, `Branch ${branch} is not fully merged`);
    }
  }

  const cwd = mainWorktree ?? await Git.retrieveBareRepoPath();
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
      DZ_BRANCH: await Git.retrieveCurrentBranch(worktree),
      DZ_ACTION: actionName,
      DZ_PROJECT: await Git.retrieveProjectName(),
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
  readonly force?: boolean;
}
async function copyConfig(
  fromWorktree: string,
  toWorktree: string,
  { force = false }: CopyConfigOptions = {},
) {
  const targetConfigPath = path.join(toWorktree, Config.CONFIG_FILENAME);
  if (!force && await exists(targetConfigPath)) {
    die(
      1,
      `Config file already exists at ${targetConfigPath}`,
    );
  }
  const origConfigPath = path.join(fromWorktree, Config.CONFIG_FILENAME);

  if (await exists(origConfigPath)) {
    info(`Copying config`, `from ${fromWorktree}...`);
    await progress(async () => {
      await Deno.copyFile(origConfigPath, targetConfigPath);
    });
  } else {
    note(`No config found at ${fromWorktree}`);
  }
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
    const args = rest.map((a) => a.toString());

    if (quiet) {
      displayInfo(false);
    }

    if (cmd === "init") {
      const projectName = Deno.args.at(1) ?? die(1, "Missing project name");
      await initWorkspace(projectName);
    } else {
      const mainWorktree = await Git.retrieveMainWorktree();
      if (mainWorktree === undefined) {
        die(1, "No main worktree found");
      }

      const currentWorktree = await Git.retrieveCurrentWorktree();
      const targetWorktree = worktree ?? currentWorktree;
      const config = await readConfig({ dir: worktree ?? currentWorktree });

      const WorktreeActions = Object.keys(config);
      const isWorktreeAction = (action: string | number): action is string => {
        return WorktreeActions.includes(action as string);
      };

      const Commands = [
        "init",
        "convert",
        "add",
        "open",
        "delete",
        "config:init",
        "config:copy",
        "action",
        ...WorktreeActions,
      ];

      if (cmd === "add") {
        const branch = Deno.args.at(1) ?? die(1, "Missing branch name");
        await createWorktree(targetWorktree, branch);
      } else if (cmd === "open") {
        const branch = Deno.args.at(1) ?? die(1, "Missing branch name");
        await openWorktree(targetWorktree, branch);
      } else if (cmd === "delete") {
        const {
          force,
          ["delete-branch"]: deleteBranch,
          ["force-delete-branch"]: forceDeleteBranch,
          ["force-delete-main"]: forceDeleteMain,
        } = parseArgs(args, {
          boolean: [
            "force",
            "delete-branch",
            "force-delete-branch",
            "force-delete-main",
          ],
          negatable: [
            "force",
            "delete-branch",
            "force-delete-branch",
            "force-delete-main",
          ],
          alias: {
            f: "force",
            d: "delete-branch",
            D: "force-delete-branch",
            M: "force-delete-main",
          },
        });

        if (targetWorktree === undefined) {
          die(1, "Could not find the worktree to delete");
        }

        await deleteWorktree(
          targetWorktree,
          mainWorktree,
          { force, deleteBranch, forceDeleteBranch, forceDeleteMain },
        );

        if (worktree === undefined) {
          await closeTab();
        }
      } else if (cmd === "config:init") {
        await initConfig(targetWorktree);
      } else if (cmd === "config:copy") {
        const { from, to, force } = parseArgs(args, {
          string: ["from", "to"],
          boolean: ["force"],
          negatable: ["force"],
          alias: {
            f: "force",
          },
        });
        let fromWorktree: string, toWorktree: string;
        if (from && to) {
          fromWorktree = await Git.retrieveWorktree(from.toString()) ??
            die(1, "Could not find the worktree to copy from");
          toWorktree = await Git.retrieveWorktree(to.toString()) ??
            die(1, "Could not find the worktree to copy to");
        } else if (from) {
          fromWorktree = await Git.retrieveWorktree(from.toString()) ??
            die(1, "Could not find the worktree to copy from");
          toWorktree = targetWorktree;
        } else if (to) {
          fromWorktree = targetWorktree;
          toWorktree = await Git.retrieveWorktree(to.toString()) ??
            die(1, "Could not find the worktree to copy to");
        } else {
          fromWorktree = mainWorktree;
          toWorktree = targetWorktree;
        }
        if (fromWorktree === toWorktree) {
          die(1, "Cannot copy config file to itself");
        }

        await copyConfig(fromWorktree, toWorktree, { force });
      } else if (cmd === "action") {
        const { _: [action, ...rest] } = parseArgs(args, { stopEarly: true });
        await worktreeAction({
          worktree: targetWorktree,
          actionName: action.toString(),
          args: rest.map((a) => a.toString()),
          config,
        });
      } else if (isWorktreeAction(cmd)) {
        await worktreeAction({
          worktree: targetWorktree,
          actionName: cmd,
          args,
          config,
        });
      } else {
        const msg = cmd ? `Unknown command: "${cmd}"` : "Missing command";
        die(1, `${msg}\n\nusage: git workspace ${Commands.join("|")}`);
      }
    }
  } catch (err) {
    die(3, err as string);
  }
}
