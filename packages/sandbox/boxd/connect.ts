import { Boxd } from "@boxd-sh/sdk";
import type { ConnectOptions } from "../factory.ts";
import type { Sandbox } from "../interface.ts";
import { BOXD_DISK, BOXD_MEMORY, BOXD_VCPU, BOXD_WORKING_DIRECTORY, isBoxdConfigured } from "./config.ts";
import type { BoxdState } from "./state.ts";
import { BoxdSandbox } from "./sandbox.ts";

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function bootstrapWorkspace(
  sandbox: BoxdSandbox,
  state: BoxdState,
  options?: ConnectOptions,
): Promise<void> {
  if (options?.skipGitWorkspaceBootstrap) {
    return;
  }

  const source = state.source;
  // Keep the repository credential in the machine environment rather than
  // embedding it in the remote URL or shell command. Git reads this config
  // from the environment for the duration of each clone/fetch only.
  const git = 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="Authorization: Bearer ${GITHUB_TOKEN:-}" git';
  if (source?.repo) {
    const branch = source.branch
      ? ` --branch ${shellEscape(source.branch)}`
      : "";
    const cloneCommand =
      `if [ -d ${shellEscape(`${BOXD_WORKING_DIRECTORY}/.git`)} ]; then ` +
      `${git} -C ${shellEscape(BOXD_WORKING_DIRECTORY)} fetch --all --prune && ` +
      (source.branch
        ? `${git} -C ${shellEscape(BOXD_WORKING_DIRECTORY)} checkout ${shellEscape(source.branch)}; `
        : "") +
      `else ${git} clone${branch} ${shellEscape(source.repo)} ${shellEscape(BOXD_WORKING_DIRECTORY)}; fi`;
    const result = await sandbox.exec(cloneCommand, BOXD_WORKING_DIRECTORY, 180_000);
    if (!result.success) {
      throw new Error(`Failed to prepare workspace: ${result.stderr.trim()}`);
    }

    if (source.newBranch) {
      const checkout = await sandbox.exec(
        `git checkout -B ${shellEscape(source.newBranch)}`,
        BOXD_WORKING_DIRECTORY,
        30_000,
      );
      if (!checkout.success) {
        throw new Error(`Failed to create branch: ${checkout.stderr.trim()}`);
      }
    }
  } else {
    const result = await sandbox.exec(
      `test -d ${shellEscape(`${BOXD_WORKING_DIRECTORY}/.git`)} || git init ${shellEscape(BOXD_WORKING_DIRECTORY)}`,
      BOXD_WORKING_DIRECTORY,
      30_000,
    );
    if (!result.success) {
      throw new Error(`Failed to initialize workspace: ${result.stderr.trim()}`);
    }
  }

  if (options?.gitUser) {
    const result = await sandbox.exec(
      `git config user.name ${shellEscape(options.gitUser.name)} && ` +
        `git config user.email ${shellEscape(options.gitUser.email)}`,
      BOXD_WORKING_DIRECTORY,
      30_000,
    );
    if (!result.success) {
      throw new Error(`Failed to configure git identity: ${result.stderr.trim()}`);
    }
  }
}

export async function connectBoxd(
  state: BoxdState & { sessionId: string },
  options?: ConnectOptions,
): Promise<Sandbox> {
  if (!isBoxdConfigured()) throw new Error("boxd is not configured: set BOXD_API_KEY or BOXD_TOKEN");
  const client = new Boxd();
  const name = state.machineName ?? `entry-${state.sessionId}`.slice(0, 48);
  let machine = state.machineId ? await client.machines.get(state.machineId).catch(() => null) : null;

  if (!machine) {
    machine = await client.machines.create({
      name,
      image: "ubuntu:24.04",
      // Use the default network so workspace commands have outbound internet
      // access for GitHub, package registries, web fetch, and model tooling.
      // The machine is still private to the workspace and has no public proxy.
      isolated: false,
      restartPolicy: "never",
      config: {
        vcpu: BOXD_VCPU,
        memory: BOXD_MEMORY,
        disk: BOXD_DISK,
        autoSuspendTimeout: 300,
        autoDestroyTimeout: 0,
        ssh: true,
      },
    });
    await client.machines.setAutoHibernateTimeout(machine.id, 900);
  } else if (machine.status === "stopped") {
    await client.machines.start(machine.id);
  } else if (machine.status === "hibernated") {
    await client.machines.wake(machine.id);
  } else if (machine.status === "suspended") {
    await client.machines.resume(machine.id);
  }

  await client.machines.waitUntilReady(machine.id);
  await client.machines.exec(machine.id, { command: ["mkdir", "-p", BOXD_WORKING_DIRECTORY] });
  const sandbox = new BoxdSandbox(client, machine.id, machine.name, options);
  await sandbox.setGitHubAuthToken(options?.githubToken);
  try {
    await bootstrapWorkspace(sandbox, state, options);
  } finally {
    await sandbox.setGitHubAuthToken(undefined);
  }
  return sandbox;
}
