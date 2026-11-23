# Day 1: SaaS Multi-Tenancy Foundations and Tenant Identity

**Time:** 2.5 h · **Glossary:** [glossary.md](glossary.md) · **Running example:** [README](README.md#the-running-example-a-generic-trade-processing-pipeline)

**Objectives.** By the end of today you can:

- explain why SaaS providers move from per-customer deployments to shared ones, and what risks they accept in return;
- define tenant, tenancy model and isolation, and classify a placement as silo, pool or bridge, per layer and per tenant;
- separate the control plane from the application plane;
- describe where tenant context is assigned, how it travels, how it is held, and why the system fails closed;
- tell run-time per-tenant config apart from startup-frozen config;
- use `@ConditionalOnProperty` correctly to switch old and new behaviour in a starter.

---

## 1. Retrieval warm-up (10 min)

There is no previous day yet, so today's warm-up checks the platform knowledge you bring. Answer from memory. The answers are at the end.

1. In JMS, what is the difference between a message *header* (like `JMSCorrelationID`) and a message *property*? Can a consumer select on a property?
2. In ActiveMQ Classic, which message property makes the broker send related messages to the same consumer in order?
3. A `ThreadLocal` is set in a thread that belongs to a pool and is never removed. What happens the next time that pool thread runs a different task?
4. In your current platform, how does a service "know" which customer it serves? Name two places that knowledge lives (for example a profile, a property, a DB URL).
5. What does `@Profile("acme")` on a `@Component` do when the active profiles are `default,prod`?

---

## 2. Core study (65–75 min)

### 2.1 Why move from one deployment per customer to a shared one (10 min)

You know the per-customer model well. Each customer has ~50 services, their own queues and their own databases. Here is what changes when you share.

```
 PER-CUSTOMER (today)                       SHARED (target)

 Customer A: [50 svcs][queues][DBs]         +-----------------------------+
 Customer B: [50 svcs][queues][DBs]         |  50 svcs  (one deployment)  |
 Customer C: [50 svcs][queues][DBs]   ==>   |  shard queues + some silos  |
 ...                                        |  shared DB(s), schema/tenant|
 Customer K: [50 svcs][queues][DBs]         +-----------------------------+
                                              A  B  C ... K  share it
 cost      ~ K x (whole stack)              cost      ~ 1 stack + per-tenant data
 onboard   = provision whole stack          onboard   = registry entry + schema + queue
 release   = K rollouts, K versions         release   = 1 rollout, 1 version
```

**What the provider gains** [AWS-Fund], [Azure-MT overview], [Golding]:

- **Cost.** Idle capacity is shared. Fifty services × K customers mostly sit idle. One shared set, sized for the combined peak, is much cheaper, because customers don't all peak at the same time.
- **Onboarding time.** A new customer becomes a registry entry, a schema and maybe a queue, created by automation. It is no longer a new environment.
- **Release effort.** One version in production. No "customer C is still on 4.2" support matrix. Fixes reach everyone at once.
- **Operational view.** One set of dashboards, with a tenant dimension.

**What the provider accepts in return:**

- **Bigger blast radius.** A bad release or a crash hits every tenant at once.
- **Cross-tenant leak risk.** A single missing `WHERE` clause, cache key or header can show customer A's trades to customer B. This is the risk this course is mostly about. [AWS-Iso]
- **Noisy neighbour.** One tenant's burst slows everyone sharing the resource. [Azure-MT *Noisy Neighbor antipattern*]
- **Less per-customer freedom.** Bespoke code paths per customer become config, or go away.
- **Harder per-tenant operations.** Restoring one tenant's data, or moving one tenant, needs deliberate design (Day 2, Day 4).

> **Meeting line:** "Sharing trades per-customer isolation *by construction* for isolation *by enforcement*. Our job is to make the enforcement impossible to forget."

### 2.2 Tenant, tenancy model, isolation; silo, pool, bridge (15 min)

**Tenant** = a customer organisation, not a user. One tenant has many users. AWS-Fund defines SaaS around this idea: a tenant is the unit you onboard, isolate, bill and observe.

**Tenancy model** = how one *layer* is shared. The AWS vocabulary [AWS-Fund], [AWS-Iso]:

| Model | Meaning | Example in our pipeline |
|---|---|---|
| **Silo** | Dedicated to one tenant | `globex` gets its own PostgreSQL database and its own `PARSE.globex` queue |
| **Pool** | Shared by many tenants | `acme` and 40 others share `PARSE.shard-0..3` and the parser pods |
| **Bridge** | A mix across layers | Pooled compute and queues, but a siloed schema per tenant |

Azure-MT (*Tenancy models*) uses other words for the same idea: *single-tenant*, *fully multitenant*, *vertically partitioned* (some tenants get dedicated stacks) and *horizontally partitioned* (some layers shared, others not). Learn both vocabularies. People in your meetings will mix them.

**Key point 1: the model is chosen per layer.** "Are we silo or pool?" is the wrong question. The right question is "silo or pool *for which layer*?"

**Key point 2: the model can differ per tenant (tiering).** One tenant can be pooled everywhere while a large tenant gets dedicated queues and its own database. That is tiering, and it is why our registry has a placement *per tenant*. [AWS-Fund]

```
              compute        queues               database
            +----------+  +-----------------+  +------------------+
 acme       |  POOL    |  | POOL (shard-2)  |  | SILO-ish: schema |   -> bridge
 hooli      |  POOL    |  | POOL (shard-1)  |  | SILO-ish: schema |   -> bridge
 globex     |  POOL    |  | SILO (dedicated)|  | SILO: own DB     |   -> bridge, top tier
 initech    |  SILO    |  | SILO            |  | SILO             |   -> legacy stack
            +----------+  +-----------------+  +------------------+
```

Is "schema per tenant in a shared database" silo or pool? It is debated. The schema is dedicated, but the database server, its CPU, its WAL and its connection limit are pooled. Say "schema-level silo on a pooled server" and you will be precise.

**Isolation is not the same as silo.** AWS-Iso says isolation must be enforced in *every* model, pool included. A siloed database still leaks if the code connects to the wrong one. A pooled table can be well isolated with RLS (Day 2). Isolation is a property you **enforce and test**. Deployment shape does not give it to you for free.

### 2.3 Control plane vs application plane (10 min)

[AWS-Fund] splits a SaaS system into two planes. [Azure-MT *Control planes*] uses the same split.

```
 +----------------------- CONTROL PLANE ------------------------+
 |  tenant registry   onboarding   offboarding   per-tenant cfg |
 |  (who exists,      (create       (stop, export, (limits,      |
 |   where placed)     schema/queue) delete)        features)    |
 |  billing/metering        admin UI          tenant metrics     |
 +-------------------------------+------------------------------+
                                 | reads registry/config
                                 v
 +--------------------- APPLICATION PLANE ----------------------+
 |  ingester -> parser -> enricher -> rules -> reporter         |
 |  (does the tenant's work; never creates/deletes tenants)     |
 +--------------------------------------------------------------+
```

- The **control plane** manages tenants. It is used by your operators, and in time by self-service sign-up. It is itself usually *not* multi-tenant in the same way. It is a global admin system.
- The **application plane** does the tenant's actual work. It *reads* the registry and config. It never decides who the tenants are.

In our system the registry is a file today. That is fine for a start. Watch for three things:

1. **Who changes it, and how does the change reach running services?** Reload on change, or restart? (Day 3 shows that reloading is itself a context-propagation hazard.)
2. **Is it validated?** A duplicate `sourceQueue` or a duplicate `id` is a leak waiting to happen. Validate at load time and refuse to start.
3. **Onboarding becomes a workflow.** Add the registry entry, create the schema and run migrations, create queues if dedicated, then enable traffic. Order matters (Day 4).

### 2.4 Tenant context: assign once, pass on, hold, clear, fail closed (20 min)

This is the core idea of the day. AWS-Fund calls the tenant context the thing every layer of a SaaS system needs. It is what lets code be shared while data and behaviour stay per tenant.

```
  TRUSTED EDGE                  PROPAGATION                    USE
  (assign once)                 (pass on, never re-derive)

  source queue IN.ACME  ---+
                           |    JMS property tenantId=acme
  INGESTER: registry  -----+--> PARSER --JMS--> ENRICHER --REST--> REFDATA
  lookup by queue name          |                 |   X-Tenant-Id: acme
                                |                 |
                    listener boundary:      HTTP filter boundary:
                    set(ctx) / clear(ctx)   set(ctx) / clear(ctx)
                                |
                                v
                     ThreadLocal TenantContext
                     -> DB borrow sets search_path
                     -> cache keys include tenant
                     -> outbound JMS/HTTP copy it
```

#### Rule 1: assign once, at the trusted edge

The ingester decides the tenant **only from the queue the message arrived on**. It never reads it from the message body or from a property the customer sent. Why? The queue is something *you* control: the registry maps `IN.ACME → acme`, and only ACME's systems have credentials to write to `IN.ACME`. A field inside the message is something *the customer* controls. A customer who writes `tenantId=globex` in their payload must not become Globex.

The same rule applies at the UI gateway (Day 4): the tenant comes from the *authenticated user*, never from a header the browser sent. Getting this wrong is the classic OWASP A01 Broken Access Control failure.

An ingester that binds the tenant to the *endpoint*, not to the message:

```java
@Configuration
@ConditionalOnProperty(prefix = "multitenancy", name = "enabled", havingValue = "true")
class IngestEndpoints implements JmsListenerConfigurer {

    private final TenantRegistry registry;
    private final IngestHandler handler;

    IngestEndpoints(TenantRegistry registry, IngestHandler handler) {
        this.registry = registry;
        this.handler = handler;
    }

    @Override
    public void configureJmsListeners(JmsListenerEndpointRegistrar registrar) {
        for (Tenant t : registry.tenantsWithSourceQueue()) {
            SimpleJmsListenerEndpoint ep = new SimpleJmsListenerEndpoint();
            ep.setId("ingest-" + t.id());
            ep.setDestination(t.sourceQueue());
            final String tenantId = t.id();          // bound from the registry, not the message
            ep.setMessageListener(msg -> handler.ingest(tenantId, msg));
            registrar.registerEndpoint(ep);
        }
    }
}
```

`handler.ingest` overwrites any `tenantId` property the customer may have put on the message, then forwards it.

#### Rule 2: pass it on, never re-derive it

After the edge, services **copy** the tenant. They don't compute it again from business data such as an account number or a counterparty. Re-deriving it creates a second source of truth. When the two disagree, one of them leaks.

- **Between services over JMS:** a string property `tenantId`. JMS property names must follow Java identifier rules (JMS spec, *Message Properties*). So `X-Tenant-Id` is **not** a legal JMS property name, while `tenantId` is.
- **Between services over REST:** the header `X-Tenant-Id`. Internal services may trust it **only** because the caller is another authenticated internal service (network policy, mTLS or a service token). The browser must never be able to reach those services directly. Day 4 deals with the edge.

Outbound JMS: every send copies the context.

```java
public void forward(String destination, Object payload) {
    String tenantId = TenantContext.require();       // throws if missing: fail closed
    jmsTemplate.convertAndSend(destination, payload, m -> {
        m.setStringProperty("tenantId", tenantId);
        return m;
    });
}
```

#### Rule 3: hold it in a `ThreadLocal`, set at the boundary, clear in `finally`

```java
public final class TenantContext {
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private TenantContext() {}

    public static void set(String tenantId) {
        if (tenantId == null || tenantId.isBlank()) throw new MissingTenantException();
        String existing = CURRENT.get();
        if (existing != null && !existing.equals(tenantId)) {
            // a previous task on this pooled thread did not clear: treat as a bug, not a fallback
            throw new IllegalStateException("Tenant context already set to " + existing);
        }
        CURRENT.set(tenantId);
    }

    public static String require() {
        String t = CURRENT.get();
        if (t == null) throw new MissingTenantException();
        return t;
    }

    public static Optional<String> current() { return Optional.ofNullable(CURRENT.get()); }

    public static void clear() { CURRENT.remove(); }   // remove(), not set(null)
}
```

Boundary in a downstream listener:

```java
@JmsListener(destination = "PARSE.shard-${parser.shard}", concurrency = "4-8")
public void onMessage(Message message) throws JMSException {
    String tenantId = message.getStringProperty("tenantId");
    registry.requireKnown(tenantId);                 // null/unknown -> UnknownTenantException
    TenantContext.set(tenantId);
    try {
        parser.handle(message);
    } finally {
        TenantContext.clear();                        // always: listener threads are pooled
    }
}
```

Why `finally` matters: listener-container threads and servlet threads are **reused**. A context that is not cleared becomes the "tenant" of the *next* message that thread handles. If that message's own tenant is somehow not set (a bug), it silently runs as the previous tenant. The guard in `set()` above turns that silent leak into a loud failure.

#### Rule 4: fail closed, no default tenant

If the tenant is null or not in the registry, **throw**. In a transacted JMS listener, the exception rolls back the session. The broker then redelivers the message a few times, and after that it goes to the DLQ (details on Day 3 [AMQ-RD]).

- ⚠ UNVERIFIED for your version: Spring Boot's `DefaultJmsListenerContainerFactoryConfigurer` makes listener sessions transacted when there is no JTA transaction manager. Check `sessionTransacted` in your configuration. If it is `false` with auto-acknowledge, a thrown exception may *not* cause redelivery the way you expect.

Why no default tenant? Because a default turns "we forgot to propagate" from an error you can see into data written to, or read from, someone else's account. A missing tenant is always a bug upstream. Make it hurt where it happens.

```
  tenantId present & known  --> process
  tenantId missing          --> throw --> rollback --> redeliver x N --> DLQ  (alert)
  tenantId unknown          --> throw --> rollback --> redeliver x N --> DLQ  (alert)
  "use 'default' instead"   --> FORBIDDEN
```

### 2.5 Per-tenant configuration at run time vs settings frozen at startup (10 min)

On your current platform, per-customer behaviour comes from **Spring profiles and properties read at startup**. That works because one JVM = one customer. In a shared JVM it is wrong: a singleton holds exactly one value, and that value belongs to whichever customer's config was loaded.

```
 BEFORE (1 JVM = 1 customer)            AFTER (1 JVM = many tenants)

 @Value("${customer.currency}")         TenantSettings s = settings.forCurrent();
 String baseCurrency;   // "EUR"        s.baseCurrency();   // looked up per tenant

 @Profile("acme") @Bean AcmeRule        rules.enabledFor(TenantContext.require())
```

Places where per-customer settings get frozen. You will hunt for these in the exercises:

| Frozen pattern | Why it's wrong when shared |
|---|---|
| `@Value("${customer.x}")` on a singleton field | Read once and holds one value |
| `@ConfigurationProperties("customer")` bean | Also a singleton, bound once at startup |
| `@PostConstruct` that loads "the customer's" calendar, mappings, etc. | Runs once, with no tenant in context |
| `@Profile("customerA")` / `@ConditionalOnProperty("customer.feature")` beans | The bean set is fixed at startup for all tenants |
| `static` fields or static initialisers built from config | Shared by every tenant for the JVM's lifetime |

**Platform-wide settings stay startup settings.** Batch size, pool size and broker URL don't vary per tenant. The question to ask of every setting: *"Could two tenants want different values?"*

A run-time pattern:

```java
public record TenantSettings(String baseCurrency, ZoneId zone, Set<String> enabledRules) {}

@Service
public class TenantSettingsService {
    private final Map<String, TenantSettings> byTenant;   // loaded from registry/config store

    public TenantSettings forCurrent() {
        String t = TenantContext.require();
        TenantSettings s = byTenant.get(t);
        if (s == null) throw new UnknownTenantException(t);  // fail closed, no defaults
        return s;
    }
}
```

AWS-Fund and Golding both treat per-tenant configuration as a control-plane concern, read by the application plane at run time. Azure-MT discusses the same idea under tenant configuration and the control plane.

### 2.6 Switching features on and off with a Spring Boot starter (10 min)

You will ship multi-tenancy as a **starter**: a jar with auto-configuration that each of the ~50 services adds. Default behaviour must stay exactly the old single-customer behaviour (the opt-in flag).

**How auto-configuration is found** [Boot-AC]: Spring Boot 2.7+ and 3.x read the class names listed in `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`. Those classes are annotated `@AutoConfiguration`.

```
my-mt-starter.jar
 └─ META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
       com.example.mt.MultiTenancyAutoConfiguration
```

```java
@AutoConfiguration
@ConditionalOnProperty(prefix = "multitenancy", name = "enabled", havingValue = "true")
@EnableConfigurationProperties(MultiTenancyProperties.class)
public class MultiTenancyAutoConfiguration {
    @Bean TenantRegistry tenantRegistry(MultiTenancyProperties p) { return TenantRegistry.load(p.getRegistryFile()); }
    @Bean TenantFilter tenantFilter(TenantRegistry r) { return new TenantFilter(r); }
    // ... DataSource wrapper (Day 2), task decorator (Day 3)
}
```

The old listener in the service is switched **off** when multi-tenancy is on:

```java
@Component
@ConditionalOnProperty(prefix = "multitenancy", name = "enabled",
                       havingValue = "false", matchIfMissing = true)
class LegacyParseListener {
    @JmsListener(destination = "PARSE")
    void on(Message m) { /* old single-customer path */ }
}
```

```yaml
# application.yml (default: nothing set -> legacy path)
multitenancy:
  enabled: true          # opt in per environment
  registry-file: /etc/pipeline/tenants.yml
```

**`@ConditionalOnProperty` semantics** [Boot-AC, `@ConditionalOnProperty` javadoc]:

- `havingValue` set: matches when the property equals that value. Spring Boot's `OnPropertyCondition` compares case-insensitively.
- `havingValue` not set: matches when the property is present and **not equal to `false`**.
- `matchIfMissing` (default `false`): what to do when the property is absent. On the legacy class, `matchIfMissing = true` means "absent = legacy on". That is the opt-in behaviour.

**The trap: a condition on a `@JmsListener` method is ignored.** `@Conditional` annotations are evaluated by the bean-definition machinery. They are only meaningful on **component classes** and **`@Bean` methods** (see the `@Conditional` javadoc). A `@JmsListener` method is neither. It is found later by `JmsListenerAnnotationBeanPostProcessor`, which scans the methods of a bean that already exists and registers every `@JmsListener` it finds. It does not evaluate conditions. So this does **not** switch anything off:

```java
@Component
class Listeners {
    @JmsListener(destination = "PARSE")
    @ConditionalOnProperty(name = "multitenancy.enabled", havingValue = "false", matchIfMissing = true) // IGNORED
    void legacy(Message m) { ... }

    @JmsListener(destination = "PARSE.shard-0")
    @ConditionalOnProperty(name = "multitenancy.enabled", havingValue = "true")                         // IGNORED
    void sharded(Message m) { ... }
}
// Result: BOTH listeners run, always. Legacy queue AND shard queue are consumed.
```

The fix: split them into two classes and put the condition on each **class**. Or create the listener-holding beans through `@Bean` methods that carry the condition.

### 2.7 Videos for today (optional, if time remains)

Paste these into YouTube. Prefer results from the **AWS Events** channel (re:Invent), **GOTO Conferences**, **InfoQ** or **Spring I/O**.

| Search query | Watch for | Key takeaway to note down |
|---|---|---|
| `Tod Golding re:Invent SaaS architecture` | How he defines control plane vs application plane, and silo/pool/bridge per layer | Tiering, and how a tenant context flows end to end |
| `re:Invent SaaS tenant isolation strategies` | Whether isolation is shown as enforced *in the pool model*, not only by siloing | Isolation is a property you enforce, not a deployment shape |
| `Spring Boot custom starter auto-configuration` (prefer Spring I/O or SpringDeveloper) | The `AutoConfiguration.imports` file and conditional annotations | Conditions belong on classes and `@Bean` methods |
| `multitenancy Spring Boot` (Spring I/O / Devoxx) | How the tenant is resolved and stored per request | Compare their resolver with our "trusted edge" rule. Many demos read a tenant header from the client. Note that this is unsafe at a public edge (Day 4). |

---

## 3. Hands-on exercises (45 min)

Write your answers before you open the worked answers at the end.

### Exercise 1.1: Classify the placements (12 min)

For each scenario, say **silo / pool** for each layer (compute, queues, database), and then whether the tenant's overall placement is **silo, pool or bridge**. Then name one risk the placement accepts.

1. `acme`: shared parser pods, `PARSE.shard-2`, own schema `t_acme` in shared DB `pg-shared-1`.
2. `globex`: shared parser pods, dedicated `PARSE.globex`, own database on its own server.
3. `initech`: still on its old per-customer stack: own pods, own queues, own DB.
4. `hooli`: shared parser pods, `PARSE.shard-1`, rows in shared tables with a `tenant_id` column.
5. `stark`: dedicated parser pods (a separate deployment of the same image, consuming only `PARSE.stark`), dedicated queue, own schema in `pg-shared-1`.
6. All 300 small tenants after a migration: shared pods, 8 shard queues, one shared database with schema per tenant.

### Exercise 1.2: Where is identity lost? (15 min)

Read this sketch of a 5-service flow. Mark **every** point where the tenant identity is lost or wrongly derived. For each one, say what the failure would look like at run time.

```
[1] INGESTER
    @JmsListener(destination = "IN.ALL")                // one shared inbound queue for all customers
    void in(Message m) {
        String t = m.getStringProperty("tenantId");      // sent by the customer's system
        TenantContext.set(t);
        try { jms.convertAndSend("PARSE.shard-" + shard(t), body(m)); }
        finally { TenantContext.clear(); }
    }

[2] PARSER
    void onMessage(Message m) {
        TenantContext.set(m.getStringProperty("tenantId"));
        try {
            Trade tr = parse(m);
            jms.convertAndSend("ENRICH", tr, msg -> { msg.setStringProperty("tenantId", TenantContext.require()); return msg; });
        } finally { TenantContext.clear(); }
    }

[3] ENRICHER
    void onMessage(Message m) {
        TenantContext.set(m.getStringProperty("tenantId"));
        try {
            RestTemplate rt = new RestTemplate();        // interceptor that adds X-Tenant-Id is on the builder bean
            Ref r = rt.getForObject(refUrl + "/instruments/" + isin, Ref.class);
            jms.convertAndSend("RULES", enrich(m, r), copyTenant());
        } finally { TenantContext.clear(); }
    }

[4] RULES
    void onMessage(Message m) {
        String t = accounts.ownerTenantOf(trade(m).accountNo());   // looks up tenant from the account number
        TenantContext.set(t);
        try { jms.convertAndSend("REPORT", evaluate(m), copyTenant()); }
        finally { TenantContext.clear(); }
    }

[5] REPORTER
    void onMessage(Message m) {
        String t = Optional.ofNullable(m.getStringProperty("tenantId")).orElse("default");
        TenantContext.set(t);
        try { reports.append(m); } finally { TenantContext.clear(); }
    }
```

### Exercise 1.3: Frozen per-customer settings (10 min)

This service was written for the per-customer world. Find the **three** places where per-customer settings are frozen at startup. One setting in the class is fine as it is. Find it too, and say why it's fine. Propose the run-time replacement for each frozen one.

```java
@Service
public class SettlementDateCalculator {

    @Value("${pipeline.batch-size:500}")
    private int batchSize;

    @Value("${customer.settlement-lag-days}")
    private int lagDays;

    private final HolidayCalendar calendar;
    private static final ZoneId ZONE = ZoneId.of(System.getProperty("customer.zone", "Europe/London"));

    public SettlementDateCalculator(HolidayCalendarLoader loader) {
        this.calendar = loader.load();            // loads holidays.csv for "the customer"
    }

    public LocalDate settle(Instant tradeTime) {
        LocalDate d = tradeTime.atZone(ZONE).toLocalDate();
        return calendar.addBusinessDays(d, lagDays);
    }
}
```

### Exercise 1.4: Which listeners are running? (8 min)

A service has three classes:

```java
@Component @ConditionalOnProperty(prefix="multitenancy", name="enabled", havingValue="false", matchIfMissing=true)
class LegacyListener { @JmsListener(destination="PARSE") void on(Message m){} }

@Component @ConditionalOnProperty(prefix="multitenancy", name="enabled", havingValue="true")
class ShardListener  { @JmsListener(destination="PARSE.shard-0") void on(Message m){} }

@Component
class AuditListener {
    @JmsListener(destination="AUDIT")
    @ConditionalOnProperty(prefix="multitenancy", name="enabled", havingValue="true")
    void on(Message m){}
}
```

Fill in which listeners run for each value of `multitenancy.enabled`: (a) property absent, (b) `false`, (c) `true`, (d) `TRUE`, (e) `yes`. Then say which case is an outage, and how you would make that mistake impossible.

---

## 4. Closing quiz (15 min)

Choose one answer. Answers are at the end.

**Q1.** Our tenant `acme` uses shared pods, a shared shard queue and its own schema. Which term fits best?

- A) Pool, because all the pods are shared
- B) Silo, because its schema is its own
- C) Bridge, mixing silo and pool layers
- D) Single-tenant, as its data is separate

