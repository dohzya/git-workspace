#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-run

import $ from "@david/dax";
import { exists } from "@std/fs/exists";
import * as path from "@std/path/join";
import { z } from "zod";

export async function retrieveBareRepoPath(): Promise<string> {
  return await $`git rev-parse --path-format=absolute --git-common-dir`.text();
}

export async function retrieveMainBranch(): Promise<string> {
  return Deno.env.get("GIT_WP_MAIN_BRANCH") ??
    await $`git config init.defaultBranch`.text() ?? "main";
}

export async function retrieveWorktree(
  branch: string,
): Promise<string | undefined> {
  return findExistingWorktreeByBranch(
    branch,
    await listWorktrees(),
  );
}

export async function retrieveMainWorktree(): Promise<string | undefined> {
  const mainBranch = await retrieveMainBranch();
  return await retrieveWorktree(mainBranch);
}

export async function retrieveCurrentBranch(
  worktree?: string,
): Promise<string> {
  const cmd = $`git rev-parse --git-dir`;
  const gitDir = await (worktree === undefined ? cmd : cmd.cwd(worktree))
    .text();
  const rebaseHead = path.join(gitDir, "rebase-merge", "head-name");
  const branch = (await exists(rebaseHead))
    ? await Deno.readTextFile(rebaseHead)
    : await $`git branch --show-current`.cwd(gitDir).text();
  return branch.trim();
}

export async function retrieveCurrentWorktree(): Promise<string> {
  return await $`git rev-parse --show-toplevel`.text();
}

export async function retrieveProjectName(): Promise<string | undefined> {
  const name = (await $`git config workspace.project-name || true`.text())
    .trim();
  return name.length ? name : undefined;
}

export type WorktreeListItem =
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

export async function listWorktrees(): Promise<WorktreeListItem[]> {
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

export function fullBranchName(branch: string): string {
  return `refs/heads/${branch.replace(/^refs\/heads\//, "")}`;
}

export function findExistingWorktreeByBranch(
  branch: string,
  worktreeItems: WorktreeListItem[],
): string | undefined {
  const fullname = fullBranchName(branch);
  const worktreeItem = worktreeItems.find((item) =>
    !item.bare && !item.detached && item.branch === fullname
  );
  return worktreeItem?.worktree;
}

// export function findExistingWorktree(
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
