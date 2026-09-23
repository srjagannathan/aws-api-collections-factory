// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HTTP_METHODS } from '../collection-utils.js';
import type { JsonMap, RuntimePaths } from '../types.js';
import { loadScenarios } from './scenarios.js';
import type { ComposedConverter, ComposedResult, Scenario } from './types.js';

const MAX_DEPTH = 4;
const MAX_PROPS = 8;
const PLACEHOLDER_DATE = '2026-01-01T00:00:00Z';

function resolveSchema(schema: JsonMap, components: JsonMap, seen: Set<string>): JsonMap {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').pop()!;
    if (seen.has(name)) return {};
    seen.add(name);
    return resolveSchema(components[name] || {}, components, seen);
  }
  return schema;
}

// A small, self-contained placeholder-value generator: illustrative only,
// not meant to be a faithful or executable request (that's what the Postman
// output's schema faker is for). Keeps this output independent of whether
// Postman is even enabled.
function exampleValue(schema: JsonMap, components: JsonMap, depth = 0, seen = new Set<string>()): unknown {
  const resolved = resolveSchema(schema || {}, components, seen);
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0];
  if (depth >= MAX_DEPTH) return null;
  if (resolved.type === 'array') {
    return [exampleValue(resolved.items || {}, components, depth + 1, seen)];
  }
  if (resolved.type === 'object' || resolved.properties) {
    const allProps = Object.entries(resolved.properties || {});
    const value: JsonMap = {};
    for (const [key, propSchema] of allProps.slice(0, MAX_PROPS)) {
      value[key] = exampleValue(propSchema as JsonMap, components, depth + 1, seen);
    }
    if (allProps.length > MAX_PROPS) {
      value['...'] = '...';
    }
    return value;
  }
  if (resolved.type === 'integer' || resolved.type === 'number') return 0;
  if (resolved.type === 'boolean') return true;
  if (resolved.format === 'date-time') return PLACEHOLDER_DATE;
  return 'string';
}

interface FoundOperation {
  method: string;
  path: string;
  operation: JsonMap;
}

function findOperation(spec: JsonMap, operationId: string): FoundOperation | undefined {
  for (const [path, methods] of Object.entries(spec.paths || {}) as [string, JsonMap][]) {
    for (const method of HTTP_METHODS) {
      const operation = methods?.[method];
      if (operation?.operationId === operationId) {
        return { method, path, operation };
      }
    }
  }
  return undefined;
}