**Q2.** Where does the ingester get the tenant ID for a new inbound message?

- A) From the tenantId property it carries
- B) From the queue the message arrived on
- C) From a field inside the message payload
- D) From the account number in the payload

**Q3.** The parser receives a message with no `tenantId` property. What should happen?

- A) Process it under a default tenant ID
- B) Process it and log a warning message
- C) Ack it and drop it without any error
- D) Throw, so it retries and then hits DLQ

**Q4.** What does `@ConditionalOnProperty` do on a `@JmsListener` method of a `@Component`?

- A) Nothing; the listener still registers
- B) It disables just that listener method
- C) It disables the whole component class
- D) It fails startup with a config exception

**Q5.** A legacy listener class has `havingValue="false", matchIfMissing=true`. The property is absent. What happens?

- A) The class is skipped and no bean is made
- B) The bean is created but stays stopped
- C) Startup fails due to the missing value
- D) The class is registered as a normal bean

**Q6.** Why must a per-customer `@Value` field become a run-time lookup in a shared service?

- A) @Value fields cannot be read at run time
- B) A singleton field holds one tenant's value
- C) Profiles cannot be activated in prod now
- D) Values must come from env vars in a SaaS

**Q7.** Which of these belongs to the control plane?

- A) The parser that splits incoming trades
- B) The enricher calling reference data
- C) The onboarding flow creating a schema
- D) The reporter writing daily summaries

