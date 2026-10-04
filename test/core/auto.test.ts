import { describe, expect, it } from "vitest";
import { CLASSIFIER_SYSTEM_PROMPT, classifyTask, routeFor } from "../../src/core/auto";
import { ScriptedModelClient } from "../support/scripted-model";

describe("auto mode: sorting a turn", () => {
  it("asks the small model with no tools and reads its one word", async () => {
    const model = new ScriptedModelClient([{ text: "Complex." }, { text: "daily" }]);
    expect(await classifyTask(model, "Redesign the session store")).toBe("complex");
    expect(await classifyTask(model, "Rename a variable")).toBe("daily");
    expect(model.requests[0]).toMatchObject({
      model: "deepseek-ai/deepseek-v4-flash",
      reasoning: "none",
      tools: [],
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: "Redesign the session store" },
      ],
    });
  });

  it("is daily when the answer is unclear, empty, or the call fails; a long task is cut", async () => {
    const model = new ScriptedModelClient([{ text: "maybe" }, {}, new Error("down"), { text: "daily" }]);
    expect(await classifyTask(model, "a")).toBe("daily");
    expect(await classifyTask(model, "b")).toBe("daily");
    expect(await classifyTask(model, "c")).toBe("daily");
    await classifyTask(model, "x".repeat(10_000));
    expect(model.requests.at(-1)!.messages[1]!.content).toHaveLength(4000);
  });

  it("routes daily to deepseek-v4-flash high and complex to deepseek-v4.1-flash high", () => {
    expect(routeFor("daily")).toEqual({ model: "deepseek-ai/deepseek-v4-flash", reasoning: "high" });
    expect(routeFor("complex")).toEqual({ model: "deepseek-ai/deepseek-v4.1-flash", reasoning: "high" });
  });
});
