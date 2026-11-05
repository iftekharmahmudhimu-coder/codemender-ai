import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemender-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

/** A scripted fake provider: each call pops the next response. */
export function fakeProvider(id, script, { failWith } = {}) {
  let calls = 0;
  return {
    id,
    provider: id.split("/")[0],
    model: id.split("/")[1],
    get calls() {
      return calls;
    },
    async chat() {
      calls += 1;
      if (failWith) throw failWith;
      const next = script.shift();
      if (!next) throw new Error(`fake provider ${id} ran out of script`);
      return { content: next, stopReason: next.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { input: 10, output: 5 }, servedBy: id };
    },
  };
}

export const silentLogger = { error() {}, warn() {}, info() {}, success() {}, step() {}, debug() {}, raw() {} };