**Q8.** Why is `X-Tenant-Id` a bad name for the tenant **JMS** property?

- A) JMS property names must be Java identifiers
- B) JMS properties are limited to numeric values
- C) The X- prefix is reserved for JMS headers
- D) ActiveMQ strips all properties with dashes

---

## 5. Cheat sheet: Day 1

```
WHY SHARE        cost, onboarding minutes not weeks, one release
PRICE            blast radius, leak risk, noisy neighbour, less bespoke freedom

MODEL PER LAYER  silo = dedicated | pool = shared | bridge = mix across layers
PER TENANT       tiering: big tenant -> dedicated queue / own DB
ISOLATION        enforced + tested in EVERY model; silo != isolated by magic

PLANES           control  = registry, onboarding, offboarding, per-tenant config
                 app      = ingester, parser, enricher, rules, reporter

TENANT CONTEXT   ASSIGN once at trusted edge (source queue / authenticated user)
                 PASS ON: JMS property tenantId | HTTP X-Tenant-Id (internal only)
                 HOLD: ThreadLocal, set at boundary, clear() in finally
                 FAIL CLOSED: missing/unknown -> throw -> retry -> DLQ
                 NO DEFAULT TENANT. Never re-derive from business data.

CONFIG           "Could two tenants want different values?" yes -> run-time lookup
                 frozen: @Value field, @ConfigurationProperties, @PostConstruct load,
                         @Profile per customer, static init

STARTER          AutoConfiguration.imports + @AutoConfiguration
                 @ConditionalOnProperty(havingValue=..., matchIfMissing=...)
                 legacy class: havingValue=false, matchIfMissing=true
                 new class:    havingValue=true
                 conditions work on CLASSES and @Bean METHODS only,
                 NOT on @JmsListener methods
```

