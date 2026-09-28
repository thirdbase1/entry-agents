import "server-only";

/**
 * Workflow registration — the ONLY place workflow functions are taught to
 * the run engine. `start(fn, args)` resolves `fn` to a durable workflow id
 * by its function name (stable per code site), so every workflow function
 * Entry starts must appear here.
 *
 * Keeping this central means the id<->code mapping is auditable and the
 * registration happens at boot (before any route can start a run), not at
 * import time of whichever module happens to be loaded first.
 */

import { registerWorkflow } from "lightflow-engine";

import { runAgentWorkflow } from "@/app/workflows/chat";
import { sandboxLifecycleWorkflow } from "@/app/workflows/sandbox-lifecycle";
import { sandboxProvisioningWorkflow } from "@/app/workflows/sandbox-provisioning";
import { archiveSandboxStopWorkflow } from "@/app/workflows/archive-sandbox-stop";
import { runBenchmarkSuiteWorkflow } from "@/app/workflows/run-benchmarks";

export function registerEntryWorkflows(): void {
  registerWorkflow("runAgentWorkflow", runAgentWorkflow);
  registerWorkflow("sandboxLifecycleWorkflow", sandboxLifecycleWorkflow);
  registerWorkflow("sandboxProvisioningWorkflow", sandboxProvisioningWorkflow);
  registerWorkflow("archiveSandboxStopWorkflow", archiveSandboxStopWorkflow);
  registerWorkflow("runBenchmarkSuiteWorkflow", runBenchmarkSuiteWorkflow);
}
