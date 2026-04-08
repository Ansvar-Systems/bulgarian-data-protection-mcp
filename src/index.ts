#!/usr/bin/env node

/**
 * Bulgarian Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying CPDP decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: bg_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
  getDbStats,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "bulgarian-data-protection-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "bg_dp_search_decisions",
    description:
      "Full-text search across CPDP decisions (решения, наказателни постановления, предписания). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'съгласие бисквитки', 'ДСК Банк', 'нарушение данни')",
        },
        type: {
          type: "string",
          enum: ["наказателно_постановление", "предписание", "решение", "становище"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'consent', 'cookies', 'transfers'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "bg_dp_get_decision",
    description:
      "Get a specific CPDP decision by reference number (e.g., 'EAJ-1234/2022', 'НП-2022-100').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "CPDP decision reference (e.g., 'EAJ-1234/2022', 'НП-2022-100')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "bg_dp_search_guidelines",
    description:
      "Search CPDP guidance documents: становища, насоки, and методически указания. Covers GDPR implementation, ОВЛПД (DPIA), cookie consent, video surveillance, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'ОВЛПД', 'бисквитки съгласие', 'видеонаблюдение')",
        },
        type: {
          type: "string",
          enum: ["становище", "насока", "методически_указания", "ръководство"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'dpia', 'cookies', 'breach_notification'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "bg_dp_get_guideline",
    description:
      "Get a specific CPDP guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from bg_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "bg_dp_list_topics",
    description:
      "List all covered data protection topics with Bulgarian and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "bg_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "bg_dp_list_sources",
    description: "List authoritative data sources used by this MCP server, including provenance, license, and update frequency.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "bg_dp_check_data_freshness",
    description: "Check the freshness of the local database: record counts and latest document dates for decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["наказателно_постановление", "предписание", "решение", "становище"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["становище", "насока", "методически_указания", "ръководство"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- Helper ------------------------------------------------------------------

const META = {
  disclaimer: "For informational purposes only. Verify all references against primary sources before making compliance decisions.",
  copyright: "Data sourced from CPDP (https://www.cpdp.bg/). Official Bulgarian regulatory publications.",
  source_url: "https://www.cpdp.bg/",
};

function textContent(data: unknown) {
  const payload = typeof data === "object" && data !== null ? { ...data as object, _meta: META } : data;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "bg_dp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "bg_dp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.reference);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.reference}`);
        }
        return textContent({
          ...(typeof decision === 'object' ? decision : { data: decision }),
          _citation: buildCitation(
            (decision as any).reference || parsed.reference,
            (decision as any).title || (decision as any).subject || '',
            'bg_dp_get_decision',
            { reference: parsed.reference },
            (decision as any).url || null,
          ),
        });
      }

      case "bg_dp_search_guidelines": {
        const parsed = SearchGuidelinesArgs.parse(args);
        const results = searchGuidelines({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "bg_dp_get_guideline": {
        const parsed = GetGuidelineArgs.parse(args);
        const guideline = getGuideline(parsed.id);
        if (!guideline) {
          return errorContent(`Guideline not found: id=${parsed.id}`);
        }
        return textContent({
          ...(typeof guideline === 'object' ? guideline : { data: guideline }),
          _citation: buildCitation(
            (guideline as any).reference || String(parsed.id),
            (guideline as any).title || (guideline as any).subject || '',
            'bg_dp_get_guideline',
            { id: String(parsed.id) },
            (guideline as any).url || null,
          ),
        });
      }

      case "bg_dp_list_topics": {
        const topics = listTopics();
        return textContent({ topics, count: topics.length });
      }

      case "bg_dp_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "CPDP (Комисия за защита на личните данни) MCP server. Provides access to Bulgarian data protection authority decisions, sanctions, наказателни постановления, and official guidance documents.",
          data_source: "CPDP (https://www.cpdp.bg/)",
          coverage: {
            decisions: "CPDP решения, наказателни постановления, and предписания",
            guidelines: "CPDP становища, насоки, and методически указания",
            topics: "Consent (съгласие), cookies (бисквитки), transfers, DPIA (ОВЛПД), breach notification, privacy by design, video surveillance (видеонаблюдение), health data, children",
          },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      case "bg_dp_list_sources": {
        return textContent({
          sources: [
            {
              id: "cpdp",
              name: "CPDP — Комисия за защита на личните данни",
              name_en: "Commission for Personal Data Protection",
              url: "https://www.cpdp.bg/",
              authority: "Bulgarian Data Protection Authority",
              jurisdiction: "Bulgaria",
              license: "Open government data — official regulatory publications",
              update_frequency: "Periodic",
              coverage: "Decisions (решения, наказателни постановления, предписания), guidelines (становища, насоки, методически указания), and topics",
            },
          ],
        });
      }

      case "bg_dp_check_data_freshness": {
        const stats = getDbStats();
        return textContent({
          status: "ok",
          database_path: process.env["CPDP_DB_PATH"] ?? "data/cpdp.db",
          record_counts: {
            decisions: stats.decisions_count,
            guidelines: stats.guidelines_count,
            topics: stats.topics_count,
          },
          latest_dates: {
            decision: stats.latest_decision_date ?? "none",
            guideline: stats.latest_guideline_date ?? "none",
          },
          note: "Database updates are periodic. Verify against https://www.cpdp.bg/ for the most recent publications.",
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
