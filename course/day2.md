# Day 2: Data Isolation

**Time:** 2.5 h · **Glossary:** [glossary.md](glossary.md) · **Running example:** [README](README.md#the-running-example-a-generic-trade-processing-pipeline)

**Objectives.** By the end of today you can:

- compare database-per-tenant, schema-per-tenant and shared tables (with RLS) on isolation, cost, migrations, connections, backup/restore and noisy neighbour;
- predict exactly what PostgreSQL does with `search_path` in tricky cases: `SET` vs `SET LOCAL`, a missing schema, `public`, temp tables, a transaction that spans a tenant switch;
- design HikariCP pooling for many tenants, and explain why the switch must happen on every borrow;
- choose between a routing data source and a switch-on-borrow wrapper (and combine them);
- plan Liquibase migrations for hundreds of tenant schemas;
- find cross-tenant leaks in caches, locks and in-memory maps.

---

## 1. Retrieval warm-up (10 min): Day 1

From memory. Answers are at the end.

1. Name the two places in our pipeline where a tenant is *assigned*, and what evidence each one uses.
2. Why is "schema per tenant in a shared database" not a pure silo?
3. Give three reasons a provider moves from per-customer deployments to a shared one, and two risks it accepts.
4. Why must `TenantContext.clear()` run in `finally` in a JMS listener?
5. Where does `@ConditionalOnProperty` work, and where is it silently ignored?

---

## 2. Core study (70–75 min)

### 2.1 The three data approaches (15 min)

```
 DATABASE PER TENANT          SCHEMA PER TENANT                SHARED TABLES (+RLS)
 +-----------+ +-----------+  +-----------------------------+  +----------------------------+
 | db_globex | | db_stark  |  | db pg-shared-1              |  | db pg-pool-1               |
 |  trades   | |  trades   |  |  t_acme.trades              |  |  trades                    |
 |  refdata  | |  refdata  |  |  t_hooli.trades             |  |   tenant_id | trade_id |..|
 +-----------+ +-----------+  |  t_umbrella.trades  ...     |  |   acme      | 10001    |  |
  own pool each               |  one pool, search_path/borrow|  |   hooli     | 10001    |  |
                              +-----------------------------+  |  policy: tenant_id = ctx   |
                                                               +----------------------------+
   SILO                         schema-level SILO on POOLED       POOL
                                server ("bridge-ish")
```

Golding and AWS-Iso both describe these three options under data partitioning. Azure-MT (*Storage and data approaches*, and its PostgreSQL service page) gives the same three choices and lists sharding and deployment stamps on top of them.

| Concern | Database per tenant | Schema per tenant | Shared tables + `tenant_id` |
|---|---|---|---|
| **Isolation strength** | Strongest. A wrong connection is the only way to leak. | Good. A wrong `search_path` leaks. | Weakest by default. One missing `WHERE` leaks. RLS raises it a lot. |
| **Cost per tenant** | High. Per-DB overhead, often per-server. | Low to medium. Catalogue grows per schema. | Lowest. |
| **Migrations** | N databases to migrate | N schemas to migrate (fan-out) | One migration. But it is a big table, so watch locks. |
| **Connections** | One pool per DB × pods: grows fast | One pool per server | One pool |
| **Backup / restore one tenant** | Easy: `pg_dump` / restore that DB | Fairly easy: `pg_dump -n t_acme` | Hard: filtered export. A point-in-time restore of one tenant means restoring everyone or doing surgery. |
| **Noisy neighbour** | Isolated if the server is separate | Shared CPU, I/O, WAL, autovacuum | Shared, *plus* shared indexes and table bloat |
| **Per-tenant customisation** | Possible (risky) | Possible (risky) | No |
| **Moving a tenant** | Move the DB | `pg_dump -n` and restore elsewhere | Copy rows by `tenant_id` |

**Row-level security (RLS)** makes shared tables enforce the filter inside the database [PG-RLS]:

```sql
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades FORCE ROW LEVEL SECURITY;      -- also apply to the table owner
CREATE POLICY tenant_isolation ON trades
  USING      (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
```

Facts to remember from PG-RLS:

- Superusers and roles with `BYPASSRLS` always bypass RLS. The **table owner** bypasses it too, unless you use `FORCE ROW LEVEL SECURITY`. So the app must not connect as the owner or as a superuser. This is the most common RLS mistake.
- `current_setting('app.tenant_id', true)` returns NULL if the setting is not set (the `true` means "missing is ok"). `tenant_id = NULL` is never true, so **no rows** are visible. That is fail closed. Without `true`, it raises an error, which is also fail closed.
- The setting is set per borrow, exactly like `search_path` (section 2.3).

> **Meeting line:** "Shared tables without RLS put isolation in every query a developer writes. Schema per tenant puts it in one place, the borrow. RLS puts it in the database."

### 2.2 PostgreSQL schemas and `search_path` in depth (20 min)

#### How name lookup works [PG-Schemas], [PG-Client]

An *unqualified* name such as `trades` is looked up schema by schema along `search_path`. The first schema that contains a matching object wins.

```
 search_path = t_acme, public           (pg_catalog is implicitly searched FIRST,
                                          pg_temp is implicitly searched first for
 SELECT * FROM trades                     tables/views, unless listed explicitly)
        |
        v
 [pg_temp?] -> [pg_catalog] -> [t_acme] -> [public]
   temp table    system          found!       (never reached)
   'trades'?     tables
```

- **Default** `search_path` is `"$user", public` [PG-Client].
- **`pg_catalog`** is searched first unless you put it in the path explicitly [PG-Client].
- **`pg_temp`** (the session's temporary schema) is searched *before* `pg_catalog` for relations, unless listed. It is never searched for functions or operators [PG-Client].
- **Schemas that don't exist are skipped silently** when names are looked up [PG-Client]. *This is the dangerous one.* See below.
- **Current schema** = the first schema in the path that exists. New unqualified objects are created there. If no listed schema exists, `CREATE` fails with "no schema has been selected to create in" [PG-Schemas].

#### Trap 1: a missing tenant schema falls through to `public`

```
 search_path = t_newco, public       -- t_newco not created yet (onboarding bug)
 SELECT * FROM trades;               -- t_newco skipped silently -> public.trades
```

If `public.trades` exists (left from the old single-customer layout, a test fixture, or a migration that ran with the wrong path), every query for `newco` reads and writes the **shared `public` table**. If a second half-onboarded tenant hits the same fallback, the two now share data.

**Rules:**

1. Set `search_path` to **only** the tenant schema: `SET search_path TO t_acme`. Don't add `public`. If you need extensions, put them in a dedicated `ext` schema and list it *after* the tenant: `t_acme, ext`.
2. Keep `public` empty, and remove `CREATE` on it from the app role (PostgreSQL 15 already stopped granting `CREATE` on `public` to all users by default; check your version [PG-Schemas]).
3. Check that the schema exists **at borrow time**, or at least at onboarding and startup, against the registry.

#### Trap 2: `SET` vs `SET LOCAL` vs `set_config` [PG-SET]

| Command | Lasts until | Inside a transaction that rolls back | Outside a transaction |
|---|---|---|---|
| `SET search_path TO t_acme` (= `SET SESSION`) | end of session (the pooled *connection*) | **reverted** on rollback | applies to the session |
| `SET LOCAL search_path TO t_acme` | end of current transaction | reverted | **no effect**, with a warning |
| `SELECT set_config('search_path', 't_acme', false)` | session (like `SET`) | reverted on rollback | applies |
| `SELECT set_config('search_path', 't_acme', true)` | transaction (like `SET LOCAL`) | reverted | no lasting effect |

Two consequences for a pool:

- A session-level `SET` **survives returning the connection to the pool**. The next borrower inherits the previous tenant's path unless you set it again. That's why we switch on **every borrow**.
- `SET LOCAL` would reset itself at commit, which is attractive. But it only works inside an explicit transaction. With autocommit (Spring Data reads outside `@Transactional`, for example) it does nothing, and the query runs with whatever path the connection already had.
- The "reverted on rollback" row is a trap for wrappers. If you `SET` at borrow and the *first* transaction on that borrow rolls back, and the `SET` ran **inside** that transaction (because autocommit was already off), the path goes back to the previous tenant's. Make sure the borrow-time `SET` runs in autocommit mode, before Spring begins the transaction. A wrapper on `DataSource.getConnection()` normally satisfies this, because the transaction manager turns off autocommit *after* it gets the connection.

`SET` cannot take a bind parameter. Either use `set_config('search_path', ?, false)`, which takes a value, or build the SQL from a **registry-validated, quoted identifier**. Never use a raw string from a header or message. Tenant IDs reaching SQL are an injection vector.

#### Trap 3: temp tables live per *session*, and sessions are shared

A temp table lives as long as the **connection**, unless you create it with `ON COMMIT DROP`. On a pooled connection, tenant A's `CREATE TEMP TABLE staging_trades` is still there when tenant B borrows that connection. Because `pg_temp` is searched *first* for tables, B's unqualified `staging_trades` (or worse, a temp table named like a real table) resolves to A's temp data.
Rule: use `CREATE TEMP TABLE ... ON COMMIT DROP`, or `DISCARD TEMP` on return. Better still, avoid temp tables in shared services.

#### Trap 4: a transaction that spans a tenant switch

The `search_path` is set **when the connection is borrowed**. Spring binds that connection to the thread for the whole transaction. If code inside the transaction changes `TenantContext` (a loop over tenants, say), **no new borrow happens**, so the path doesn't change.

```
 @Transactional
 void nightly() {                 borrow -> SET search_path TO t_acme
   for (t : tenants) {            TenantContext = hooli ... but connection unchanged
     TenantContext.set(t);
     repo.save(summary(t));       --> written to t_acme.summary  (LEAK)
   }
 }
```

Rule: **one tenant per transaction**. Loop *outside* the transactional method, and open a fresh transaction per tenant. Add a guard: on every statement, or on transaction begin, assert that the connection's tenant equals `TenantContext.require()` (exercise 2.1).

#### Note: prepared statements

The PostgreSQL docs for `PREPARE` say that since 9.3 a prepared statement is re-parsed when `search_path` has changed since its last use. So server-side prepared statements cached by pgJDBC don't keep pointing at the old tenant's tables. ⚠ UNVERIFIED for every driver and cache combination. Include a test (Day 4) instead of relying on it.

### 2.3 Connection pooling with HikariCP (15 min)

#### Why per-borrow, not per-connection

HikariCP's `connectionInitSql` runs **once, when a physical connection is created** [Hikari]. That's no good for per-tenant switching: the connection lives for minutes and serves many tenants.

HikariCP *does* reset some connection state when a connection goes back to the pool: the properties you changed **through the JDBC API**, such as auto-commit, transaction isolation, read-only, catalog, and schema via `Connection.setSchema` [Hikari]. ⚠ UNVERIFIED: the exact list. Read the README section on how Hikari tracks "dirty" state for your version. It **cannot** know about a `SET search_path` you ran as SQL. So:

```
            borrow                     use                     return
 pool --> [conn: path=t_acme] --> tenant hooli's query --> [conn: path=t_acme]  ← unchanged!
          (left by last user)     reads t_acme (LEAK)       Hikari didn't reset SQL-level SET
```

**Rule: set it on every borrow.** Optionally reset it to a "no tenant" schema on return, as a second line of defence.

```java
public class TenantSchemaDataSource extends DelegatingDataSource {
    private final TenantRegistry registry;

    public TenantSchemaDataSource(DataSource pooled, TenantRegistry registry) {
        super(pooled);
        this.registry = registry;
    }

    @Override
    public Connection getConnection() throws SQLException {
        String tenantId = TenantContext.require();                   // fail closed
        String schema = registry.requireSchemaFor(tenantId);         // validated identifier, e.g. t_acme
        Connection c = super.getConnection();
        try (PreparedStatement ps = c.prepareStatement("SELECT set_config('search_path', ?, false)")) {
            ps.setString(1, schema);                                 // only the tenant schema, no public
            ps.execute();
        } catch (SQLException e) {
            c.close();                                                // don't leak the connection
            throw e;
        }
        return c;
    }
}
```

Alternative: call `c.setSchema(schema)`. The PostgreSQL JDBC driver implements this by setting `search_path`, and HikariCP tracks `setSchema` and resets it on return. ⚠ UNVERIFIED: confirm your pgJDBC version sets a single-schema `search_path` and quotes it. Test it.

For **RLS**, do the same with `set_config('app.tenant_id', ?, false)`.

#### Pool per database vs one pool with switching

```
 SCHEMA tenants (300):     one Hikari pool -> pg-shared-1      (switch on borrow)
 DATABASE tenants (5):     5 Hikari pools  -> db_globex, db_stark, ...
                           (each pool still needs the tenant check, no switch needed)
```

**Pool sizing with many tenants.** The HikariCP wiki page *About Pool Sizing* argues that pools should be **small**. It quotes a PostgreSQL starting formula: `connections = (core_count × 2) + effective_spindle_count` per database server [Hikari wiki]. Do the arithmetic *per server* across all pods:

```
 total connections to a server = pods × pools_on_that_server × maximumPoolSize
 example: 6 parser pods × 1 shared pool × 10 = 60    OK
 example: 6 pods × 40 DB-per-tenant pools on ONE server × 10 = 2,400   NOT OK
 PostgreSQL max_connections default = 100  [PG runtime-config-connection]
```

So database-per-tenant on a shared server multiplies connections. Options: few connections per tenant pool (`maximumPoolSize=2`, `minimumIdle=0`, short `idleTimeout`), only put DB-per-tenant on separate servers, or put PgBouncer in front of it.
**PgBouncer warning:** in *transaction* pooling mode, a session `SET search_path` can leak to another client, because server connections are shared per transaction. You must then use `SET LOCAL` / `set_config(..., true)` inside every transaction. That brings back the autocommit trap above. ⚠ UNVERIFIED: check the PgBouncer docs (*Feature map for pooling modes*) for your version.

#### Connection leaks with the wrong path

A connection that is borrowed and never closed (forgotten `close()`, a stream that isn't closed, a connection stored in a field) has two effects. The pool shrinks until requests time out. And if the leaked connection is ever *reused* by code that doesn't borrow again (e.g. held in a `ThreadLocal`, or by a long-lived JDBC-based job), it keeps the original tenant's path. Use HikariCP's `leakDetectionThreshold` [Hikari] in test and staging to log the stack trace of the borrower.

### 2.4 Routing data source vs switch-on-borrow wrapper (8 min)

Spring's `AbstractRoutingDataSource` [javadoc] picks a target `DataSource` on each `getConnection()` by calling `determineCurrentLookupKey()`:

```java
public class TenantRoutingDataSource extends AbstractRoutingDataSource {
    @Override
    protected Object determineCurrentLookupKey() {
        return registry.placementKey(TenantContext.require());   // "shared-1" or "db_globex"
    }
}
// setTargetDataSources(Map.of("shared-1", schemaSwitchingDs, "db_globex", globexPool, ...));
// setLenientFallback(false); and DO NOT set a defaultTargetDataSource.
```

**Fail-closed detail from the javadoc:** if the lookup key is `null`, or not found while `lenientFallback` is `true` (the default), `AbstractRoutingDataSource` falls back to the **default target data source**, when one is set. That is a "default tenant" by another name. Don't set a default target, and call `setLenientFallback(false)`. Then an unknown key throws `IllegalStateException`. Better still, `require()` throws before that.

**How the two combine:**

```
 getConnection()
   -> TenantRoutingDataSource        picks WHICH DATABASE (pool) by placement
        -> "shared-1": TenantSchemaDataSource -> Hikari(shared-1)   SET search_path per borrow
        -> "db_globex": Hikari(globex)                              no switch needed
```

| | Routing DS | Switch-on-borrow wrapper |
|---|---|---|
| Solves | Database per tenant | Schema per tenant / RLS on one DB |
| Pools | One per target | One |
| Fails how | Wrong key → wrong DB | Stale path → wrong schema |

Both decide **at borrow time**. Inside a transaction the connection is fixed (Trap 4). Hibernate also has built-in multi-tenancy (`MultiTenantConnectionProvider` + `CurrentTenantIdentifierResolver`, and `@TenantId` for discriminator columns in Hibernate 6). See the Hibernate ORM user guide, *Multitenancy*. It follows the same rules and needs the same tests.

### 2.5 Schema migrations for hundreds of tenants (Liquibase) (7 min)

With schema per tenant, one Liquibase changelog must run once **per schema**, and Liquibase keeps its `DATABASECHANGELOG` and `DATABASECHANGELOGLOCK` tables in each schema. You can point it at a schema with the `defaultSchemaName` setting (and `liquibaseSchemaName` for the tracking tables). ⚠ UNVERIFIED: property names for your Liquibase version; check the Liquibase docs on parameters.

```
 migration job (not app startup!)
   for each tenant in registry where isolation in (SCHEMA, DATABASE), in batches of k:
       run changelog against t_<tenant>   -> record success/failure per tenant
   report: 297 ok, 3 failed (t_x, t_y, t_z) -> those tenants stay on old version
```

**Decisions to make explicitly:**

1. **Not at app startup.** Spring Boot runs Liquibase at startup by default when it's on the classpath. With 300 schemas × several pods starting at once, that means slow starts and lock contention. Set `spring.liquibase.enabled=false` in the shared services and run a dedicated migration job.
2. **Order:** tenants migrate one after another, so for a while *some tenants are on the new schema and some on the old*. The deployed code must work with **both**. Use **expand → migrate → contract**: add the new nullable column, deploy code that writes both, backfill, switch reads, then later drop the old column.
3. **One tenant fails:** don't stop the world. Record it, carry on with the others, and alert. The failed tenant must not get traffic that needs the new schema. You can keep it on the old code path or pause its consumption. Make migrations idempotent and re-runnable.
4. **Rollout time:** `tenants × time-per-tenant / parallelism`. 300 × 20 s / 10 parallel = 10 min. A slow `ALTER TABLE` on one big tenant dominates, so test with the largest tenant's data size.
5. **Onboarding** runs the *full* changelog on a new empty schema. It uses the same job, with one tenant.

### 2.6 Caches are data too (10 min)

Everything in memory that holds tenant data is a *shared table with no `WHERE` clause* unless its key includes the tenant. That covers caches, memoised maps, locks, rate-limit counters and "last seen" maps.

```
 cache key (table, version)            cache key (tenant, table, version)
 +-------------------------+            +----------------------------------+
 | ("instruments", 42) ->  |            | ("acme",  "instruments", 42) ->  |
 |     acme's instruments  |            | ("hooli", "instruments", 42) ->  |
 +-------------------------+            +----------------------------------+
   hooli asks ("instruments",42)          each tenant gets its own entry
   gets ACME's data  <-- LEAK
```

**A real-world style leak.** The enricher caches reference data per table and version: `cache.get(new Key(table, version))`. In the per-customer world, that key was unique. In the shared world, `acme` and `hooli` both have `instruments` at version 42 (versions are per-tenant counters that start at 1). Hooli's lookup returns ACME's instrument list. No error and no exception, just wrong data, which then drives rules and reports. It appears only when two tenants happen to have the **same version number**, so it is intermittent.

**Spring's `@Cacheable`.** The default key is built from the **method parameters only** (Spring Framework reference, *Cache Abstraction → Default Key Generation*). The tenant is not a parameter, so it is not in the key. Fix it with a custom `KeyGenerator`, or `key = "T(com.example.TenantContext).require() + ':' + #table + ':' + #version"`, or a tenant-scoped cache name per tenant.

```java
@Bean
KeyGenerator tenantKeyGenerator() {
    return (target, method, params) ->
        new TenantKey(TenantContext.require(), method.getName(), List.of(params));
}
// @Cacheable(cacheNames = "refdata", keyGenerator = "tenantKeyGenerator")
```

**Checklist of shared state to key by tenant:**

- caches (`@Cacheable`, Caffeine, Redis): put the tenant in the key, *or* a prefix per tenant in Redis;
- static or singleton `Map`s, memoised lookups;
- distributed and local locks (e.g. ShedLock lock names, `synchronized` on interned strings): include the tenant, or one tenant's job blocks everyone else's;
- counters and rate limiters (Day 4);
- idempotency / de-duplication stores: business keys like `tradeId` repeat across tenants;
- sequence or ID generators, if IDs are only unique per tenant.

**Eviction is per tenant too.** Offboarding and data correction must be able to evict one tenant's entries.

### 2.7 Videos for today (optional)

| Search query | Watch for | Key takeaway |
|---|---|---|
| `PostgreSQL multi-tenant schema per tenant vs row level security` | How the speaker handles connection counts and migrations at hundreds of tenants | Note where they put the enforcement point |
| `PostgreSQL row level security multi tenant` (prefer PGConf / Citus / Crunchy Data talks) | `FORCE ROW LEVEL SECURITY`, app role vs owner, `current_setting` | Owner and superuser bypass RLS |
| `HikariCP pool sizing` | The argument for small pools | Do the sum *per DB server across all pods* |
| `Spring AbstractRoutingDataSource multi tenant` | When the lookup happens relative to `@Transactional` | Lookup happens on borrow; a transaction pins it |
| `re:Invent SaaS data partitioning` (Tod Golding or the AWS SaaS Factory team) | Silo / bridge / pool for data, and per-tenant restore | Restore and migration cost often decide the model |

---

## 3. Hands-on exercises (45 min)

### Exercise 2.1: Review four snippets for cross-tenant leaks (25 min)

For each snippet: is there a leak? Describe the exact scenario (which tenant sees what), then fix it.

**Snippet A: the reference-data cache**

```java
@Service
class RefDataCache {
    private final Cache<RefKey, List<Row>> cache = Caffeine.newBuilder().maximumSize(10_000).build();
    record RefKey(String table, long version) {}

    List<Row> rows(String table, long version) {
        return cache.get(new RefKey(table, version), k -> repo.load(k.table(), k.version()));
    }
}
```

**Snippet B: the nightly roll-up**

```java
@Service
class RollupService {
    @Transactional
    public void rollupAll(List<String> tenantIds) {
        for (String t : tenantIds) {
            TenantContext.set(t);
            try {
                summaryRepo.save(new Summary(LocalDate.now(), tradeRepo.countToday()));
            } finally {
                TenantContext.clear();
            }
        }
    }
}
```

**Snippet C: the static mapping table**

```java
@Component
class CounterpartyMapper {
    private static final Map<String, String> LEI_BY_CODE = new ConcurrentHashMap<>();

    String lei(String cptyCode) {
        return LEI_BY_CODE.computeIfAbsent(cptyCode, code -> jdbc.queryForObject(
            "select lei from counterparty where code = ?", String.class, code));
    }
}
```

**Snippet D: the data source configuration**

```java
@Bean
DataSource dataSource(TenantRegistry registry) {
    HikariConfig cfg = new HikariConfig();
    cfg.setJdbcUrl("jdbc:postgresql://pg-shared-1/app");
    cfg.setConnectionInitSql("SET search_path TO " + registry.schemaFor(TenantContext.current().orElse("public")));
    return new HikariDataSource(cfg);
}
```

### Exercise 2.2: What does this query see? (5 min)

The app role has the session state shown in each row. What does `SELECT count(*) FROM trades` read? Choose from: `t_acme.trades`, `public.trades`, a temp table, error.

1. `search_path = t_newco, public`. `t_newco` does not exist. `public.trades` exists.
2. `search_path = t_acme`. Earlier on this same pooled connection, tenant `hooli` ran `CREATE TEMP TABLE trades AS SELECT ...`.
3. Autocommit on. The code ran `SET LOCAL search_path TO t_acme`, then the query. The connection's previous path was `t_hooli`.
4. `search_path = t_newco`. `t_newco` does not exist, and `public` is not in the path.

### Exercise 2.3: Choose a data approach (15 min)

Choose database per tenant, schema per tenant, or shared tables + RLS for each profile. Justify your choice with at least **three** of: isolation, cost, migrations, connections, backup/restore, noisy neighbour. Say what you would watch for.

1. **Globex:** one of the 3 largest customers, 40% of all trade volume. Contract requires restoring *their* data to any point in the last 7 days within 4 hours. Their auditors want "physically separate storage".
2. **The long tail:** 280 small tenants, each < 0.1% of volume, self-service sign-up planned for next year, low price point.
3. **Mid-size regional banks:** 25 tenants, steady volume, ask for per-tenant export on demand, sometimes need a data correction for one tenant only, no special contract terms.

---

## 4. Closing quiz (15 min)

**Q1.** `search_path` is `t_newco, public`. `t_newco` does not exist. What does `SELECT * FROM trades` do?

- A) Fails with an error about a missing schema
- B) Skips t_newco and reads from public.trades
- C) Returns zero rows because t_newco is empty
- D) Creates t_newco and then reads its trades