### Glossary additions (Day 1)

Tenant · Tenant ID · Per-customer deployment · Multi-tenant SaaS · Tenancy model · Silo · Pool · Bridge · Tiering · Isolation · Blast radius · Control plane · Application plane · Tenant registry · Placement · Onboarding · Offboarding · Tenant context · Trusted edge · Propagation · Boundary · Fail closed · Default tenant · Startup-frozen config · Run-time tenant config · Opt-in flag · Starter. Definitions: [glossary.md](glossary.md#day-1-foundations-and-tenant-identity).

---

## 6. Answers

### Warm-up answers

1. **Headers** are fixed JMS fields set by the provider or API (`JMSMessageID`, `JMSCorrelationID`, `JMSPriority`…). **Properties** are application-defined name/value pairs. A consumer *can* use a message selector on properties and on some headers, e.g. `tenantId = 'acme'`. (Using selectors to split tenants on one queue is possible but usually a bad idea at scale. See Day 3.)
2. `JMSXGroupID` [AMQ-MG].
3. The next task on that thread sees the old value. In this course, that means it runs as the previous tenant: a cross-tenant leak. Always `remove()` in `finally`.
4. Typical answers: the active Spring profile (e.g. `acme`), customer-specific `application-acme.yml`, the JDBC URL pointing at that customer's DB, queue names in config, environment variables in the deployment. In SaaS, all of those become per-tenant run-time lookups or registry placement.
5. Nothing is registered. The bean is created only when `acme` is an active profile.

### Exercise 1.1: worked answer

| # | Compute | Queues | Database | Overall | One accepted risk |
|---|---|---|---|---|---|
| 1 `acme` | pool | pool (shard-2) | silo at schema level, on a pooled server | **bridge** | Noisy neighbours on shard-2 and on `pg-shared-1`. A `search_path` bug can leak. |
| 2 `globex` | pool | silo | silo (own DB and server) | **bridge** (a top-tier one) | Still shares parser pods: a poison message or memory leak in a pod still hurts others. More pools to size (Day 2). |
| 3 `initech` | silo | silo | silo | **silo** (full-stack silo, legacy) | Cost and release drift: it is on its own version. The registry must route nothing of its traffic to the shared stack. |
| 4 `hooli` | pool | pool | pool (shared tables) | **pool** (full-stack pool) | A single missing `tenant_id` filter leaks. Per-tenant restore is hard. Mitigate with RLS (Day 2). |
| 5 `stark` | silo (dedicated pods) | silo | schema on pooled server | **bridge** | DB server still shared. Separate deployment means a separate rollout to watch. |
| 6 300 small | pool | pool (8 shards) | schema per tenant on one server | **bridge** | 300 schemas in one DB: migration fan-out time, catalogue size, one server is the blast radius (Day 2). |

What to take from this: you described each tenant with **three answers, one per layer**, not one. That is the habit to bring to meetings.

### Exercise 1.2: worked answer

| Step | Problem | What you'd see at run time |
|---|---|---|
| [1] | **Wrong trusted edge.** A single `IN.ALL` queue means the queue no longer identifies the customer. The ingester trusts a `tenantId` property **sent by the customer**. Any customer can write `tenantId=globex` and inject trades into Globex. There is also no `requireKnown` check: null goes into `shard(null)` → NPE or a wrong shard. | A customer's trades show up in another tenant's reports. This is a security incident, not a bug. Fix: per-customer source queues; tenant from the registry lookup by queue; overwrite any incoming property. |
| [1] | The forwarded message **does not carry** the tenant. `convertAndSend(dest, body)` has no post-processor, so the parser receives no `tenantId`. | Every message reaches the parser with no tenant. If the parser fails closed, everything goes to the DLQ. If it has a default, everything lands in one tenant. |
| [2] | Looks right (set, copy on send, clear in `finally`). But `set(null)` must throw. With my `TenantContext.set` it does. With a naïve `CURRENT.set(null)`, `require()` throws later instead, which is still fail-closed but less clear. Also no `requireKnown`. | — |
| [3] | `new RestTemplate()` **bypasses** the interceptors configured on the `RestTemplateBuilder` bean, so `X-Tenant-Id` is not sent. (More on Day 3.) | Reference-data service rejects with 400 (if it fails closed). Or it returns *some* tenant's instruments (if it has a default or a cache not keyed by tenant). |
| [4] | **Re-derives** the tenant from business data (account number) instead of passing it on. Account numbers are not globally unique across tenants: two tenants can both have account `10001`. | Rules applied with the wrong tenant's configuration. Report goes to the wrong tenant. It is intermittent and data-dependent, so very hard to spot in testing. |
| [5] | **Default tenant.** A missing property becomes `"default"`. | Messages with lost context pile up silently in a "default" tenant's reports, or the whole flow "works" in tests that only have one tenant. Fix: fail closed. |

What to take from this: identity is lost in three ways. It is **not copied** ([1] send, [3] REST). It is **taken from an untrusted source** ([1]). Or it is **recomputed / defaulted** ([4], [5]).

### Exercise 1.3: worked answer

- **Fine:** `pipeline.batch-size` is a platform setting. Two tenants won't need different batch sizes for this code. (If they ever do, that's a quota or tier feature, see Day 4.)
- **Frozen 1:** `@Value("${customer.settlement-lag-days}") lagDays` holds one customer's lag. Replace with `settings.forCurrent().settlementLagDays()`.
- **Frozen 2:** `calendar = loader.load()` in the constructor loads "the customer's" holiday calendar once, with no tenant in context. In a shared service the constructor runs with **no tenant at all**. Replace with a `HolidayCalendarProvider` that returns `calendarFor(TenantContext.require())`, backed by a cache keyed by tenant (Day 2: tenant-scoped keys).
- **Frozen 3:** `static final ZoneId ZONE` from a system property. It is JVM-wide and permanent. Replace with `settings.forCurrent().zone()`.

