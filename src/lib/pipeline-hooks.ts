import type { ConversionPipelineHooks } from "./extensions/conversion-hooks";

/**
 * Registry for conversion pipeline hooks (M3 wires the M0 extension
 * point into the real pipeline).
 *
 * The core registers nothing: with an empty registry the pipeline passes
 * straight through. Pro packages (anti-fraud, reporting) register their
 * hooks at startup; tests register throwaway implementations to prove
 * the seam is really called.
 */

const registry: ConversionPipelineHooks[] = [];

export function registerConversionHooks(hooks: ConversionPipelineHooks): void {
  registry.push(hooks);
}

export function clearConversionHooks(): void {
  registry.length = 0;
}

export function listConversionHooks(): ConversionPipelineHooks[] {
  return [...registry];
}