**Q2.** Why does HikariCP's `connectionInitSql` not suit per-tenant `search_path` switching?

- A) It runs only once per physical connection
- B) It runs only on the first borrow per thread
- C) It cannot run SET statements in PostgreSQL
- D) It runs after the transaction has started

**Q3.** An `AbstractRoutingDataSource` has a default target set and keeps `lenientFallback` at its default. The tenant is unknown. What happens?

- A) It throws an IllegalStateException at once
- B) It waits for the registry to be reloaded
- C) It opens a new pool for the unknown tenant
- D) It routes to the default target data source

**Q4.** A `@Cacheable` method takes `(table, version)` and uses the default key generator. In a shared service, the key:

- A) includes only the table and version values
- B) includes the tenant via the thread context
- C) includes the bean name plus the parameters
- D) is randomised per tenant by Spring itself

**Q5.** *(Day 1)* Which statement about isolation is correct?

- A) Only silo placements need isolation tests
- B) Pool placements cannot be made isolated
- C) Isolation must be enforced in every model
- D) Isolation is a deployment shape, not code

**Q6.** The app connects to PostgreSQL as the **table owner**, and the table has RLS enabled but not forced. What do queries see?

- A) Only rows matching the tenant policy
- B) No rows until a policy gets attached
- C) All rows; the owner bypasses the policy
- D) An error: the owner may not query it

