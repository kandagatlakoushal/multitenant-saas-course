# Multi-tenant SaaS for Spring Boot microservices

A 4-day self-study course for experienced Java backend developers who are moving from one deployment per customer to a shared, multi-tenant deployment. The running example is a generic trade-processing pipeline (ingester → parser → enricher → rules → reporter, plus a UI gateway), built on Spring Boot, ActiveMQ Classic and PostgreSQL.

It comes in two forms:

- **Interactive lessons** ([`index.html`](index.html)): 13 short HTML lessons with recall prompts, quizzes that give instant feedback, a shard calculator, a glossary and a cheat sheet.
- **Long-form notes** ([`course/`](course/README.md)): the same material as four day-long Markdown chapters, with exercises and worked answers.

Topics: silo/pool/bridge per layer, tenant context and the trusted edge, PostgreSQL `search_path` and row-level security, HikariCP per-borrow switching, tenant-scoped caches, sharded queues and message groups, DLQ triage, context propagation across threads, the BFF tenant filter (OWASP A01), noisy neighbours, observability, tenant lifecycle and isolation testing.

Facts the author was not sure of are marked ⚠ UNVERIFIED. Check them against the linked primary sources before relying on them.
