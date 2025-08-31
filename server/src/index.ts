// Minimal boot just to prove the toolchain works.
// We'll replace this with real app wiring in Step 3.
const start = async () => {
  // Simulate async boot steps (env load, etc.) later.
  // For now: log and keep process alive.
  // eslint-disable-next-line no-console
  console.log("[FR] server toolchain online (C0-Step2).");
  // Keep the process alive so ts-node-dev can watch files.
  process.on("SIGINT", () => {
    // eslint-disable-next-line no-console
    console.log("\n[FR] shutting down...");
    process.exit(0);
  });
};

start();
