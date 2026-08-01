type CoepMode = "require-corp" | "credentialless";

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function detectCoepMode(): Promise<CoepMode> {
  try {
    const response = await fetch(`${window.location.pathname}${window.location.search}`, {
      cache: "no-store"
    });
    if (response.headers.get("Cross-Origin-Embedder-Policy") === "credentialless") {
      return "credentialless";
    }
  } catch {
    // Fall back to require-corp (for example, local Vite dev headers).
  }

  return "require-corp";
}

export async function waitForCrossOriginIsolation(timeoutMs = 15_000): Promise<CoepMode> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (window.crossOriginIsolated) {
      return detectCoepMode();
    }
    await sleep(100);
  }

  throw new Error(
    "Cross-origin isolation is required for the terminal. Allow service workers for this site, then refresh."
  );
}
