# Day 4: The Trusted Edge, Operations, and Testing Isolation

**Time:** 2.5 h. Today's split is different: the capstone needs 60 minutes, so core study is 60 minutes and the cheat sheet review 5.

| Block | Time |
|---|---|
| Warm-up | 10 min |
| Core study | 60 min |
| Capstone (instead of the 45-min exercises) | 60 min |
| Closing quiz | 15 min |
| Cheat sheet | 5 min |

**Glossary:** [glossary.md](glossary.md) · **Running example:** [README](README.md#the-running-example-a-generic-trade-processing-pipeline)

**Objectives.** By the end of today you can:

- build tenant resolution in a UI gateway (BFF) from the authenticated identity, reject client-sent tenant headers, place the filter correctly in Spring Security, and explain cross-tenant access as OWASP A01 / IDOR;
- choose noisy-neighbour controls: quotas, rate limits, bulkheads, consumer concurrency per shard, load shedding;
- add the tenant to logs and metrics without a cardinality blow-up at 300+ tenants;
- order the steps of tenant onboarding and offboarding;
- write isolation tests: leak, forged header, missing tenant, `ThreadLocal` concurrency;
- produce a conversion checklist and an isolation test plan for real services.

---

## 1. Retrieval warm-up (10 min): Days 1–3

1. Why does `Math.abs(h) % N` not work as a shard function? Give both reasons.
2. A tenant moves from `shard-1` to `shard-3`. What must happen first, and why?
3. Name four kinds of thread hop where the `ThreadLocal` tenant is lost.
4. *(Day 2)* Why is it a mistake for the app to connect to PostgreSQL as the owner of an RLS-protected table?
5. *(Day 1)* What are the four rules of tenant context?

---

## 2. Core study (60 min)

### 2.1 The UI gateway (BFF): where the tenant comes from (18 min)

The ingester's trusted evidence is the source queue. The BFF's trusted evidence is the **authenticated user**. The browser can send *anything*: headers, query parameters, body fields. None of it is evidence of the tenant.

```
  Browser                     UI GATEWAY (BFF)                          internal services
  ───────                     ────────────────                          ─────────────────
  GET /api/trades/9001  ──►   Spring Security filter chain
  X-Tenant-Id: globex   ──►   [SecurityContextHolderFilter]  loads session -> OidcUser
  (forged!)                   [OAuth2LoginAuthenticationFilter]
                              [...]
                              [AuthorizationFilter]           authenticated? yes
                              [TenantResolutionFilter]  (ours, AFTER auth)
                                 1. any X-Tenant-Id from client? -> 400, log, metric
                                 2. tenant := mapping(OidcUser)  (claim or user->tenant table)
                                 3. unknown / none -> 403
                                 4. TenantContext.set(tenant); finally clear()
                              controller -> client builder adds   ──►   X-Tenant-Id: acme
                              X-Tenant-Id from TenantContext             (trusted: service-to-service)
```

#### Deriving the tenant

Two common sources:

1. **A claim in the ID or access token** that the identity provider sets from its *own* directory, for example an organisation claim. The claim must not come from a user-editable profile attribute. If users can edit it, they can choose their tenant.
2. **A user → tenant mapping** owned by your control plane (`subject` or `email_verified` email → tenant). Use the token's `sub` (stable) plus the issuer, not the display name or an unverified email.

If one user can belong to **several tenants** (consultants, support staff), the tenant becomes a *choice*. The user picks one in the UI, the BFF **checks membership** on every request (or stores the choice in the server-side session after checking), and nothing from the browser is used without that check.

Azure-MT (*Map requests to tenants* and *Identity approaches for multitenant solutions*) discusses exactly these options: tenant from token claims, from host name, or from a lookup, and the risk of trusting request data. AWS-Fund covers the same ground under *tenant context* and identity.

```java
public class TenantResolutionFilter extends OncePerRequestFilter {
    private final UserTenantDirectory directory;   // control-plane mapping

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        if (req.getHeader("X-Tenant-Id") != null) {                       // never from the browser
            res.sendError(HttpServletResponse.SC_BAD_REQUEST, "tenant header not allowed");
            return;
        }
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (!(auth != null && auth.getPrincipal() instanceof OidcUser user)) {
            res.sendError(HttpServletResponse.SC_UNAUTHORIZED);
            return;
        }
        Optional<String> tenant = directory.tenantFor(user.getIssuer().toString(), user.getSubject());
        if (tenant.isEmpty()) { res.sendError(HttpServletResponse.SC_FORBIDDEN); return; }   // fail closed
        TenantContext.set(tenant.get());
        try { chain.doFilter(req, res); } finally { TenantContext.clear(); }
    }
}

@Bean
SecurityFilterChain ui(HttpSecurity http, UserTenantDirectory dir) throws Exception {
    http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
        .oauth2Login(Customizer.withDefaults())
        .addFilterAfter(new TenantResolutionFilter(dir), AuthorizationFilter.class);
    return http.build();
}
```

**Strip or reject?** Rejecting with 400 is better than silently stripping. It surfaces probing, and it catches front-end code that still sends the header. Count it as a security metric. Either way, the header must not reach the context.

**Filter order** [SpringSec]: Spring Security runs as one servlet filter (`DelegatingFilterProxy` → `FilterChainProxy`), which picks a `SecurityFilterChain` and runs its filters in a defined order. Our filter needs the authenticated `SecurityContext`, so it goes **after** authentication. Adding it after `AuthorizationFilter` means it runs only for requests that passed authorization. If your authorization rules need the tenant, place it before `AuthorizationFilter` but after the authentication filters. Print the chain at startup (Spring Security logs it at DEBUG) and check it.

**Trap: the filter declared as a `@Component`.** Spring Boot registers every `Filter` bean with the servlet container automatically. That runs it **a second time, outside and before** the Security chain, before authentication. The Spring Security reference warns about this in *Declaring Your Filter as a Bean*. Either don't make it a bean, or add a `FilterRegistrationBean` with `setEnabled(false)`.

#### The lenient filter (anti-pattern)

```java
// "Convenient for testing and for internal callers"
String t = req.getHeader("X-Tenant-Id");
if (t != null) TenantContext.set(t);                    // trusts the browser
else TenantContext.set(directory.tenantFor(user));
```

This turns every logged-in user of any tenant into a user of **every** tenant: send `X-Tenant-Id: globex` and you are Globex. It usually arrives as "needed for the integration tests" or "the admin UI needs to switch tenants". Solve those properly: test profiles that wire a test directory, and an admin role whose tenant switch is checked against an allow-list and audited.

#### Cross-tenant access is OWASP A01 (IDOR)

OWASP Top 10 A01 *Broken Access Control* [OWASP-A01] explicitly lists viewing or editing someone else's account or data by changing an identifier: **insecure direct object references** (CWE-639, *Authorization Bypass Through User-Controlled Key*). In multi-tenant terms there are two forms:

| Form | Example | Defence |
|---|---|---|
| **Tenant IDOR** | Forged `X-Tenant-Id`, `?tenant=globex`, a tenant in the JSON body | Tenant only from authenticated identity. Reject client tenant input. |
| **Object IDOR inside the right context** | `GET /trades/9001`, where trade 9001 belongs to another tenant | Every lookup is tenant-scoped: schema per tenant or RLS makes the other tenant's row *not exist*. With shared tables and no RLS, *every* query must filter. Return 404, not 403, so you don't confirm the object exists. |

OWASP A01 also recommends **deny by default** and **logging access-control failures**. That is our "fail closed" rule and the forged-header metric.

**Internal services trust `X-Tenant-Id` only from authenticated callers.** The BFF and ingester are the edges. Internal services must be unreachable from the browser (network policy, no public ingress), and should authenticate callers (mTLS or service tokens). If an internal service is ever exposed, its header filter becomes a lenient filter.

### 2.2 Noisy neighbour (12 min)

Noisy neighbour = one tenant's load degrades others sharing a resource [Azure-MT *Noisy Neighbor antipattern*]. [AWS-Iso] and [Golding] both treat it as a core cost of pooling and recommend tiering and throttling. [SRE-Overload] gives the operational principles: **per-customer limits** (quotas), rejecting work early and cheaply when overloaded, client-side (adaptive) throttling, and criticality, so that more important work is shed last.

```
 IN.ACME   ─┐                                   admission control at the INGESTER
 IN.HOOLI  ─┼─► [ingester: per-tenant listener ]─► shard queues ─► parser consumers
 IN.GLOBEX ─┘    concurrency + rate limit/tenant                    (concurrency per shard)
   ▲                         │
   └── per-customer source queues are natural BUFFERS:
       slowing one tenant's listener only grows THAT tenant's queue
```

| Control | Where in our pipeline | Notes |
|---|---|---|
| **Quota** | Control plane: messages/day, storage per tenant, per tier | Measured from metering. Enforced at the ingester (stop consuming, alert, contract conversation). |
| **Rate limit** | Ingester listener per tenant (token bucket per tenant ID), BFF per tenant | Slowing the ingester's consumption from `IN.<tenant>` is free back-pressure: the customer's messages wait on *their* queue. |
| **Bulkhead** | Separate listener containers per shard and per dedicated tenant; separate executor per tier; per-tenant pools for `DATABASE` tenants | One shard's poison messages or slow DB can't take all consumer threads. |
| **Consumer concurrency per shard** | `concurrency="2-8"` per shard listener; more for hot shards | Message groups limit useful parallelism to the number of active groups. |
| **Load shedding** | BFF: return 429/503 early for low-criticality requests; ingester: pause low-tier tenants first | Shed before resources are exhausted. Retries must back off, or they make it worse [SRE-Overload]. |
| **Tiering** | Move heavy tenants to dedicated queues and their own DB | The structural fix when limits are not enough. |

### 2.3 Observability per tenant (10 min)

**Logs:** put `tenantId` in the SLF4J **MDC** at the same boundary where you set `TenantContext`, and remove it in the same `finally`. MDC is itself a `ThreadLocal`, so it has the same propagation problems (Day 3). Register it with Micrometer context propagation as well. ⚠ UNVERIFIED: the context-propagation library ships an SLF4J MDC accessor; check the class name for your version.

```java
TenantContext.set(t); MDC.put("tenantId", t);
try { ... } finally { MDC.remove("tenantId"); TenantContext.clear(); }
```

**Metrics and cardinality.** Each distinct combination of tag values is a separate time series.

```
 series = metrics × tenants × (other tag combos) × (histogram buckets, if any)
 e.g.    40 timers × 300 tenants × 5 stages × ~30 buckets  ≈ 1.8 million series   ✗
         6 key metrics × 300 tenants × 5 stages            ≈ 9,000 series         ✓
```

Rules:

- Put `tenant` only on a **small set of key metrics**: messages in/out, errors, DLQ depth, processing lag or queue age, maybe one latency timer *without* histogram buckets.
- Everything else gets a `tier` tag (a handful of values), or no tenant tag. Use logs and traces (which carry the tenant in the MDC or span attributes) to dig into a single tenant.
- Enforce it in code with a Micrometer `MeterFilter`, so nobody adds the tag by accident:

```java
@Bean
MeterFilter tenantTagOnlyOnKeyMetrics() {
    Set<String> allowed = Set.of("pipeline.messages", "pipeline.errors", "pipeline.dlq.depth", "pipeline.lag");
    return new MeterFilter() {
        @Override
        public Meter.Id map(Meter.Id id) {
            if (allowed.contains(id.getName())) return id;                  // keep tenant on key metrics
            return id.replaceTags(id.getTags().stream()
                    .filter(t -> !t.getKey().equals("tenant")).toList());   // strip it everywhere else
        }
    };
}
```

The point is that the allow-list lives in one place.

**Dashboards and alerts:** an overview by **tier** plus a "top 10 tenants by lag/errors" panel. A per-tenant drill-down dashboard, parameterised by tenant. **Per-tenant alerts** on error ratio, DLQ depth and lag, so one small tenant's total outage isn't averaged away by 299 healthy tenants. That is the single most common blind spot after moving to shared deployments.

### 2.4 Tenant lifecycle: onboarding and offboarding (8 min)

[Azure-MT *Tenant lifecycle*], [AWS-Fund] (onboarding as a control-plane service).

```
 ONBOARDING (idempotent, each step re-runnable)
  1. registry entry, state=PROVISIONING   (services ignore non-ACTIVE tenants: fail closed)
  2. create schema / database; run full migration changelog
  3. create queues (dedicated tier) / compute shard & persist it; broker authz for IN.<tenant>
  4. per-tenant config (settings, rules, limits); IdP mapping / users
  5. state=ACTIVE  -> services reload registry
  6. smoke test with a synthetic message; check metrics show the tenant

 OFFBOARDING
  1. state=SUSPENDED: stop ingestion (ingester listener off), BFF login denied
  2. drain in-flight messages; handle DLQ entries for the tenant
  3. export data for the customer (if contract requires)
  4. retention period
  5. delete: DROP SCHEMA ... CASCADE / drop DB / DELETE by tenant_id; evict caches;
     delete dedicated queues; purge per-tenant logs/metrics per retention policy
  6. registry: tombstone (state=DELETED). NEVER reuse the tenant ID.
  Note: backups still contain the data until they expire -> document it.
```

The order matters. Making the registry `ACTIVE` before the schema exists is exactly the Day 2 "missing schema falls through to `public`" scenario. Reusing a tenant ID means old DLQ messages, cache entries, logs or backups can attach to the new customer.

### 2.5 Testing isolation (12 min)

Isolation is a property you **test**, not just review (AWS-Iso). Four kinds of test, each with a clear assertion:

```
 LEAK TEST           tenants A and B, SAME business keys (account 10001, ISIN, trade id)
                     act as A, act as B -> assert each sees only its own data
 FORGED-HEADER TEST  log in as A, send X-Tenant-Id: B -> assert 400, nothing of B returned
 MISSING-TENANT TEST message/request with no tenant -> assert DLQ / 4xx, nothing written
 CONCURRENCY TEST    1-thread pool, alternate A,B,A,B tasks -> assert context never stale
```

A leak test with Testcontainers (real PostgreSQL, real `search_path` behaviour, so don't use H2 for these):

```java
@SpringBootTest
@Testcontainers
class TradeRepositoryIsolationTest {
    @Container static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:16");

    @Autowired TradeRepository trades;

    @Test
    void sameBusinessKeyInTwoTenantsNeverCrosses() {
        as("acme",  () -> trades.save(new Trade("10001", "ACME-DATA")));
        as("hooli", () -> trades.save(new Trade("10001", "HOOLI-DATA")));

        assertThat(as("acme",  () -> trades.findByAccountNo("10001")))
            .extracting(Trade::payload).containsExactly("ACME-DATA");
        assertThat(as("hooli", () -> trades.findByAccountNo("10001")))
            .extracting(Trade::payload).containsExactly("HOOLI-DATA");
    }

    @Test
    void noTenantMeansNoQuery() {
        assertThatThrownBy(() -> trades.findByAccountNo("10001"))
            .isInstanceOf(MissingTenantException.class);
    }

    static <T> T as(String tenant, Supplier<T> work) {
        TenantContext.set(tenant);
        try { return work.get(); } finally { TenantContext.clear(); }
    }
}
```

A `ThreadLocal` concurrency test: force reuse with a **one-thread** pool, so a missing `clear()` or a missing decorator shows up every time, not occasionally:

```java
@Test
void asyncWorkSeesSubmittersTenantNotPrevious() throws Exception {
    ThreadPoolTaskExecutor ex = new ThreadPoolTaskExecutor();
    ex.setCorePoolSize(1); ex.setMaxPoolSize(1);
    ex.setTaskDecorator(new TenantTaskDecorator());
    ex.initialize();
    for (String t : List.of("acme", "hooli", "acme", "hooli")) {
        String seen = as(t, () -> ex.submit(() -> TenantContext.require()).get());
        assertThat(seen).isEqualTo(t);
    }
}
```

More tests worth having:

- **Missing schema:** registry says `t_newco`, schema absent → the query errors, and never reads `public`.
- **Outbound header:** with `MockRestServiceServer` or WireMock, assert every call carries `X-Tenant-Id` equal to the current tenant.
- **Architecture rules** (ArchUnit): forbid `new RestTemplate()`, `WebClient.create()`, `parallelStream()`, `@Value("${customer.`, and static mutable maps in service packages. Rules that catch the Day 1–3 traps at build time.
- **Cache leak:** same `(table, version)` for two tenants → different results.

### 2.6 Videos for today (optional)

| Search query | Watch for | Key takeaway |
|---|---|---|
| `Spring Security architecture filter chain` (SpringDeveloper / Spring I/O; Daniel Garnier-Moiroux has given well-known talks on this) | `FilterChainProxy`, filter ordering, adding a custom filter | Tenant filter goes after authentication; don't double-register it |
| `backend for frontend BFF OAuth2 Spring` | Session-based login at the BFF, tokens kept server-side | The browser never holds tokens or chooses a tenant |
| `OWASP broken access control IDOR` | Concrete IDOR examples | Deny by default; scope every lookup by tenant |
| `re:Invent SaaS noisy neighbor` / `SaaS tenant throttling tiering` | Per-tenant throttling and tier-based limits | Tiering is the structural fix; throttling the tactical one |
| `metrics cardinality explosion Prometheus` | How tags multiply series | Tenant tag on a few key metrics only |
| `Testcontainers Spring Boot integration test` | Real PostgreSQL in tests | Isolation tests need the real database behaviour |

---

## 3. Capstone (60 min)

Use the pipeline from the [README](README.md#the-running-example-a-generic-trade-processing-pipeline).

**Part A (35 min): a one-page conversion checklist** for:

1. **Parser:** stateless. Consumes `PARSE.*`, publishes to `ENRICH.*`. Uses `@Value("${customer.date-format}")` today.
2. **Enricher:** consumes `ENRICH.*`. Calls the reference-data REST service. Has two caches: instruments keyed by ISIN, and a `@Scheduled` nightly reload of a counterparty map. Uses `CompletableFuture` to call two endpoints in parallel.
3. **UI gateway (BFF):** OIDC login. Calls the reporter's REST API. Today it reads `X-Customer` from the browser "for the admin view".

For each: the boundary, propagation in and out, data access, shared state, config, flag/conditions, failure behaviour, observability.

**Part B (25 min): a test plan of 10 isolation tests** across those three services. For each test: name, setup, action, expected result, and which failure it catches.

---

## 4. Closing quiz (15 min)

**Q1.** Where must the BFF get the tenant from?

- A) The authenticated user's identity
- B) The X-Tenant-Id header the SPA sends
- C) A tenant query parameter on the URL
- D) The tenant field in the request body

