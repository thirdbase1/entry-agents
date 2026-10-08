import { Boxd } from "@boxd-sh/sdk";
import type { ConnectOptions } from "../factory.ts";
import type { Sandbox } from "../interface.ts";
import { BOXD_DISK, BOXD_MEMORY, BOXD_VCPU, BOXD_WORKING_DIRECTORY, isBoxdConfigured } from "./config.ts";
import type { BoxdState } from "./state.ts";
import { BoxdSandbox } from "./sandbox.ts";

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
      isolated: true,
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
  return new BoxdSandbox(client, machine.id, machine.name, options);
}
