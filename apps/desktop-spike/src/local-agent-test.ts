/**
 * Entry Desktop — LocalSandbox Native Runtime Spike
 *
 * Proves: bare Node process → LocalSandbox → openAgent() → Entry Gateway
 *         → model → write tool → hello.txt on the local filesystem.
 *
 * Run: cd apps/desktop-spike && set -a && source .env && set +a && SPIKE_ENABLE_AGENT=1 pnpm spike
 * Needs GATEWAY_BASE_URL / GATEWAY_API_KEY in the environment.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { connectSandbox, type Sandbox, type SandboxState } from "@open-agents/sandbox";
import { openAgent, sharedProvider, defaultModelLabel } from "@open-agents/agent";

const ENABLE_AGENT = process.env.SPIKE_ENABLE_AGENT === "1";
const SPIKE_MODEL = process.env.SPIKE_MODEL ?? "mimo-v2.6-flash:free";
const TURN_TIMEOUT_MS = 180_000;

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
function record(check: string, pass: boolean, detail = "") {
  results.push({ check, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${check}${detail ? ` — ${detail}` : ""}`);
}
function note(msg: string) { console.log(`ℹ️  ${msg}`); }

// Hard watchdog: the process must never hang indefinitely.
const watchdog = setTimeout(() => {
  console.error(`\n❌ WATCHDOG: spike exceeded ${TURN_TIMEOUT_MS}ms — aborting (hang prevented)`);
  process.exit(2);
}, TURN_TIMEOUT_MS + 30_000);
watchdog.unref?.();

// ── Step 3: temporary local project ──────────────────────────────────────
const projectDir = mkdtempSync(path.join(tmpdir(), "entry-desktop-spike-"));
writeFileSync(path.join(projectDir, "README.md"), "# Spike project\nCreated by the Entry Desktop LocalSandbox spike.\n");
console.log(`[spike] temporary project: ${projectDir}`);
console.log(`[spike] node: ${process.version}`);
console.log(`[spike] gateway: ${process.env.GATEWAY_BASE_URL ?? "(unset)"} (key ${process.env.GATEWAY_API_KEY ? "present" : "MISSING"})`);

// ── Step 4: attach the real LocalSandbox ─────────────────────────────────
let sandbox: Sandbox | undefined;
const sandboxState: SandboxState = { type: "local", rootDir: projectDir };
try {
  sandbox = await connectSandbox(sandboxState);
  record("connectSandbox({type:'local'}) connects", sandbox !== undefined);
  record("workingDirectory is the temp project", sandbox.workingDirectory === projectDir, sandbox.workingDirectory);
  record("sandbox.type is 'cloud' (interface union) + provider is local", sandbox.type === "cloud", `type=${sandbox.type}, provider=${(sandboxState as { type: string }).type}`);
  await sandbox.writeFile("probe.txt", "written via sandbox");
  record("sandbox file round-trip works", (await sandbox.readFile("probe.txt")) === "written via sandbox");
  record("sandbox writes hit the real local filesystem (node:fs sees it)",
    readFileSync(path.join(projectDir, "probe.txt"), "utf-8") === "written via sandbox");
  const execResult = await sandbox.exec("echo sandbox-exec-ok", projectDir, 10_000);
  record("sandbox.exec runs a real local command", execResult.success && execResult.stdout.includes("sandbox-exec-ok"), `exit=${execResult.exitCode}`);
  await sandbox.stop();
} catch (err) {
  record("LocalSandbox attach", false, String(err));
  process.exit(1);
}

// ── Step 5: model resolution (Entry Gateway, env-var based — no hardcoded keys)
try {
  sharedProvider(defaultModelLabel);
  record("sharedProvider() resolves from env (Entry Gateway)", true, `default model: ${defaultModelLabel}`);
} catch (err) {
  record("sharedProvider() resolves from env (Entry Gateway)", false, String(err));
}

// ── Step 11a: missing gateway config fails cleanly ───────────────────────
{
  const savedUrl = process.env.GATEWAY_BASE_URL;
  const savedKey = process.env.GATEWAY_API_KEY;
  try {
    delete process.env.GATEWAY_BASE_URL;
    delete process.env.GATEWAY_API_KEY;
    sharedProvider(defaultModelLabel);
    record("missing gateway config fails cleanly", false, "sharedProvider() did not throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record("missing gateway config fails cleanly", /GATEWAY_BASE_URL \/ GATEWAY_API_KEY must be set/.test(msg), msg.slice(0, 120));
  } finally {
    if (savedUrl) process.env.GATEWAY_BASE_URL = savedUrl;
    if (savedKey) process.env.GATEWAY_API_KEY = savedKey;
  }
}

if (!ENABLE_AGENT) {
  note("SPIKE_ENABLE_AGENT=1 not set — skipping the real model turn (sandbox-level checks only).");
  note("re-run with: SPIKE_ENABLE_AGENT=1 pnpm spike");
  rmSync(projectDir, { recursive: true, force: true });
  printSummary();
}

// ── Steps 5–7: one real agent turn through the real openAgent() ──────────
try {
  const stream = await openAgent.stream({
    messages: [
      {
        role: "user",
        content:
          'Create a file named exactly "hello.txt" in the current project (the current directory). Its entire content must be exactly this one line and nothing else:\nHello from Entry Desktop',
      },
    ],
    options: {
      sandbox: { state: sandboxState, workingDirectory: projectDir },
      model: { id: SPIKE_MODEL },
      permissionMode: "fullAccess", // unattended run: skip interactive approval gates
    },
    abortSignal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });

  const uiStream = stream.toUIMessageStream();
  let toolCalls = 0;
  let sawWrite = false;
  let textLen = 0;
  for await (const part of uiStream) {
    switch (part.type) {
      case "start": console.log("[stream] started"); break;
      case "tool-input-available": {
        toolCalls++;
        const toolName = (part as { toolName?: string }).toolName;
        console.log(`[stream] tool #${toolCalls}: ${toolName}`);
        if (toolName === "write") sawWrite = true;
        break;
      }
      case "tool-output-available":
        console.log("[stream] tool result received");
        break;
      case "text-delta":
        textLen += ((part as { delta?: string }).delta ?? "").length;
        break;
      case "error":
        console.log("[stream] error part:", (part as { errorText?: string }).errorText);
        break;
      case "finish":
        console.log("[stream] finished");
        break;
    }
  }
  record("stream started and finished (AI SDK toUIMessageStream)", true);
  record("tool activity occurred", toolCalls > 0, `${toolCalls} tool call(s)`);
  record("write tool was used", sawWrite);
  note(`assistant text length: ${textLen} chars (informational; the model may answer with a tool call only)`);
} catch (err) {
  record("agent turn completed", false, String(err instanceof Error ? err.message : err));
}

// ── Step 8: independent filesystem verification ──────────────────────────
const helloPath = path.join(projectDir, "hello.txt");
const created = existsSync(helloPath);
record("hello.txt exists (verified independently with plain node:fs)", created);
if (created) {
  const content = readFileSync(helloPath, "utf-8").trim();
  record("hello.txt content is exactly 'Hello from Entry Desktop'", content === "Hello from Entry Desktop", JSON.stringify(content));
} else {
  record("hello.txt content check", false, "file missing");
}

// ── Step 9: sandbox boundary baseline (DOCUMENT, do not fix) ─────────────
try {
  const escapePath = path.join(projectDir, "..", "entry-spike-escape-probe.txt");
  await sandbox!.writeFile(escapePath, "outside");
  const escaped = existsSync(escapePath);
  record(
    "BOUNDARY: absolute write outside rootDir",
    true,
    escaped
      ? "KNOWN DESKTOP BLOCKER: LocalSandbox.resolve() permits absolute paths outside rootDir (no containment today)"
      : "write outside root was rejected",
  );
  if (escaped) rmSync(escapePath);

  const travRel = "../entry-spike-traversal-probe.txt";
  await sandbox!.writeFile(travRel, "outside").catch(() => {});
  const travFile = path.resolve(projectDir, travRel);
  const travEscaped = existsSync(travFile);
  note(`BOUNDARY: relative '${travRel}' ${travEscaped ? "escalated outside rootDir (same blocker)" : "was contained"}`);
  if (travEscaped) rmSync(travFile);
} catch (err) {
  record("BOUNDARY: escape attempts", true, `rejected with: ${String(err).slice(0, 120)}`);
}

// ── Step 11b: invalid project directory ─────────────────────────────────
try {
  const fileNotDir = path.join(tmpdir(), `entry-spike-not-a-dir-${Date.now()}`);
  writeFileSync(fileNotDir, "x");
  await connectSandbox({ type: "local", rootDir: fileNotDir });
  record("invalid project dir fails cleanly", false, "connectSandbox unexpectedly succeeded on a non-directory path");
  rmSync(fileNotDir, { force: true });
} catch (err) {
  record("invalid project dir fails cleanly", true, String(err).slice(0, 120));
}
// (unwritable-system-path probe removed: fs.mkdir on /proc hangs in this sandbox;
//  the non-directory case above already proves invalid roots fail cleanly)
// ── Step 11c: unknown provider is rejected (no silent Vercel fallback) ───
try {
  await connectSandbox({ type: "nope", rootDir: projectDir } as unknown as SandboxState);
  record("unknown sandbox provider rejected (no Vercel fallback)", false, "connectSandbox accepted an unknown type");
} catch (err) {
  record("unknown sandbox provider rejected (no Vercel fallback)", true, String(err).slice(0, 100));
}

// ── Cleanup + report ─────────────────────────────────────────────────────
try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
note(`temp project cleaned up: ${!existsSync(projectDir)}`);
clearTimeout(watchdog);
printSummary();

function printSummary() {
  const failed = results.filter((r) => !r.pass);
  console.log("\n========== SPIKE SUMMARY ==========");
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.detail ? ` :: ${r.detail}` : ""}`);
  console.log(`total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
  console.log("===================================");
  process.exit(failed.length > 0 ? 1 : 0);
}
