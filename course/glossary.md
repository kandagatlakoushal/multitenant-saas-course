# Course Glossary (all days)

One glossary for the whole course. The notes, exercises and quizzes use these words with exactly these meanings. The **Day** column says where each term is introduced. Each day's cheat sheet lists only that day's additions.

## Day 1: Foundations and tenant identity

| Term | Meaning in this course |
|---|---|
| **Tenant** | A customer organisation whose users and data the system serves, and which must be kept apart from other customers. One tenant has many users. [AWS-Fund] |
| **Tenant ID** (`tenantId`) | The short, stable, non-secret identifier of a tenant, such as `acme`. It is never a display name and never reused after offboarding. |
| **Per-customer deployment** | The old model: each customer gets its own complete copy of all services, queues and databases. In this course it is the `LEGACY` placement. |
| **Multi-tenant SaaS** | One running deployment (or a few) that serves many tenants at once. |
| **Tenancy model** | How the resources of one layer (DB, queues, compute) are shared between tenants: silo, pool, or bridge. [AWS-Fund], [Azure-MT *Tenancy models*] |
| **Silo** | A resource dedicated to one tenant, such as its own database or its own queue. |
| **Pool** | A resource shared by many tenants, such as one shared shard queue or one table holding several tenants' rows. |
| **Bridge** | A system that mixes silo and pool in different layers, e.g. pooled compute and pooled queues but a siloed schema per tenant. (AWS term.) [AWS-Fund], [AWS-Iso] |
| **Tiering** | Giving different tenants different placements or limits, usually by commercial tier. Example: large tenants get dedicated queues. |
| **Isolation** | The guarantee that one tenant cannot read, change or disrupt another tenant's data or service. It is enforced, not just assumed. [AWS-Iso] |
| **Blast radius** | How many tenants are hurt when one thing fails or one bug leaks. |
| **Control plane** | The services that manage tenants: registry, onboarding, offboarding, per-tenant config, billing, metrics. They are not tenant-facing business logic. [AWS-Fund], [Azure-MT *Control planes*] |
| **Application plane** | The services that do the tenant's actual work: in our pipeline, ingester, parser, enricher, rules, reporter. |
| **Tenant registry** | The control-plane record of every tenant and its placement (DB isolation, queue tier, source queue). In our system it is a file. |
| **Placement** | Where a tenant's resources live in one layer, e.g. `database.isolation=SCHEMA`, `queues.tier=SHARED`. |
| **Onboarding** | Creating a tenant: registry entry, schema or DB, queues, config, users. |
| **Offboarding** | Removing a tenant: stop traffic, export, delete data, remove registry entry. |
| **Tenant context** | The tenant ID the current unit of work belongs to, held in memory while that work runs. In our services it is a `ThreadLocal` called `TenantContext`. [AWS-Fund] |
| **Trusted edge** | The one place where a tenant ID is *assigned* from evidence the system controls: the ingester (source queue) or the UI gateway (authenticated user). Everything after it only passes the ID on. |
| **Propagation** | Carrying the tenant context across a boundary: JMS property, HTTP header, thread hop. |
| **Boundary** | The point where work enters a service (JMS listener, HTTP filter, scheduler tick). The context is set there and cleared there. |
| **Fail closed** | When the tenant is missing or unknown, refuse the work (retry, then DLQ, or HTTP 4xx). Never guess. |
| **Default tenant** | A fallback tenant used when none is known. It is **forbidden** in this design, because it turns a missing-tenant bug into a cross-tenant leak. |
| **Startup-frozen config** | A per-customer setting read once at startup into a singleton field. It is wrong in a shared deployment, because it holds only one customer's value. |
| **Run-time tenant config** | A per-tenant setting looked up for the current tenant context each time it is needed (usually through a cache keyed by tenant). |
| **Opt-in flag** | `multitenancy.enabled`. It defaults to `false`, so the old single-customer behaviour stays unless someone switches it on. |
| **Starter** | A Spring Boot library that ships auto-configuration, so adding the jar plus properties switches features on. [Boot-AC] |

## Day 2: Data isolation

