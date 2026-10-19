// The bundled config. generated.json is compiled from bands.yaml by `task config` and
// was validated then; the Worker trusts it and never re-validates or parses YAML.
// Type-only import: valibot must not end up in the Worker bundle.
import type { Config } from "./schema";
import generated from "./generated.json";

export type { Band, Config, Show, Theme } from "./schema";
export const config: Config = generated;
