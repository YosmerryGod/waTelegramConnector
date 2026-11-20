# Changelog

All notable changes to this project are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses Semantic Versioning.

## [Unreleased]

### Added
- Context-aware customer-state skill routing with bounded progressive loading for marketing, psychology, business facts, service recovery, and communication.
- Natural-language product offer guidance using verified product variants, availability, price, and promotion facts.
- Comprehensive Indonesian and English README.
- MIT License.
- OpenRouter environment template and AI system prompts for owner and customer service.
- Tenant-scoped, read-only business tools with schema validation and audit logging.
- Helmet security headers, IP rate limiting, and Docker deployment files.

### Changed
- Customer-facing AI now selects specialist skills by current customer state instead of relying only on keyword-count ranking.
- Product offer candidates exclude explicitly unavailable and out-of-stock items; complaints and refusals suppress promotional selling.
- AI runtime documentation and skill filename migrated from Ollama to OpenRouter.
- Free-tier daily pause hour is configurable through FREE_PAUSE_HOUR.

### Removed
- Legacy skill-ollama.md filename and obsolete Ollama runtime guidance.
