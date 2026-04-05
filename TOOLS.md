# Tool Reference

This document describes all tools exposed by the Bulgarian Data Protection MCP server. All tools return structured JSON with a `_meta` block containing disclaimer, copyright, and source URL.

## Tool List

### `bg_dp_search_decisions`

Full-text search across CPDP decisions (решения, наказателни постановления, предписания).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `съгласие бисквитки`, `ДСК Банк`, `нарушение данни`) |
| `type` | enum | No | Filter by decision type: `наказателно_постановление`, `предписание`, `решение`, `становище` |
| `topic` | string | No | Filter by topic ID (e.g., `consent`, `cookies`, `transfers`) |
| `limit` | number | No | Maximum results (default 20, max 100) |

**Returns:** `{ results: Decision[], count: number, _meta: Meta }`

---

### `bg_dp_get_decision`

Get a specific CPDP decision by reference number.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `reference` | string | Yes | CPDP decision reference (e.g., `EAJ-1234/2022`, `НП-2022-100`) |

**Returns:** `Decision | error`

---

### `bg_dp_search_guidelines`

Search CPDP guidance documents (становища, насоки, методически указания).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `ОВЛПД`, `бисквитки съгласие`, `видеонаблюдение`) |
| `type` | enum | No | Filter by guidance type: `становище`, `насока`, `методически_указания`, `ръководство` |
| `topic` | string | No | Filter by topic ID |
| `limit` | number | No | Maximum results (default 20, max 100) |

**Returns:** `{ results: Guideline[], count: number, _meta: Meta }`

---

### `bg_dp_get_guideline`

Get a specific CPDP guidance document by database ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | number | Yes | Guideline database ID (from `bg_dp_search_guidelines` results) |

**Returns:** `Guideline | error`

---

### `bg_dp_list_topics`

List all covered data protection topics with Bulgarian and English names.

**Parameters:** none

**Returns:** `{ topics: Topic[], count: number, _meta: Meta }`

---

### `bg_dp_about`

Return metadata about this MCP server: version, data source, coverage, and tool list.

**Parameters:** none

**Returns:** Server metadata object including coverage summary and tool list.

---

### `bg_dp_list_sources`

List authoritative data sources used by this MCP server, including provenance, license, and update frequency.

**Parameters:** none

**Returns:** `{ sources: Source[], _meta: Meta }`

---

### `bg_dp_check_data_freshness`

Check the freshness of the local database: record counts and latest document dates.

**Parameters:** none

**Returns:** `{ status, record_counts, latest_dates, note, _meta: Meta }`

---

## Response Schema

All successful responses include a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "For informational purposes only. Verify all references against primary sources before making compliance decisions.",
    "copyright": "Data sourced from CPDP (https://www.cpdp.bg/). Official Bulgarian regulatory publications.",
    "source_url": "https://www.cpdp.bg/"
  }
}
```