**Q7.** *(Day 1)* The rules service looks up the tenant from the trade's account number. What is wrong?

- A) Account numbers are slow to look up in DB
- B) It re-derives the tenant from business data
- C) It needs an X-Tenant-Id JMS property name
- D) Rules must never run in a shared service

**Q8.** Why use expand → migrate → contract for tenant schema migrations?

- A) Liquibase needs it to lock all schemas
- B) PostgreSQL forbids drops during a deploy
- C) It lets each tenant pick its own schema
- D) Code runs against old and new schemas

---

## 5. Cheat sheet: Day 2

```
APPROACH        DB/tenant      schema/tenant           shared tables (+RLS)
isolation       strongest      good (search_path)      weakest; RLS helps a lot
cost            high           low-med                 lowest
migrations      N DBs          N schemas (fan-out)     1 (big table)
connections     pools x pods   1 pool/server           1 pool
restore 1       easy           pg_dump -n              hard
noisy nbr       isolated*      shared server           shared everything

SEARCH_PATH     first matching schema wins; pg_catalog first; pg_temp first for tables
                MISSING SCHEMA IS SKIPPED SILENTLY -> falls through to public
                set ONLY the tenant schema; keep public empty; no CREATE on public
                SET = session (survives pool return; reverted if its tx rolls back)
                SET LOCAL = transaction only; no effect in autocommit
                use set_config('search_path', ?, false) with a registry-validated value
                temp tables live per CONNECTION -> ON COMMIT DROP / avoid
                one tenant per transaction (borrow happens once per tx)

HIKARI          connectionInitSql = once per physical connection (NOT per borrow)
                resets JDBC-API state on return, NOT SQL-level SET
                switch on EVERY borrow (DelegatingDataSource.getConnection)
                connections = pods x pools_per_server x maxPoolSize <= server limit
                leakDetectionThreshold in test/staging

ROUTING         AbstractRoutingDataSource: which DB. No default target. lenientFallback=false
                wrapper: which schema. Combine: route -> pool -> switch

LIQUIBASE       separate job, not app startup; batches; record per-tenant result
                expand -> migrate -> contract (code works on old + new)

CACHES          every cache / map / lock / counter / dedup key includes tenant
                @Cacheable default key = method params only (no tenant!)
```

