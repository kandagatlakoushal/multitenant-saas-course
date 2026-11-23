# Mission: Multi-tenant SaaS for Spring Boot microservices

## Why
Our trade-processing platform is deployed once per customer (~50 services, own queues and databases each). We are converting it so that one shared deployment serves many customers. I need to do that conversion safely, catch cross-tenant leaks in review, and hold my own in design meetings.

## Success looks like
- Convert an existing Spring Boot service (JMS listener, REST client, PostgreSQL access, caches) so one deployment serves many tenants, with the old single-customer behaviour still the default.
- Review a pull request and name every place a tenant can leak: lost context on a thread hop, a cache key without the tenant, a stale `search_path`, a trusted client header.
- Argue silo/pool/bridge choices per layer, shard count, and data approach in a team meeting, with sources.
- Write a test plan of isolation tests (leak, forged header, missing tenant, concurrency) for the pipeline.

## Constraints
- 4 days, about 2.5 hours a day.
- Strong existing background: Java 17, Spring Boot, ActiveMQ Classic (virtual topics, consumer queues, message groups), PostgreSQL, REST, Spring profiles.
- Prefers written notes plus targeted videos; video links only when certain they exist.

## Out of scope
- Kubernetes / infrastructure provisioning, billing and metering internals.
- Kafka or other brokers; non-PostgreSQL databases.
- Building an identity provider (we consume OIDC, we don't run it).