**Q2.** A custom tenant filter is a `@Component` and is also added to the `SecurityFilterChain`. What is the risk?

- A) It runs twice, once before auth has run
- B) Spring Security refuses to start the app
- C) The filter runs only for anonymous users
- D) Boot ignores it since it is in the chain

**Q3.** Which metric tagging approach suits 300 tenants?

- A) Tag every timer and histogram by tenant
- B) Tag by tenant only on the histogram ones
- C) Never tag anything by tenant ID at all
- D) Tag a few key metrics by tenant, not all

**Q4.** What is the first step of offboarding?

- A) Drop the tenant's schema and its queues
- B) Suspend ingestion and login for tenant
- C) Reuse the tenant ID for the next signup
- D) Delete the registry entry for that one

**Q5.** *(Day 3)* A `@Scheduled` job reloads a cache. The DB layer fails closed. With no tenant set, what happens?

- A) It loads every tenant's rows at once
- B) It loads the rows of the last tenant
- C) It fails, as no tenant is in context
- D) It loads rows from the public schema

**Q6.** *(Day 2)* Why test isolation against real PostgreSQL rather than H2?

- A) H2 cannot store more than two schemas
- B) H2 does not support SQL transactions
- C) Testcontainers requires real PostgreSQL
- D) search_path and RLS behaviour differs

