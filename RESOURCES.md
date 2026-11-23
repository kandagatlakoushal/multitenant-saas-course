# Multi-tenant SaaS Resources

## Knowledge

### Architecture and vocabulary
- [Book: _Building Multi-Tenant SaaS Architectures_ by Tod Golding (O'Reilly, 2024)](https://www.oreilly.com/search/?q=Building%20Multi-Tenant%20SaaS%20Architectures)
  The most complete single treatment: tenant context, control plane, data partitioning, isolation, noisy neighbour. Use for: framing any design debate. (Cited by topic; chapter numbers not verified.)
- [Whitepaper: _SaaS Architecture Fundamentals_ (AWS)](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/saas-architecture-fundamentals.html)
  Short, defines control plane vs application plane, silo/pool/bridge, tiering, tenant context. Use for: shared vocabulary in meetings.
- [Whitepaper: _SaaS Tenant Isolation Strategies_ (AWS)](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/saas-tenant-isolation-strategies.html)
  Isolation as enforcement in every model, not a deployment shape. Use for: arguing why pooled resources still need isolation code and tests.
- [Guide: _Architect multitenant solutions on Azure_ (Azure Architecture Center)](https://learn.microsoft.com/azure/architecture/guide/multitenant/overview)
  Vendor-neutral in most sections. Sub-pages worth reaching for: [Tenancy models](https://learn.microsoft.com/azure/architecture/guide/multitenant/considerations/tenancy-models), [Tenant lifecycle](https://learn.microsoft.com/azure/architecture/guide/multitenant/considerations/tenant-lifecycle), [Map requests to tenants](https://learn.microsoft.com/azure/architecture/guide/multitenant/considerations/map-requests), [Storage and data approaches](https://learn.microsoft.com/azure/architecture/guide/multitenant/approaches/storage-data), [Noisy Neighbor antipattern](https://learn.microsoft.com/azure/architecture/antipatterns/noisy-neighbor/noisy-neighbor).

### PostgreSQL and pooling
- [Docs: PostgreSQL _Schemas_](https://www.postgresql.org/docs/current/ddl-schemas.html) and [_Client Connection Defaults_ (`search_path`)](https://www.postgresql.org/docs/current/runtime-config-client.html)
  Name lookup, current schema, `pg_temp`/`pg_catalog`, missing schemas skipped. Use for: every `search_path` question.
- [Docs: PostgreSQL _SET_](https://www.postgresql.org/docs/current/sql-set.html)
  `SET` vs `SET LOCAL`, rollback behaviour. Use for: what survives a pooled connection.
- [Docs: PostgreSQL _Row Security Policies_](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
  RLS, `FORCE`, owner/superuser bypass. Use for: shared-table designs.
- [README: HikariCP](https://github.com/brettwooldridge/HikariCP) and [wiki: _About Pool Sizing_](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
  `connectionInitSql`, reset-on-return, small pools. Use for: connection counts and per-borrow switching.
- [Javadoc: Spring `AbstractRoutingDataSource`](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/jdbc/datasource/lookup/AbstractRoutingDataSource.html)
  Lookup key, default target, lenient fallback. Use for: database-per-tenant routing.
- [Docs: Liquibase](https://docs.liquibase.com/)
  Schema parameters and changelog tables. Use for: migrating hundreds of schemas.

### Messaging
- [Docs: ActiveMQ Classic documentation index](https://activemq.apache.org/components/classic/documentation)
  Pages: _Virtual Destinations_, _Message Groups_, _Redelivery Policy_, _Message Redelivery and DLQ Handling_. Use for: destination naming, ordering, DLQ defaults.

### Spring, context propagation, security
- [Docs: Spring Boot _Creating Your Own Auto-configuration_](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)
  `AutoConfiguration.imports`, condition annotations. Use for: the multi-tenancy starter.
- [Docs: Spring Framework _Task Execution and Scheduling_](https://docs.spring.io/spring-framework/reference/integration/scheduling.html)
  `TaskDecorator`, executors, `@Async`, `@Scheduled`. Use for: thread hops.
- [Docs: Micrometer _Context Propagation_](https://docs.micrometer.io/context-propagation/reference/)
  `ThreadLocalAccessor`, `ContextRegistry`, snapshots. Use for: carrying `TenantContext` and MDC across threads.
- [Docs: Reactor reference](https://projectreactor.io/docs/core/release/reference/)
  Section on context propagation and automatic mode. Use for: `WebClient` and reactive chains.
- [Docs: Spring Boot _Calling REST Services_](https://docs.spring.io/spring-boot/reference/io/rest-client.html)
  Builders and customizers for `RestTemplate`, `RestClient`, `WebClient`. Use for: why `new RestTemplate()` loses the header.
- [Docs: Spring Framework _Cache Abstraction_ annotations](https://docs.spring.io/spring-framework/reference/integration/cache/annotations.html)
  Default key generation. Use for: tenant-scoped cache keys.
- [Docs: Spring Security _Servlet Architecture_](https://docs.spring.io/spring-security/reference/servlet/architecture.html)
  Filter chain, ordering, adding custom filters, filter-as-bean pitfall. Use for: the BFF tenant filter.
- [OWASP Top 10: _A01 Broken Access Control_](https://owasp.org/Top10/A01_2021-Broken_Access_Control/)
  IDOR, deny by default, logging failures. Use for: framing cross-tenant access as a security bug.

### Operations and testing
- [Book chapter: _Handling Overload_, Google SRE book](https://sre.google/sre-book/handling-overload/)
  Per-customer limits, load shedding, client-side throttling. Use for: noisy-neighbour controls.
- [Docs: Testcontainers PostgreSQL module](https://java.testcontainers.org/modules/databases/postgres/)
  Real PostgreSQL in tests. Use for: isolation tests that depend on `search_path`/RLS.
- [Docs: ArchUnit](https://www.archunit.org/)
  Architecture rules as unit tests. Use for: banning `new RestTemplate()`, `parallelStream()`, per-customer `@Value`.

### Video (search queries, not links: titles not verified)
- YouTube, _AWS Events_ channel: `Tod Golding re:Invent SaaS` — control plane, tiering, isolation.
- YouTube, _Spring I/O_ / _SpringDeveloper_: `multitenancy Spring Boot`, `Micrometer context propagation`, `Spring Security architecture`.
- YouTube: `PostgreSQL row level security multi tenant`, `consistent hashing explained`, `jump consistent hash`.

## Wisdom
- [Stack Overflow tags `multi-tenant`, `spring-boot`, `activemq-classic`](https://stackoverflow.com/questions/tagged/multi-tenant) — specific, answerable questions; search before asking.
- [AWS re:Post](https://repost.aws/) — SaaS architecture questions (AWS-flavoured but often general).
- [pgsql-general mailing list](https://www.postgresql.org/list/pgsql-general/) — `search_path`, RLS, pooling edge cases; very high signal.
- [ActiveMQ users mailing list](https://activemq.apache.org/contact) — message groups, DLQ, virtual topics behaviour.
- r/java and r/softwarearchitecture — design-debate sparring; lower signal, useful for "how do others do X".

## Gaps
- No verified, current conference video links. Lessons give search queries instead.
- Several defaults are unverified for specific versions (ActiveMQ redelivery defaults, HikariCP reset list, pgJDBC `setSchema`, Spring Boot `sessionTransacted`, Micrometer accessor method names). Lessons mark them ⚠. Verify against the docs above for the versions in use.
- ActiveMQ documentation URLs have moved before; if a link breaks, search the page title.
