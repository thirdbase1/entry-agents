import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gradeSolution, loadHumanEvalSubset } from "./humaneval-runner";

async function writeSolution(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grade-solution-test-"));
  const solutionPath = path.join(dir, "solution.py");
  await fs.writeFile(solutionPath, content, "utf-8");
  return solutionPath;
}

describe("loadHumanEvalSubset", () => {
  test("loads a fixed 20-task subset with the fields grading needs", () => {
    const tasks = loadHumanEvalSubset();
    expect(tasks.length).toBe(20);
    for (const task of tasks) {
      expect(task.task_id).toMatch(/^HumanEval\/\d+$/);
      expect(typeof task.prompt).toBe("string");
      expect(typeof task.entry_point).toBe("string");
      expect(typeof task.canonical_solution).toBe("string");
      expect(typeof task.test).toBe("string");
    }
  });

  test("subset has no duplicate task ids", () => {
    const tasks = loadHumanEvalSubset();
    const ids = new Set(tasks.map((t) => t.task_id));
    expect(ids.size).toBe(tasks.length);
  });
});

describe("gradeSolution", () => {
  test("passes the real canonical solution for every task in the subset", async () => {
    const tasks = loadHumanEvalSubset();
    for (const task of tasks) {
      const solutionPath = await writeSolution(
        task.prompt + task.canonical_solution,
      );
      const grade = await gradeSolution(solutionPath, task);
      expect(grade.passed).toBe(true);
      await fs.rm(path.dirname(solutionPath), {
        recursive: true,
        force: true,
      });
    }
  });

  test("fails a deliberately wrong solution", async () => {
    const tasks = loadHumanEvalSubset();
    const task = tasks[0];
    const wrongSolution = task.prompt.replace(
      /def\s+\w+\([\s\S]*?\):/,
      (match) => `${match}\n    return None`,
    );
    const solutionPath = await writeSolution(wrongSolution);
    const grade = await gradeSolution(solutionPath, task);
    expect(grade.passed).toBe(false);
    expect(grade.errorMessage).toBeDefined();
    await fs.rm(path.dirname(solutionPath), { recursive: true, force: true });
  });

  test("fails cleanly with a clear message when solution.py was never created", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "grade-solution-missing-"),
    );
    const grade = await gradeSolution(
      path.join(dir, "solution.py"),
      loadHumanEvalSubset()[0],
    );
    expect(grade.passed).toBe(false);
    expect(grade.errorMessage).toContain("never created");
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("fails cleanly on a syntax error in the candidate file", async () => {
    const solutionPath = await writeSolution("def broken(:\n    pass");
    const grade = await gradeSolution(solutionPath, loadHumanEvalSubset()[0]);
    expect(grade.passed).toBe(false);
    await fs.rm(path.dirname(solutionPath), { recursive: true, force: true });
  });
});
