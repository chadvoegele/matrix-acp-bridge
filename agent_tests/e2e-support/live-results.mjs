export async function runIndependentCases(cases, execute) {
  const results = [];
  for (const scenario of cases) {
    try {
      results.push(await execute(scenario));
    } catch {
      results.push({
        name: scenario.name,
        setup: "FAILED",
        function: "SKIPPED",
        cleanup: "RETAINED",
        reason: "controller failure; inspect private evidence",
      });
    }
  }
  return results;
}

export function liveExitCode(results) {
  if (
    results.some((result) => result.setup === "FAILED" || result.function === "FAILED" || result.cleanup === "RETAINED")
  )
    return 1;
  return results.some((result) => result.setup === "BLOCKED" || result.function === "SKIPPED") ? 2 : 0;
}
