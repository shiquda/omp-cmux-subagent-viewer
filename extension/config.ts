// Extension configuration. v0.1 deliberately minimal: only `enabled`, `layout`,
// `keepSurface`, and env-tunable data root/viewer knobs (§18). No heavy YAML
// config parsing — env vars + defaults keep the first version small.

import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionConfig } from "./types";

const DEFAULTS: ExtensionConfig = {
  enabled: true,
  layout: "helper-pane",
  keepSurface: true,
  dataDir: join(homedir(), ".local", "state", "omp-cmux-subagents"),
  showDetached: true,
  viewer: {
    maxEvents: 2000,
    maxOutputLines: 1000,
    maxLineLength: 400,
  },
};

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function numFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ExtensionConfig {
  const layoutRaw = env.OMP_CMUX_SUBAGENTS_LAYOUT;
  const layout: ExtensionConfig["layout"] = layoutRaw === "split" ? "split" : "helper-pane";
  if (layoutRaw !== undefined && layoutRaw !== "split" && layoutRaw !== "helper-pane") {
    // eslint-disable-next-line no-console
    console.warn(`[cmux-subagents] unknown layout "${layoutRaw}" — falling back to "helper-pane"`);
  }
  return {
    enabled: boolFromEnv(env.OMP_CMUX_SUBAGENTS_ENABLED, DEFAULTS.enabled),
    layout,
    keepSurface: boolFromEnv(env.OMP_CMUX_SUBAGENTS_KEEP_SURFACE, DEFAULTS.keepSurface),
    dataDir: env.OMP_CMUX_SUBAGENTS_DATA_DIR ?? DEFAULTS.dataDir,
    showDetached: boolFromEnv(env.OMP_CMUX_SUBAGENTS_SHOW_DETACHED, DEFAULTS.showDetached),
    viewer: {
      maxEvents: numFromEnv(env.OMP_CMUX_SUBAGENTS_MAX_EVENTS, DEFAULTS.viewer.maxEvents),
      maxOutputLines: numFromEnv(env.OMP_CMUX_SUBAGENTS_MAX_OUTPUT_LINES, DEFAULTS.viewer.maxOutputLines),
      maxLineLength: numFromEnv(env.OMP_CMUX_SUBAGENTS_MAX_LINE_LENGTH, DEFAULTS.viewer.maxLineLength),
    },
  };
}
