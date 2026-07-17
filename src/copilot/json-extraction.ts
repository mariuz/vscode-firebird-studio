/**
 * Shared helper for Copilot integrations that ask the model to return a small structured JSON
 * edit/config rather than raw output for this extension to apply verbatim (the Schema Designer's
 * "Ask Copilot" panel and the Data API Builder's Copilot-assisted spec scoping both follow this
 * shape) — see docs/roadmap/visual-schema-designer.md and docs/roadmap/data-api-builder.md.
 */

/**
 * Strips a ```json ... ``` (or bare ```) fence from a model response, if present — models asked
 * for "JSON only" still sometimes wrap it in a markdown code fence anyway.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}