| Term | Meaning in this course |
|---|---|
| **Database per tenant** | Data approach where each tenant has its own PostgreSQL database (silo). Registry value `DATABASE`. |
| **Schema per tenant** | Data approach where each tenant has its own schema inside a shared database (bridge-ish). Registry value `SCHEMA`. |
| **Shared tables** | Data approach where all tenants share tables and each row carries a `tenant_id` column (pool). |
| **Discriminator column** | The `tenant_id` column in shared tables. Every query must filter on it. |
| **Row-level security (RLS)** | PostgreSQL feature: policies attached to a table that filter rows per session, e.g. by `current_setting('app.tenant_id')`. [PG-RLS] |
| **`search_path`** | PostgreSQL session setting: the list of schemas searched for unqualified names. [PG-Client] |
| **Current schema** | The first *existing* schema in `search_path`. New unqualified objects are created there. [PG-Schemas] |
| **Borrow-time switch** | Setting `search_path` (or RLS setting) every time a connection is borrowed from the pool, not once at connection creation. |
| **Routing data source** | A `DataSource` that picks a target `DataSource` per call based on the current tenant (Spring's `AbstractRoutingDataSource` pattern). |
| **Pool per database** | One HikariCP pool for each physical database. Needed for `DATABASE` tenants. |
| **Stale-context connection** | A pooled connection still carrying the previous tenant's `search_path` or setting. It causes a leak if it is not reset on borrow. |
| **Connection leak** | A connection borrowed and never returned. With a stale context, the damage is worse. |
| **Migration fan-out** | Running the same schema migration once for every tenant schema or database. |
| **Tenant-scoped key** | A cache, lock or map key that includes the tenant ID. Required for all shared in-memory state. |
| **Noisy neighbour** | One tenant's load degrading service for other tenants who share a resource. [Azure-MT *Noisy Neighbor antipattern*] |

## Day 3: Messaging and context propagation

| Term | Meaning in this course |
|---|---|
| **Virtual topic** | ActiveMQ Classic feature: producers send to a topic; each logical subscriber gets its own *consumer queue* that copies the topic. [AMQ-VD] |
| **Consumer queue** | The queue behind a virtual topic for one subscriber, named like `Consumer.<name>.VirtualTopic.<topic>` by default. [AMQ-VD] |
| **Shard queue** | One of N shared queues for pooled tenants, e.g. `PARSE.shard-2`. |
| **Shard count (N)** | The number of shard queues. Tenants are placed by `floorMod(hash(tenantId), N)`. |
| **One-way door** | A decision that is costly or impossible to reverse cheaply. Changing N is one. |
| **Consistent hashing** | A hashing scheme in which changing the number of buckets moves only about 1/N of keys, instead of almost all of them. |
| **Hot shard** | A shard queue that carries far more load than the others, usually because a big tenant hashes there. |
| **Dedicated queue** | A queue for one tenant (silo tier), e.g. `PARSE.globex`. |
| **Message group** | ActiveMQ Classic feature: messages with the same `JMSXGroupID` go to one consumer at a time, so they are processed in order. [AMQ-MG] |
| **Broadcast message** | A message that belongs to no single tenant (e.g. a reference-data refresh). It must be fanned out per tenant, with the context set for each. |
| **Poison message** | A message that fails every time it is processed. |
| **Redelivery policy** | The rules for retrying a failed message: count, delay, back-off. [AMQ-RD] |
| **Dead-letter queue (DLQ)** | Where a message goes after it runs out of redeliveries. It is our fail-closed path. [AMQ-RD] |
| **Thread hop** | Any point where work moves to another thread: `@Async`, executor, scheduler, `CompletableFuture`, Reactor operator. The `ThreadLocal` does not follow by itself. |
| **Task decorator** | A Spring `TaskDecorator` that wraps a `Runnable` to capture context on the submitting thread and restore it on the worker. [Spring-Task] |
| **Context snapshot** | Micrometer's captured copy of registered `ThreadLocal` values, restored on another thread. [Micrometer-CP] |
| **`ThreadLocalAccessor`** | Micrometer interface that tells the library how to read, set and reset one `ThreadLocal`. [Micrometer-CP] |
| **Automatic context propagation** | Reactor mode (`Hooks.enableAutomaticContextPropagation()`) that restores registered `ThreadLocal`s around operators. [Reactor-CP] |
| **Outbound propagation** | Adding `X-Tenant-Id` to every internal REST call through an interceptor on the client builder. |

## Day 4: The edge, operations and testing

| Term | Meaning in this course |
|---|---|
| **BFF (Backend for Frontend)** | The UI gateway: a server-side component that the browser talks to, which holds the OIDC session and calls internal services. |
| **Tenant resolution** | Working out the tenant at the trusted edge: from the source queue (ingester) or the authenticated identity (BFF). |
| **Tenant claim** | A claim in the ID or access token, or a user→tenant mapping, that the BFF uses for tenant resolution. |
| **Header stripping** | Removing any client-sent `X-Tenant-Id` before it can be read. Or rejecting the request. |
| **Lenient filter** | An anti-pattern: a filter that copies a client-sent tenant header into the context "if present". |
| **IDOR** | Insecure Direct Object Reference: accessing another tenant's object by changing an ID the server trusted. A kind of OWASP A01 Broken Access Control. [OWASP-A01] |
| **Quota** | A per-tenant limit on total use over a period (messages per day, storage). [SRE-Overload] |
| **Rate limit** | A per-tenant limit on requests or messages per second. |
| **Bulkhead** | Separate resources (pools, consumers, queues) so one tenant's failure or load cannot drain everyone's. |
| **Load shedding** | Deliberately rejecting some work when overloaded, so the rest can succeed. [SRE-Overload] |
| **MDC** | SLF4J Mapped Diagnostic Context: a per-thread map copied into log lines. It is itself a `ThreadLocal`. |
| **Cardinality** | The number of distinct values of a metric tag. With 300+ tenants, `tenant` as a tag multiplies time series. |
| **Leak test** | A test with two tenants holding the *same* business keys, which asserts that neither sees the other's data. |
| **Forged-header test** | A test that sends a fake `X-Tenant-Id` from the browser side and asserts it is rejected or ignored. |
| **Missing-tenant test** | A test that sends work with no tenant and asserts rejection (DLQ or 4xx), never a default. |