### Glossary additions (Day 2)

Database per tenant · Schema per tenant · Shared tables · Discriminator column · Row-level security (RLS) · `search_path` · Current schema · Borrow-time switch · Routing data source · Pool per database · Stale-context connection · Connection leak · Migration fan-out · Tenant-scoped key · Noisy neighbour. Definitions: [glossary.md](glossary.md#day-2-data-isolation).

---

## 6. Answers

### Warm-up answers (Day 1)

1. **Ingester:** from the *source queue* the message arrived on (registry lookup). **UI gateway:** from the *authenticated user* (OIDC identity → tenant).
2. The schema is dedicated, but the server's CPU, I/O, WAL, connection limit and catalogue are shared. It is a schema-level silo on a pooled server.
3. Gains: lower cost (shared idle capacity), faster onboarding, one release and version. Risks: bigger blast radius, cross-tenant leaks, noisy neighbour, less per-customer freedom, harder per-tenant operations. Any 3 + 2.
4. Listener threads are pooled. A context that isn't cleared becomes the tenant of the next message on that thread.
5. It works on component classes (`@Component`/`@Configuration`/`@AutoConfiguration`) and on `@Bean` methods. It is ignored on other methods, e.g. `@JmsListener` methods.

### Exercise 2.1: worked answers

**A: Leak.** The key `(table, version)` lacks the tenant. When `acme` and `hooli` both have `instruments` v42, whichever loads first fills the cache and the other reads its rows. `repo.load` itself runs with the *first* caller's `search_path`, so the cached value is that tenant's data.
Fix: `record RefKey(String tenantId, String table, long version)`, built with `TenantContext.require()`. Also make sure eviction can target one tenant. Size `maximumSize` for tenants × tables, or one tenant can evict everyone else's entries, which is a noisy neighbour in the cache.

**B: Leak.** `@Transactional` on `rollupAll` borrows **one** connection at the start of the transaction. If `TenantContext` isn't set at that point, the wrapper's `require()` throws, and everything fails, which is at least fail-closed. If a context *is* set by the caller (say `acme`), every tenant's summary is written to `t_acme.summary`, and `tradeRepo.countToday()` counts ACME's trades each time. There is also the `TenantContext.set()` guard: if the caller had `acme` set, `set("hooli")` throws with my implementation. Without that guard, this silently writes everything into one schema.
Fix: drop `@Transactional` from the loop. Put it on a per-tenant method in **another bean**, so the call goes through the Spring proxy (self-invocation bypasses `@Transactional`):

```java
public void rollupAll(List<String> tenantIds) {           // no transaction here
    for (String t : tenantIds) {
        TenantContext.set(t);
        try { perTenant.rollup(); }                       // @Transactional in a separate bean
        catch (Exception e) { failures.record(t, e); }    // one tenant failing doesn't stop others
        finally { TenantContext.clear(); }
    }
}
```

**C: Leak.** A `static` map keyed by `cptyCode`. Counterparty codes are per-tenant: `acme`'s `"JPM"` and `hooli`'s `"JPM"` may map to different LEIs, or one tenant may not have that counterparty at all. The first tenant to look up `"JPM"` decides the answer for everyone, for the JVM's lifetime.
Fix: key by `(tenantId, code)`; use a bounded cache, not an unbounded static map; make it an instance field. Statics are also hard to clear in tests.

**D: Leak (several).**
1. `connectionInitSql` runs once per physical connection, so per-borrow switching never happens.
2. The bean method runs at **startup**, where `TenantContext.current()` is empty, so the init SQL becomes `schemaFor("public")` → every connection gets the path `public` (or whatever `schemaFor` returns). That is a **default tenant**.
3. String concatenation into SQL.
Fix: a plain pool, wrapped in `TenantSchemaDataSource` that runs `set_config('search_path', ?, false)` on every `getConnection()` using `TenantContext.require()` and a registry-validated schema. No fallback.

### Exercise 2.2: worked answers

1. **`public.trades`.** Missing schemas are skipped silently. This is the onboarding leak.
2. **A temp table: hooli's `trades`.** `pg_temp` is searched before other schemas for relations, and the temp table survived on the pooled connection. Cross-tenant leak.
3. **`t_hooli.trades`.** `SET LOCAL` outside a transaction has no effect (warning only), so the old path stays.
4. **Error.** The relation `trades` does not exist. This is the fail-closed outcome you want.

### Exercise 2.3: worked answers (one defensible answer each)

1. **Globex → database per tenant, on its own server.** *Restore:* point-in-time recovery of one database server within 4 hours is standard; with schema-per-tenant you'd have to restore the whole shared server elsewhere and extract one schema. *Isolation/audit:* "physically separate storage" is satisfied. *Noisy neighbour:* 40% of volume would dominate a shared server. *Cost:* justified by contract. *Watch:* a separate pool in every service that touches its data (connection arithmetic). Its migrations run separately, so include it in the migration job report.
2. **Long tail → shared tables + RLS, or schema per tenant. Argue both, then pick.** *Cost* and *self-service onboarding* favour shared tables: onboarding is a registry row, with no DDL. *Migrations:* one migration instead of 280 schemas. *Isolation:* RLS with `FORCE`, a non-owner app role, and per-borrow `app.tenant_id`. *Restore:* per-tenant restore is hard. Fine at this price point, but state it in the contract. Choose **schema per tenant** if the team already has the schema switching working and the tenant count stays in the hundreds. Watch the catalogue size and migration fan-out time.
3. **Regional banks → schema per tenant on a shared server.** *Export / correction* per tenant: `pg_dump -n t_x`, and corrections stay inside one schema. *Cost:* one server, one pool. *Migrations:* 25 schemas, which is easy. *Noisy neighbour:* steady volumes, so the risk is acceptable. Watch per-tenant query load on the shared server.

### Quiz answers

| Q | Answer | Why |
|---|---|---|
| 1 | **B** | Non-existent schemas in `search_path` are skipped silently. |
| 2 | **A** | It runs once when the physical connection is created, not per borrow. |
| 3 | **D** | With a default target and lenient fallback, it routes to the default. That is a default tenant. |
| 4 | **A** | The default key is built from method parameters only. |
| 5 | **C** | AWS-Iso: isolation is enforced in silo, pool and bridge alike. |
| 6 | **C** | Table owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set. |
| 7 | **B** | Pass the tenant on; never re-derive it. Account numbers repeat across tenants. |
| 8 | **D** | Tenants migrate at different times, so the code must work with both schema versions. |
