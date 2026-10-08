export type BenchmarkTrack = {
  key:
    | "swebench_verified"
    | "terminal_bench"
    | "livecodebench"
    | "aider_polyglot";
  name: string;
  shortName: string;
  description: string;
  metric: string;
  source: string;
  color: string;
};

export const BENCHMARK_TRACKS: BenchmarkTrack[] = [
  {
    key: "swebench_verified",
    name: "SWE-bench Verified",
    shortName: "SWE-bench",
    description: "Real GitHub issues validated by human reviewers.",
    metric: "Resolved issues",
    source: "https://www.swebench.com/",
    color: "#22c55e",
  },
  {
    key: "terminal_bench",
    name: "Terminal-Bench 2.0",
    shortName: "Terminal",
    description:
      "Long-horizon terminal tasks across real software environments.",
    metric: "Task success",
    source: "https://github.com/harbor-framework/terminal-bench",
    color: "#38bdf8",
  },
  {
    key: "livecodebench",
    name: "LiveCodeBench",
    shortName: "LiveCode",
    description: "Fresh coding problems designed to reduce contamination.",
    metric: "Pass@1",
    source: "https://livecodebench.github.io/",
    color: "#a78bfa",
  },
  {
    key: "aider_polyglot",
    name: "Aider Polyglot",
    shortName: "Polyglot",
    description:
      "Repository editing tasks across multiple programming languages.",
    metric: "Tests passing",
    source: "https://aider.chat/docs/leaderboards/",
    color: "#f59e0b",
  },
];
