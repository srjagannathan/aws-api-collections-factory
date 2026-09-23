// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Scenario } from './types.js';

function isScenario(value: unknown): value is Scenario {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.title === 'string'
    && Array.isArray(candidate.steps)
    && candidate.steps.length > 0
    && candidate.steps.every((step: unknown) => {
      if (!step || typeof step !== 'object') return false;
      const s = step as Record<string, unknown>;
      return typeof s.service === 'string' && typeof s.operation === 'string';
    });
}

// Loads every *.json file in `scenariosDir` (config/scenarios by convention).
// These are hand-authored, versioned repo content, not per-user local state
// — so an absent directory just means no scenarios exist yet, not an error.
export async function loadScenarios(scenariosDir: string): Promise<Scenario[]> {
  let filenames: string[];
  try {
    filenames = (await readdir(scenariosDir)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const scenarios: Scenario[] = [];
  for (const filename of filenames.sort()) {
    const path = join(scenariosDir, filename);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (!isScenario(raw)) {
      throw new Error(`${path} is not a valid scenario definition.`);
    }
    scenarios.push(raw);
  }
  return scenarios;
}