**Q7.** *(Day 1)* Which statement about schema-per-tenant on a shared server is most accurate?

- A) It is a full silo, with no shared parts
- B) It is pooled at every layer of the stack
- C) Its schema is siloed, its server pooled
- D) It cannot be combined with shard queues

**Q8.** *(Day 3)* Tenants `hooli` and `stark` are the largest and share a shard. Best first move?

- A) Raise N so the hashes spread them out
- B) Promote one to a dedicated queue tier
- C) Add a selector per tenant on the shard
- D) Lower redelivery for the shared shard

---

## 5. Cheat sheet: Day 4

```
BFF EDGE       tenant := f(authenticated identity)   claim (IdP-owned) or user->tenant map
               client X-Tenant-Id -> 400 + metric (reject > strip)
               multi-tenant user: choice CHECKED against membership every request
               filter AFTER authentication (addFilterAfter(..., AuthorizationFilter.class))
               don't @Component it (or FilterRegistrationBean.setEnabled(false))
               lenient filter (header if present) = every user is every tenant
               OWASP A01 / IDOR (CWE-639); scope every lookup; 404 not 403
               internal services: unreachable from browser, authenticated callers

NOISY NBR      quota (per period) | rate limit (per second, token bucket per tenant)
               bulkheads: listener container per shard/dedicated, executor per tier
               ingester throttling = back-pressure into the tenant's OWN source queue
               load shedding early & cheap; retries back off   [SRE-Overload]
               structural fix = tiering (dedicated queue / own DB)

OBSERVABILITY  MDC tenantId set/cleared with TenantContext (MDC is a ThreadLocal too)
               tenant tag on ~5 key metrics only; tier tag elsewhere; MeterFilter
               per-tenant alerts on errors / DLQ / lag (averages hide one tenant)

LIFECYCLE      onboard: PROVISIONING -> schema+migrate -> queues/authz -> config -> ACTIVE -> smoke
               offboard: SUSPEND -> drain -> export -> retain -> delete everything -> tombstone
               never reuse tenant IDs; backups hold data until expiry

TESTS          leak (2 tenants, same keys) | forged header | missing tenant
               concurrency (1-thread pool, alternate tenants) | missing schema
               outbound header | cache leak | ArchUnit rules | real PostgreSQL
```

