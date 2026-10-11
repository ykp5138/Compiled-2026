import { describe, expect, it } from "vitest";

process.env.MONGODB_URI = "";

describe("MongoDB document mapping", () => {
  it("split + join round-trips every recorded experiment exactly", async () => {
    const { splitExperiment, joinExperiment } = await import("../server/mongo");
    const { loadAllExperiments } = await import("../server/store");
    const runs = loadAllExperiments();
    for (const exp of runs) {
      const { experiment, candidates, rounds } = splitExperiment(exp);
      expect(experiment._id).toBe(exp.runId);
      expect(candidates.every((c) => c.runId === exp.runId)).toBe(true);
      // Simulate MongoDB returning documents in arbitrary order.
      const back = joinExperiment(JSON.parse(JSON.stringify(experiment)), [...candidates].reverse(), [...rounds].reverse());
      expect(back).toEqual(JSON.parse(JSON.stringify(exp)));
    }
  });

  it("redacts MongoDB credentials from logs and reports", async () => {
    const { redact } = await import("../server/config");
    expect(redact("failed mongodb+srv://alice:s3cret@cluster0.abc.mongodb.net/?x=1")).not.toContain("s3cret");
  });

  it("is disabled without MONGODB_URI", async () => {
    const { mongo } = await import("../server/mongo");
    expect(mongo.enabled).toBe(false);
    expect(mongo.status.kind).toBe("json");
  });
});
