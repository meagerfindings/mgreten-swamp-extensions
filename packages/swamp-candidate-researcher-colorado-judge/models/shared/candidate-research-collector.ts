/**
 * Shared source collection helpers for candidate research.
 *
 * These helpers fetch directly accessible sources, normalize the results into
 * source packets, and preserve query/manual-followup items as explicit packets
 * instead of fabricating content.
 *
 * @module
 */

import { buildSourcePacket, slugify, type Jurisdiction, type SourcePacket, type SourceSpec } from "./candidate-research-shared.ts";

async function fetchPage(url: string, timeoutMs: number): Promise<{ status: number; body: string; accessStatus: SourcePacket["accessStatus"] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; swamp-candidate-researcher/1.0)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      status: response.status,
      body,
      accessStatus: response.ok ? "fetched" : "error",
    };
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
      accessStatus: "blocked",
    };
  } finally {
    clearTimeout(timer);
  }
}

export type SourceWriteResource = (resourceType: "packet", name: string, value: SourcePacket) => Promise<string>;

export interface CollectSourcePacketsInput {
  subject: string;
  sources: SourceSpec[];
  jurisdiction?: Jurisdiction;
  fetchTimeoutMs?: number;
  writeResource?: SourceWriteResource;
}

export interface CollectSourcePacketsResult {
  packets: SourcePacket[];
  dataHandles: string[];
}

/**
 * Fetch a source list into normalized source packets.
 */
export async function collectSourcePackets(input: CollectSourcePacketsInput): Promise<CollectSourcePacketsResult> {
  const packets: SourcePacket[] = [];
  const dataHandles: string[] = [];
  const fetchTimeoutMs = input.fetchTimeoutMs ?? 15000;

  for (const source of input.sources) {
    if (!source.enabled) continue;

    if (!source.url) {
      const packet: SourcePacket = {
        subject: input.subject,
        sourceName: source.name,
        kind: source.kind,
        jurisdiction: source.jurisdiction ?? input.jurisdiction,
        fetchedAt: new Date().toISOString(),
        accessStatus: "not-fetched",
        excerpt: source.queryHint ?? source.notes ?? "Source requires a query or manual follow-up.",
        notes: source.notes,
      };
      packets.push(packet);
      if (input.writeResource) {
        const handle = await input.writeResource("packet", slugify(`${input.subject}-${source.name}`), packet);
        dataHandles.push(handle);
      }
      continue;
    }

    const fetchedAt = new Date().toISOString();
    const result = await fetchPage(source.url, fetchTimeoutMs);
    const packet = buildSourcePacket({
      subject: input.subject,
      sourceName: source.name,
      kind: source.kind,
      url: source.url,
      jurisdiction: source.jurisdiction ?? input.jurisdiction,
      fetchedAt,
      body: result.body,
      notes: source.notes,
      accessStatus: result.accessStatus,
    });
    packets.push(packet);
    if (input.writeResource) {
      const handle = await input.writeResource("packet", slugify(`${input.subject}-${source.name}`), packet);
      dataHandles.push(handle);
    }
  }

  return { packets, dataHandles };
}