### Glossary additions (Day 4)

BFF · Tenant resolution · Tenant claim · Header stripping · Lenient filter · IDOR · Quota · Rate limit · Bulkhead · Load shedding · MDC · Cardinality · Leak test · Forged-header test · Missing-tenant test. Definitions: [glossary.md](glossary.md#day-4-the-edge-operations-and-testing).

---

## 6. Answers

### Warm-up answers

1. (a) `Math.abs(Integer.MIN_VALUE)` is negative, so you get a negative shard. (b) For negative hashes it gives a different shard than `floorMod`, so components using different formulas disagree.
2. **Drain** the tenant's in-flight messages on `shard-1` (pause its ingestion, let shard-1 empty for that tenant) before sending to `shard-3`. Message groups order only within one queue, so two queues processing the same tenant at once break per-key order.
3. Any four of: `@Async`, `ExecutorService`/`ThreadPoolTaskExecutor`, `CompletableFuture.*Async` (common pool), `parallelStream`, cache refresh/loader threads, Reactor `publishOn`/`subscribeOn`, and `@Scheduled` (a boundary with no tenant at all).
4. Table owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set, so every tenant sees all rows.
5. Assign once at the trusted edge. Pass it on (never re-derive). Hold it in a `ThreadLocal`, set at the boundary and cleared in `finally`. Fail closed, with no default tenant.

### Capstone: worked answer

#### Part A: conversion checklist

**Common to all three (the starter provides):**

- [ ] `multitenancy.enabled` typed boolean (fails on `yes`). Legacy beans: class-level `@ConditionalOnProperty(havingValue="false", matchIfMissing=true)`. New beans: `havingValue="true"`. No method-level conditions on `@JmsListener`.
- [ ] `TenantContext` (guarded `set`, `require`, `clear` = `remove`). MDC set and cleared alongside it.
- [ ] Registry loaded and validated at startup (unique IDs and source queues). Only `ACTIVE` tenants are accepted.
- [ ] `TenantRoutingDataSource` (no default target, `lenientFallback=false`) → `TenantSchemaDataSource` (per-borrow `set_config('search_path', ?, false)`, tenant schema only).
- [ ] `ContextRegistry` accessor for `tenantId` and `ContextPropagatingTaskDecorator`/`TenantTaskDecorator` bean.
- [ ] Client customizers adding `X-Tenant-Id` (`RestTemplate`/`RestClient`/`WebClient`). ArchUnit rule banning direct construction.
- [ ] `MeterFilter` allow-list for the `tenant` tag.

**1. Parser (stateless)**

- [ ] **Boundary:** shard and dedicated listeners registered from the registry. Read the `tenantId` property → `requireKnown` → set → `finally` clear.
- [ ] **Propagation out:** every send uses `destination(stage, tenantId)` and copies `tenantId`. `JMSXGroupID = tenantId:accountNo`.
- [ ] **Config:** `customer.date-format` → `TenantSettings.dateFormat()` looked up per message. Make the formatter cache tenant-keyed (formatters are thread-safe, so cache per tenant).
- [ ] **Shared state:** confirm none (no static maps, no memoised per-customer data).
- [ ] **Failure:** unknown or missing tenant, or a parse error → throw → redelivery policy (low retries for parse errors) → DLQ, keeping `tenantId`.
- [ ] **Observability:** messages/errors by tenant. Lag per shard.

**2. Enricher (REST + caches)**

- [ ] **Boundary/propagation:** as for the parser.
- [ ] **Outbound REST:** the reference-data client is built from the Boot builder with the tenant customizer. No `new RestTemplate()`. The ref-data service has an internal filter that fails closed on missing or unknown tenant.
- [ ] **`CompletableFuture`:** pass a context-propagating executor (or make the calls sequential). Never the common pool.
- [ ] **Instrument cache:** key `(tenantId, isin)`. Size for tenants × entries. Per-tenant eviction. If refresh is asynchronous, the loader sets the context **from the key**.
- [ ] **Nightly counterparty reload (`@Scheduled`):** loop over active tenants, set/try/finally clear, one transaction per tenant, keep old data on per-tenant failure, drop offboarded tenants. Map is `tenant → (code → value)`.
- [ ] **Failure:** ref-data 4xx for an unknown tenant → throw → DLQ. Ref-data 5xx → retry. Don't fall back to any cached data of another tenant.
- [ ] **Observability:** cache hit ratio by tier (not by tenant). Reload failures logged with tenant.

**3. UI gateway (BFF)**

- [ ] **Remove** the `X-Customer` header logic entirely. Any client `X-Tenant-Id`/`X-Customer` → 400 + security metric.
- [ ] `TenantResolutionFilter` after authentication. Tenant from (issuer, sub) → control-plane directory. Not a `@Component` (or registration disabled).
- [ ] **Admin view:** a separate role. Tenant switch only to tenants in that admin's allow-list, checked on every request, audited. The choice is stored in the server-side session, never taken directly from the browser.
- [ ] **Outbound:** calls to the reporter carry `X-Tenant-Id` from `TenantContext` via the builder customizer. The reporter is not reachable from the browser.
- [ ] **Object access:** reporter lookups scoped by tenant (schema/RLS). Return 404 for other tenants' IDs.
- [ ] **Noisy neighbour:** per-tenant rate limit at the BFF. 429 with `Retry-After`.
- [ ] **Observability:** forged-header count, 403s by tenant, latency by tier.

#### Part B: 10 isolation tests

| # | Test | Setup | Action | Expected | Catches |
|---|---|---|---|---|---|
| 1 | Parser leak | Tenants A, B in registry; both send a trade for account `10001` with different payloads | Run both through the parser (Testcontainers ActiveMQ + PG) | A's output only in A's flow/schema, B's only in B's | Wrong `search_path`, wrong property copy |
| 2 | Parser missing tenant | Message on `PARSE.shard-0` with no `tenantId` | Consume | After N redeliveries it is in the DLQ; nothing written anywhere | Default tenant, lenient handling |
| 3 | Parser unknown tenant | `tenantId=ghost` | Consume | DLQ; no DB borrow attempted | Missing registry check |
| 4 | Parser per-tenant config | A `dd/MM/yyyy`, B `MM/dd/yyyy`; same input `03/04/2026` | Parse as A then B | A → 3 April, B → 4 March | Startup-frozen config |
| 5 | Enricher outbound header | WireMock ref-data | Enrich for A, then B | Each request carries the matching `X-Tenant-Id`. Fails if any request has none. | `new RestTemplate()`, lost context in `CompletableFuture` |
| 6 | Enricher cache leak | Ref-data returns different data for A and B for the same ISIN | Enrich A, then B (cache warm) | B gets B's data; 2 calls to ref-data | Cache key without tenant |
| 7 | Enricher scheduled reload | Two tenants with different counterparty maps | Trigger `reload()`, then look up the same code as A and as B | Different results. Reload with no tenants does not throw away existing entries. | Scheduler with no tenant / default schema |
| 8 | `ThreadLocal` reuse | One-thread executor with the decorator | Submit A, B, A, B tasks | Each task sees its submitter's tenant. A task submitted with no tenant sees none. | Missing decorator or `clear()` |
| 9 | BFF forged header | User of tenant A logged in (mock OIDC) | `GET /api/trades` with `X-Tenant-Id: B` (and `X-Customer: B`) | 400; security metric incremented; reporter not called | Lenient filter, legacy header |
| 10 | BFF object IDOR | Trade 9001 exists in B only | User of A calls `GET /api/trades/9001` | 404; the reporter was called with `X-Tenant-Id: A` | Unscoped lookup, tenant from the URL |

Also worth adding: a missing-schema test (registry `ACTIVE`, schema absent → error, never `public`), and a BFF test where a user with no tenant mapping gets 403.

### Quiz answers

| Q | Answer | Why |
|---|---|---|
| 1 | **A** | The browser controls headers, query parameters and body. Only the authenticated identity is evidence. |
| 2 | **A** | Boot auto-registers `Filter` beans with the container, so it also runs outside and before the security chain. |
| 3 | **D** | A few key metrics with a tenant tag keeps the series count bounded. Use logs and traces for depth. |
| 4 | **B** | Stop new work first. Deletion comes last. IDs are never reused. |
| 5 | **C** | Fail closed: no tenant → the data source throws. (It's still a bug to fix: loop over tenants.) |
| 6 | **D** | The whole point is PostgreSQL's real `search_path`/RLS/temp-table behaviour. H2 differs. |
| 7 | **C** | Schema-level silo on a pooled server (bridge-ish). |
| 8 | **B** | Tiering fixes a hot shard without moving everyone. Raising N moves ~80% of tenants. |
