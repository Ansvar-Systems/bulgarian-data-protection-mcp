# Data Coverage

This document describes the data sources and coverage for the Bulgarian Data Protection MCP server.

## Primary Source

| Field | Value |
|-------|-------|
| **Authority** | CPDP — Комисия за защита на личните данни (Commission for Personal Data Protection) |
| **URL** | https://www.cpdp.bg/ |
| **Jurisdiction** | Bulgaria |
| **License** | Open government data — official regulatory publications |
| **Update Frequency** | Periodic (check `bg_dp_check_data_freshness` for current counts and latest dates) |

## Coverage by Document Type

### Decisions (`bg_dp_search_decisions`, `bg_dp_get_decision`)

| Type | Bulgarian | Description |
|------|-----------|-------------|
| `наказателно_постановление` | Наказателно постановление | Penal decree (sanction with fine) |
| `предписание` | Предписание | Corrective order / enforcement notice |
| `решение` | Решение | Decision (general) |
| `становище` | Становище | Opinion / advisory |

Reference format examples: `EAJ-1234/2022`, `НП-2022-100`

### Guidelines (`bg_dp_search_guidelines`, `bg_dp_get_guideline`)

| Type | Bulgarian | Description |
|------|-----------|-------------|
| `становище` | Становище | Opinion |
| `насока` | Насока | Guideline |
| `методически_указания` | Методически указания | Methodological instructions |
| `ръководство` | Ръководство | Guide / handbook |

### Topics (`bg_dp_list_topics`)

| Topic ID | Bulgarian | English |
|----------|-----------|---------|
| `consent` | Съгласие | Consent |
| `cookies` | Бисквитки | Cookies |
| `transfers` | Трансфер на данни | Data transfers |
| `dpia` | ОВЛПД | DPIA / Data Protection Impact Assessment |
| `breach_notification` | Уведомяване за нарушение | Breach notification |
| `privacy_by_design` | Защита на данните при проектирането | Privacy by design |
| `video_surveillance` | Видеонаблюдение | Video surveillance |
| `health_data` | Здравни данни | Health data |
| `children` | Деца | Children |

## Limitations

- Coverage may be incomplete — not all CPDP publications may be ingested.
- Database updates are periodic and may lag behind official publications.
- **Always verify against primary sources at https://www.cpdp.bg/ before making compliance decisions.**
- This tool is for research purposes only and does not constitute legal or regulatory advice.

## Licensing

Data is sourced from official CPDP publications (open government data). The MCP server code is licensed under Apache 2.0. See [LICENSE](./LICENSE).