```java
public LocalDate settle(Instant tradeTime) {
    TenantSettings s = settings.forCurrent();
    LocalDate d = tradeTime.atZone(s.zone()).toLocalDate();
    return calendars.forCurrentTenant().addBusinessDays(d, s.settlementLagDays());
}
```

### Exercise 1.4: worked answer

| `multitenancy.enabled` | LegacyListener (`PARSE`) | ShardListener (`PARSE.shard-0`) | AuditListener (`AUDIT`) |
|---|---|---|---|
| (a) absent | **on** (`matchIfMissing=true`) | off | **on** (method condition ignored) |
| (b) `false` | **on** | off | **on** |
| (c) `true` | off | **on** | **on** |
| (d) `TRUE` | off | **on** (case-insensitive match) | **on** |
| (e) `yes` | **off** (`yes` ≠ `false`) | **off** (`yes` ≠ `true`) | **on** |

- **Outage:** (e). Neither pipeline listener runs, so nothing is consumed and queues grow. The same happens with a typo such as `ture`.
- **AuditListener** always runs because a method-level condition is ignored.
- **Make it impossible:** bind the flag to a typed `boolean` in `@ConfigurationProperties` with validation, so `yes` fails startup with a clear binding error. Then derive both conditions from that one property. Also add a startup check that fails if neither or both listener sets are active. Move the audit condition to a class (or a `@Bean` method).

### Quiz answers

| Q | Answer | Why |
|---|---|---|
| 1 | **C** | Pooled compute and queues with a siloed schema = a mix across layers = bridge. |
| 2 | **B** | The source queue is controlled by us. Message content is controlled by the customer. |
| 3 | **D** | Fail closed: throw → rollback → redelivery → DLQ. No default tenant. |
| 4 | **A** | `@Conditional` is only meaningful on component classes and `@Bean` methods. |
| 5 | **D** | `matchIfMissing=true`: absent counts as a match, so the legacy bean is created. |
| 6 | **B** | One singleton field holds one value, which is wrong for every other tenant. |
| 7 | **C** | Onboarding manages tenants. The others do tenant work (application plane). |
| 8 | **A** | JMS property names follow Java identifier rules. A dash is not allowed. |
