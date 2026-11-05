// Run the maintainer inside a long-lived Node service.
//   npm install codemender-ai
import express from "express";
import { createAgent } from "codemender-ai";

const app = express();
const agent = createAgent({ root: process.cwd() });

// Trigger a run from an HTTP endpoint (protect this in real deployments).
app.post("/internal/codemender/run", async (_req, res) => {
  const summary = await agent.run({ limit: 5 });
  res.json({ completed: summary.results.filter((r) => r.result.success).length, total: summary.results.length });
});

// Or let it run every 30 minutes in the background.
const stop = agent.schedule(30 * 60 * 1000);
process.on("SIGTERM", stop);

app.listen(3000);
