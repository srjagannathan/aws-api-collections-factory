// SPDX-License-Identifier: Apache-2.0

import { readJson } from '../json-store.js';
import type { RuntimePaths } from '../types.js';
import { interactionPocOutput } from './interaction-poc.js';
import { postmanOutput } from './postman.js';
import type { AnyConverter, ComposedConverter, OutputConverter } from './types.js';

const REGISTRY = new Map<string, AnyConverter>([
  [postmanOutput.id, postmanOutput],
  [interactionPocOutput.id, interactionPocOutput],
]);

export const DEFAULT_OUTPUT_IDS = ['postman'];

export function getOutputConverter(id: string): AnyConverter | undefined {
  return REGISTRY.get(id);
}

export function knownOutputIds(): string[] {
  return [...REGISTRY.keys()];
}

export function isPerServiceConverter(converter: AnyConverter): converter is OutputConverter {
  return converter.kind === 'per-service';
}

export function isComposedConverter(converter: AnyConverter): converter is ComposedConverter {
  return converter.kind === 'composed';
}

// Reads config/outputs.json's "enabled" list (config/outputs.example.json is
// the seeded template). Absent file or empty list falls back to the default.
export async function enabledOutputIds(paths: RuntimePaths): Promise<string[]> {
  const config = await readJson<{ enabled?: unknown }>(paths.outputsConfig, {});
  const enabled = Array.isArray(config.enabled)
    ? config.enabled.filter((value): value is string => typeof value === 'string')
    : [];
  return enabled.length > 0 ? enabled : DEFAULT_OUTPUT_IDS;
}

export interface ResolvedConverters {
  perService: OutputConverter[];
  composed: ComposedConverter[];
  unknownIds: string[];
}

export async function resolveEnabledConverters(paths: RuntimePaths): Promise<ResolvedConverters> {
  const ids = await enabledOutputIds(paths);
  const perService: OutputConverter[] = [];
  const composed: ComposedConverter[] = [];
  const unknownIds: string[] = [];
  for (const id of ids) {
    const converter = getOutputConverter(id);
    if (!converter) {
      unknownIds.push(id);
    } else if (isPerServiceConverter(converter)) {
      perService.push(converter);
    } else {
      composed.push(converter);
    }
  }
  return { perService, composed, unknownIds };
}