function stripHtml(text: string): string {
  const decoded = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&');
  return decoded.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Smithy-derived descriptions carry HTML markup (AWS's documentation
// convention); a "narrative" here is prose for a reader, not a wire
// artifact, so it gets the same tag-stripping treatment as the summary.
function narrativeFor(step: { narrative?: string }, operation: JsonMap): string {
  const source = step.narrative || operation.description || operation.summary || '';
  return stripHtml(source);
}

function resolvedPath(path: string, parameters: JsonMap[], components: JsonMap): string {
  let resolved = path;
  const query: string[] = [];
  for (const parameter of parameters) {
    if (parameter.in === 'path') {
      resolved = resolved.replace(
        `{${parameter.name}}`,
        String(exampleValue(parameter.schema || {}, components)),
      );
    } else if (parameter.in === 'query' && parameter.required) {
      query.push(`${parameter.name}=${encodeURIComponent(String(exampleValue(parameter.schema || {}, components)))}`);
    }
  }
  return query.length > 0 ? `${resolved}?${query.join('&')}` : resolved;
}

function requestBody(operation: JsonMap, components: JsonMap): { contentType: string; body: unknown } | undefined {
  const content = operation.requestBody?.content || {};
  if (content['application/json']?.schema) {
    return { contentType: 'application/json', body: exampleValue(content['application/json'].schema, components) };
  }
  if (content['application/x-www-form-urlencoded']?.schema) {
    return {
      contentType: 'application/x-www-form-urlencoded',
      body: exampleValue(content['application/x-www-form-urlencoded'].schema, components),
    };
  }
  return undefined;
}

function renderRequest(spec: JsonMap, found: FoundOperation): string {
  const components = spec.components?.schemas || {};
  const path = resolvedPath(found.path, found.operation.parameters || [], components);
  const lines = [`${found.method.toUpperCase()} ${path} HTTP/1.1`];
  const body = requestBody(found.operation, components);
  if (body && body.contentType === 'application/x-www-form-urlencoded' && body.body && typeof body.body === 'object') {
    const form = Object.entries(body.body as JsonMap)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    lines.push(`Content-Type: ${body.contentType}`, '', form);
  } else if (body) {
    lines.push(`Content-Type: ${body.contentType}`, '', JSON.stringify(body.body, null, 2));
  }
  return lines.join('\n');
}

function renderResponse(spec: JsonMap, found: FoundOperation): string | undefined {
  const components = spec.components?.schemas || {};
  const responses = found.operation.responses || {};
  const codes = Object.keys(responses);
  const code = codes.find((candidate) => candidate.startsWith('2')) || codes[0];
  if (!code) return undefined;
  const schema = responses[code]?.content?.['application/json']?.schema;
  return `${code} response\n${JSON.stringify(schema ? exampleValue(schema, components) : {}, null, 2)}`;
}

async function renderScenario(
  scenario: Scenario,
  specPaths: Map<string, string>,
): Promise<{ markdown: string } | { error: string }> {
  const specs = new Map<string, JsonMap>();
  for (const step of scenario.steps) {
    if (specs.has(step.service)) continue;
    const specPath = specPaths.get(step.service);
    if (!specPath) {
      return { error: `No staged spec is available for service '${step.service}'.` };
    }
    try {
      specs.set(step.service, JSON.parse(await readFile(specPath, 'utf8')));
    } catch (error) {
      return { error: `Could not read the staged spec for '${step.service}': ${String(error)}` };
    }
  }

  const sections = [`# ${scenario.title}`];
  if (scenario.description) sections.push(scenario.description);

  scenario.steps.forEach((step, index) => {
    const heading = `## Step ${index + 1}: ${step.service} — ${step.operation}`;
    const spec = specs.get(step.service)!;
    const found = findOperation(spec, step.operation);
    if (!found) {
      sections.push(`${heading}\n\n_Operation not found in the staged spec for '${step.service}'._`);
      return;
    }
    const narrative = narrativeFor(step, found.operation);
    const response = renderResponse(spec, found);
    sections.push([
      heading,
      narrative,
      `**Request**\n\`\`\`http\n${renderRequest(spec, found)}\n\`\`\``,
      response ? `**Response**\n\`\`\`json\n${response}\n\`\`\`` : '',
    ].filter(Boolean).join('\n\n'));
  });

  return { markdown: sections.join('\n\n') };
}

async function convertAll(
  scenarios: Scenario[],
  specPaths: Map<string, string>,
  outputDir: string,
): Promise<Map<string, ComposedResult>> {
  await mkdir(outputDir, { recursive: true });
  const results = new Map<string, ComposedResult>();
  for (const scenario of scenarios) {
    const rendered = await renderScenario(scenario, specPaths);
    if ('error' in rendered) {
      results.set(scenario.id, { status: 'failed', error: rendered.error });
      continue;
    }
    const artifactPath = join(outputDir, `${scenario.id}.md`);
    await writeFile(artifactPath, `${rendered.markdown}\n`, 'utf8');
    results.set(scenario.id, { status: 'generated', artifactPath });
  }
  return results;
}

function requiredServices(scenarios: Scenario[]): Set<string> {
  const services = new Set<string>();
  for (const scenario of scenarios) {
    for (const step of scenario.steps) services.add(step.service);
  }
  return services;
}

async function loadScenariosForConverter(paths: RuntimePaths): Promise<Scenario[]> {
  return loadScenarios(join(paths.repositoryRoot, 'config', 'scenarios'));
}

export const interactionPocOutput: ComposedConverter = {
  id: 'interaction-poc',
  kind: 'composed',
  loadScenarios: loadScenariosForConverter,
  requiredServices,
  convertAll,
};
