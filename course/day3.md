# Day 3: Messaging, Async Work and Context Propagation

**Time:** 2.5 h · **Glossary:** [glossary.md](glossary.md) · **Running example:** [README](README.md#the-running-example-a-generic-trade-processing-pipeline)

**Objectives.** By the end of today you can:

- separate tenant traffic with ActiveMQ Classic destinations (virtual topics, consumer queues, shard and dedicated suffixes), and keep per-key order with message groups inside a shared queue;
- compute shard placement correctly, explain why N is a one-way door, and compare `mod N` with consistent hashing;
- handle broadcast messages that belong to no single tenant;
- use redelivery and the DLQ as the fail-closed path, and triage the DLQ per tenant;
- find and fix every thread hop where the `ThreadLocal` tenant is lost (`@Async`, executors, schedulers, cache reloads, `CompletableFuture`, Reactor);
- make every outbound REST client carry `X-Tenant-Id`.

---

## 1. Retrieval warm-up (10 min): Days 1–2

1. `search_path = t_x, public`, and `t_x` doesn't exist. What happens to `SELECT * FROM trades`, and which two rules stop it?
2. Why is setting `search_path` in `connectionInitSql` not enough?
3. A `@Transactional` method loops over three tenants and sets `TenantContext` for each. Where do the writes go, and why?
4. What must every cache, lock and in-memory map key include? Name a Spring default that breaks this.
5. *(Day 1)* What is the difference between the control plane and the application plane? Give one example of each from our pipeline.

---

## 2. Core study (70–75 min)

### 2.1 Destinations that separate tenant traffic (12 min)

#### Virtual topics, quick refresher [AMQ-VD]

A producer sends to a topic named `VirtualTopic.<name>`. For every consumer queue named `Consumer.<consumerName>.VirtualTopic.<name>`, the broker puts a copy of each message on that queue. Each logical subscriber (a service) gets queue semantics: load balancing across its instances, persistence, and redelivery. The `VirtualTopic.` and `Consumer.*.` prefixes are the defaults, and you can change them in the broker's `virtualDestinationInterceptor` configuration [AMQ-VD].

#### Adding the tenant or shard to the name

```
 SHARED (pool tier)                                  DEDICATED (silo tier)

 VirtualTopic.TRADE_PARSED.shard-0 ... shard-3        VirtualTopic.TRADE_PARSED.globex
        |            |                                       |            |
        v            v                                       v            v
 Consumer.enricher.  Consumer.reporter.               Consumer.enricher.  Consumer.reporter.
 VirtualTopic.       VirtualTopic.                    VirtualTopic.       VirtualTopic.
 TRADE_PARSED.shard-2  TRADE_PARSED.shard-2           TRADE_PARSED.globex TRADE_PARSED.globex
```

One function chooses the destination, and **every** producer uses it:

```java
public String destination(String stage, String tenantId) {
    Tenant t = registry.require(tenantId);
    return switch (t.queueTier()) {
        case DEDICATED -> stage + "." + t.id();                    // e.g. PARSE.globex
        case SHARED    -> stage + ".shard-" + shardOf(t.id());     // e.g. PARSE.shard-2
        case LEGACY    -> throw new IllegalStateException(t.id() + " is on the legacy stack");
    };
}
```

**Why not one queue plus message selectors (`tenantId = 'acme'`)?** It works for small numbers. But each selector consumer makes the broker scan the queue for matching messages, and messages that no current consumer matches can pile up and block a consumer's prefetch. In practice it doesn't scale to hundreds of tenants. ⚠ UNVERIFIED as a precise performance claim. The ActiveMQ docs on selectors and virtual topics (`selectorAware`) discuss the trade-offs. Destinations per shard or per tenant are simpler to reason about and to monitor.

**Destination names are also a security boundary.** On the *inbound* side, only customer A's credentials may write to `IN.A`. ActiveMQ Classic's authorization plugin can restrict write access per destination. That control is what makes "tenant = source queue" trustworthy at the ingester (Day 1).

#### Message groups inside a shared queue [AMQ-MG]

You already use `JMSXGroupID` for per-key order. The broker sends all messages with the same group ID to **one consumer at a time**. If that consumer goes away, the group moves to another. Set `JMSXGroupSeq = -1` to close a group explicitly [AMQ-MG].

In a shared shard queue, two tenants can share business keys, such as account `10001`. So **the group ID must include the tenant**:

```java
m.setStringProperty("JMSXGroupID", tenantId + ":" + trade.accountNo());   // not just accountNo
```

| Group ID | Effect |
|---|---|
| `accountNo` | acme's and hooli's account `10001` are serialised together: needless coupling, and one tenant's slow message delays the other. No *data* leak, but a performance leak. |
| `tenantId` | Whole tenant on one consumer: strict per-tenant order, but **no parallelism for a big tenant**. |
| `tenantId:accountNo` | Order per account per tenant, parallel across accounts. Usually right. |

Message group ownership is held in the broker. The broker keeps a map from group to consumer, and by default it is a bounded cache. ⚠ UNVERIFIED: the default map type and size for your ActiveMQ version (look for `messageGroupMapFactory` in the Message Groups docs). Ordering is **per queue only**. If the same tenant's messages are ever split across two queues (see N changes below), groups can't keep them in order.

### 2.2 Sharding: `hash(tenantId) mod N` (12 min)

```
 tenantId --String.hashCode()--> int --Math.floorMod(h, N)--> shard 0..N-1
 "acme"        2988346                floorMod(2988346, 4) = 2   -> PARSE.shard-2
```

**Get the arithmetic right:**

- `String.hashCode()` is **specified** in the `String` javadoc (`s[0]*31^(n-1) + … + s[n-1]`), so it's the same on every JVM and every release. Never use `Object.hashCode()`, an identity hash, or anything seeded per process.
- `hashCode()` can be **negative**. In Java, `h % N` keeps the sign, so it can return a negative number. Use `Math.floorMod(h, N)`.
- `Math.abs(h) % N` is *also* wrong. `Math.abs(Integer.MIN_VALUE)` is still `Integer.MIN_VALUE`, which is negative (`Math.abs` javadoc). And for other negative `h`, `abs(h) % N` gives a *different* shard from `floorMod(h, N)`. If the producer uses one formula and the consumer configuration uses the other, they disagree.
- Put the function in **one** library method, used by every producer and by the tooling.

#### N is a one-way door

With `h mod N`, changing N to N+1 keeps a key on the same shard only when `h mod N == h mod (N+1)`. For uniformly spread hashes, that is about **1/(N+1)** of keys, so about **N/(N+1)** move. Going from 4 to 5 moves ~80% of tenants.

```
 time ──────────────────────────────────────────────────────────►
 N=4: acme -> shard-2      | deploy N=5 | acme -> shard-1
 shard-2 still holds 10k acme msgs ──┐   new acme msgs land on shard-1
                                     │
 consumers on shard-2 and shard-1 now process acme AT THE SAME TIME
 -> per-account order broken: amendment (shard-1) applied before new trade (shard-2)
```

Moving tenants between queues breaks ordering for messages in flight, because message groups only order within one queue. Safe procedures have to **drain** first: stop ingesting the tenants that move, let their old shard empty, switch, then resume. That is a coordinated, per-tenant operation. That's what "one-way door" means here: easy to choose, expensive to change.

**Alternatives:**

- **Consistent hashing** (Karger et al., 1997): tenants and shards are placed on a ring, and adding a shard moves only about 1/(N+1) of keys. **Jump consistent hash** (Lamping & Veach, 2014) gives the same property with a tiny function and no ring. Both still move *some* tenants, so draining is still needed for those.
- **Persisted assignment:** compute the shard once at onboarding, **store it in the registry**, and never recompute it. Changing N then affects only new tenants. Moving a tenant becomes an explicit, drained operation. For a registry-driven system like ours, this is often the most practical answer. Discuss it in the meeting.

#### Hot shards

`mod N` balances tenant **count**, not **load**. If two big tenants hash to the same shard, that shard lags while the others sit idle. Remedies, from cheapest:

1. Move the big tenant to the **dedicated** tier (an explicit registry override, drained).
2. Give that shard queue more consumers. This only helps if per-key groups allow parallelism.
3. Increase N (one-way door, see above).

### 2.3 Dedicated queues and broadcast messages (6 min)

**Dedicated tier:** the registry says `queues.tier: DEDICATED`. The destination function returns `PARSE.globex`, and the service starts a listener for it. Listeners are registered from the registry (as with the ingester in Day 1), not hard-coded, so a tenant can be promoted without a code change.

**Broadcast messages** have no single tenant. Examples: "market holiday calendar updated", "new ruleset released", "FX rates for the day". They break the "every message has a tenant" rule, so handle them deliberately:

```
                      option A: consumer fans out          option B: producer fans out
 VirtualTopic.        +-----------------------------+      producer loops tenants and sends
 RATES_PUBLISHED  --> | for t in registry.active(): |      one message PER TENANT with
 (no tenantId)        |   TenantContext.set(t)      |      tenantId set -> normal path
                      |   try { apply(t) }          |
                      |   catch { record(t, e) }    |
                      |   finally { clear() }       |
                      +-----------------------------+
```

- Mark broadcast message types **explicitly** (e.g. a property `scope=GLOBAL` on an allow-listed destination). Then "no tenant" on a normal message still fails closed. "No tenant" must never mean "broadcast".
- One tenant per transaction (Day 2, Trap 4). One tenant failing must not stop the others. Record per-tenant results and retry those tenants.
- Option B gives you normal per-tenant redelivery and DLQ for free, at the cost of N messages.

### 2.4 Redelivery, poison messages and the DLQ (10 min)

In our design, the DLQ *is* the fail-closed path for "no or unknown tenant". It also catches genuinely broken messages.

```
 listener throws (unknown tenant / parse error)
   -> session rollback
   -> client RedeliveryPolicy: redeliver after delay, up to maximumRedeliveries
   -> exceeded: client sends "poison ack" -> broker moves message to DLQ
   -> DLQ message keeps its properties (incl. tenantId if it had one)
```

From [AMQ-RD]. ⚠ UNVERIFIED values: check the docs for your version before quoting them.

- `RedeliveryPolicy` on the `ActiveMQConnectionFactory`: `maximumRedeliveries` (default **6**), `initialRedeliveryDelay` (default **1000 ms**), `useExponentialBackOff`, `backOffMultiplier`, `maximumRedeliveryDelay`. A policy can be set **per destination** with a `RedeliveryPolicyMap`.
- The default dead-letter strategy is a **shared** queue named `ActiveMQ.DLQ` for all destinations. `individualDeadLetterStrategy` with `queuePrefix="DLQ."` gives one DLQ per destination, e.g. `DLQ.PARSE.shard-2`.
- Non-persistent messages are not sent to the DLQ by default (`processNonPersistent=false`). Expired messages are (`processExpired=true`).
- The broker adds a `dlqDeliveryFailureCause` string property with the exception that caused the move.

**Should "unknown tenant" be retried at all?** Usually yes, a *few* times. The common cause is a race: a message for a just-onboarded tenant reaches a service whose registry hasn't reloaded yet. Retries with back-off cover that. A permanently unknown tenant then lands in the DLQ with an alert. Don't use the same high retry count you use for transient DB errors. Use a per-destination policy, or catch `UnknownTenantException` and count it.

**Per-tenant DLQ triage.** With 300 tenants, the DLQ mixes everyone's failures:

- **Metric:** DLQ depth **by tenant** (`tenantId` property, or `unknown` if it's missing). Alert per tenant, so one noisy tenant doesn't hide another tenant's single failure.
- **Browse** by selector: a queue browser with `tenantId = 'hooli'`.
- **Replay tool:** re-validates the tenant against the registry, **keeps the original `tenantId`** (it never takes a tenant from the operator's input for an existing message), sends to the *current* destination for that tenant (it may have moved shards), and rate-limits the replay so it doesn't swamp a shard. Messages with *no* tenant can't be replayed blindly. A human must establish the source (e.g. from the original inbound queue in the audit log).
- **Ordering:** replaying an old message for an account that has since been updated can apply events out of order. Decide per message type whether replay is safe, or park and reprocess the whole tenant's sequence.

### 2.5 Context propagation across threads (15 min)

A `ThreadLocal` belongs to **one thread**. Every time work moves to another thread, the tenant is gone unless something carries it.

```
 listener thread [tenant=acme]
   ├─ @Async method                 -> task-executor thread    [tenant=?]  LOST
   ├─ executor.submit(...)          -> pool thread             [tenant=?]  LOST
   ├─ CompletableFuture.supplyAsync -> ForkJoinPool.commonPool [tenant=?]  LOST
   ├─ list.parallelStream()         -> ForkJoinPool.commonPool [tenant=?]  LOST (mostly)
   ├─ Caffeine refreshAfterWrite    -> cache executor          [tenant=?]  LOST
   ├─ Mono/Flux publishOn/subscribeOn -> Reactor scheduler     [tenant=?]  LOST
   └─ (separately) @Scheduled tick  -> scheduler thread        [tenant=none ever]
```

**Worse than "lost": stale.** Pool threads keep whatever they were last given. Without a matching `clear()`, a worker "lost" in this sense can still hold *another* tenant's value. That's why propagation always means **capture → set → run → restore/clear in `finally`**.

#### Option 1: Spring `TaskDecorator` (executors and `@Async`) [Spring-Task]

```java
public class TenantTaskDecorator implements TaskDecorator {
    @Override
    public Runnable decorate(Runnable task) {
        String captured = TenantContext.current().orElse(null);   // on the SUBMITTING thread
        return () -> {
            String previous = TenantContext.current().orElse(null); // non-null only if run on the caller
            TenantContext.clear();                                   // never trust what a pooled worker holds
            try {
                if (captured != null) TenantContext.set(captured);
                task.run();
            } finally {
                TenantContext.clear();
                if (previous != null) TenantContext.set(previous);   // e.g. CallerRunsPolicy: give it back
            }
        };
    }
}

@Bean TaskDecorator tenantTaskDecorator() { return new TenantTaskDecorator(); }
```

Spring Boot applies a single `TaskDecorator` bean to the **auto-configured** `applicationTaskExecutor` (used by `@Async` by default). ⚠ UNVERIFIED for your Boot version: check *Task Execution and Scheduling* in the Boot reference. Executors you build yourself with `new ThreadPoolTaskExecutor()` need `setTaskDecorator(...)` called explicitly. A bare `Executors.newFixedThreadPool(...)` gets nothing.

#### Option 2: Micrometer Context Propagation [Micrometer-CP]

Register the `ThreadLocal` once. Then the library (and Spring and Reactor integrations) can capture and restore it together with the others it knows: MDC, the tracing context, and so on.

```java
@Configuration
class TenantPropagationConfig {
    TenantPropagationConfig() {
        ContextRegistry.getInstance().registerThreadLocalAccessor(
            "tenantId",
            () -> TenantContext.current().orElse(null),   // getter
            TenantContext::set,                           // setter
            TenantContext::clear);                        // reset
    }

    @Bean TaskDecorator contextPropagatingTaskDecorator() {
        return new ContextPropagatingTaskDecorator();     // Spring Framework 6.1+: snapshot all registered ThreadLocals
    }
}

// Plain executors:
ExecutorService wrapped = ContextExecutorService.wrap(Executors.newFixedThreadPool(4));
```

⚠ UNVERIFIED: in the Micrometer docs, check the exact `ThreadLocalAccessor` method names for your context-propagation version (1.0 vs 1.1 renamed the reset method). The four-argument `registerThreadLocalAccessor(key, getter, setter, reset)` form avoids that question.

#### Option 3: Reactor [Reactor-CP]

In reactive code, the source of truth is the **Reactor `Context`**, not a `ThreadLocal`. Since Reactor 3.5.3, `Hooks.enableAutomaticContextPropagation()` restores registered `ThreadLocal`s from the Reactor `Context` around operators. Spring Boot 3.2+ enables this with `spring.reactor.context-propagation=auto`. ⚠ UNVERIFIED property name for your Boot version.

```java
return webClient.get().uri("/instruments/{isin}", isin).retrieve().bodyToMono(Ref.class)
        .contextWrite(Context.of("tenantId", TenantContext.require()));   // write at the edge of the chain
```

#### Rules that apply to all three

- **`CompletableFuture`: always pass an executor.** `supplyAsync(fn)` without one uses `ForkJoinPool.commonPool()`, which no decorator touches.
- **Avoid `parallelStream()`** for tenant work. It uses the common pool. (The calling thread also takes part, so it *sometimes* works in tests, which makes it worse.)
- **`InheritableThreadLocal` is not a fix.** It copies the value when a thread is **created**. Pool threads are created once and reused, so they keep whichever tenant was current when the pool grew.
- **Schedulers are boundaries, not hops.** A `@Scheduled` tick has no tenant and should not inherit one. It must loop over tenants explicitly, setting and clearing per tenant, with one transaction per tenant.
- **Cache loaders and refreshes** run whenever the cache decides. Their keys **must carry the tenant** (Day 2), and the loader must set the context *from the key*, not from the thread:

```java
LoadingCache<TenantKey, List<Row>> cache = Caffeine.newBuilder()
    .refreshAfterWrite(Duration.ofMinutes(10))
    .build(key -> {
        TenantContext.set(key.tenantId());                // context comes FROM THE KEY
        try { return repo.load(key.table()); }
        finally { TenantContext.clear(); }
    });
```

Java 21+ has `ScopedValue`, a structured alternative to `ThreadLocal` that suits virtual threads (preview in 21, ⚠ UNVERIFIED: finalised in a later JDK). You are on Java 17, so note it for later.

### 2.6 Outbound calls: always carry `X-Tenant-Id` (8 min)

Put the header on the **client builder**, once. Then make sure every client is built from that builder.

```java
@Bean
RestTemplateCustomizer tenantHeader() {
    return rt -> rt.getInterceptors().add((req, body, exec) -> {
        req.getHeaders().set("X-Tenant-Id", TenantContext.require());   // fail closed if missing
        return exec.execute(req, body);
    });
}

@Bean
RestTemplate refDataClient(RestTemplateBuilder builder) {      // builder has the customizer applied
    return builder.rootUri("http://refdata").build();
}
```

**Why `new RestTemplate()` skips it:** Spring Boot's auto-configured `RestTemplateBuilder` applies all `RestTemplateCustomizer` beans when *it* builds a template (Spring Boot reference, *Calling REST Services → RestTemplate customization*). `new RestTemplate()` is a plain object. It never meets the builder, so it has no interceptors, no header and no tenant. The same is true for the others:

| Client | Shared hook | Bypass that loses the header |
|---|---|---|
| `RestTemplate` | `RestTemplateBuilder` + `RestTemplateCustomizer` | `new RestTemplate()` |
| `RestClient` (Spring 6.1+) | `RestClient.Builder` bean + `RestClientCustomizer` | `RestClient.create()` |
| `WebClient` | `WebClient.Builder` bean + `WebClientCustomizer` / `ExchangeFilterFunction` | `WebClient.create()` |
| OpenFeign | `RequestInterceptor` bean | a client built manually with `Feign.builder()` without it |

For `WebClient`, read the tenant **from the Reactor Context** in the filter (`Mono.deferContextual`). With automatic propagation on, the `ThreadLocal` also works, but the Reactor Context is the source of truth.

**Server side (the receiving internal service):** a filter that reads `X-Tenant-Id`, checks it against the registry, sets the context, and clears it in `finally`. It rejects missing or unknown tenants with 400 or 403. Day 4 covers why this filter must **never** face the browser.

### 2.7 Videos for today (optional)

| Search query | Watch for | Key takeaway |
|---|---|---|
| `Micrometer context propagation Spring Boot 3` (SpringDeveloper / Spring I/O) | `ThreadLocalAccessor`, `ContextSnapshot`, Reactor automatic mode | Register once; everything that knows Micrometer then carries it |
| `Reactor context ThreadLocal propagation` | Why `ThreadLocal` breaks across `publishOn`, and what `contextWrite` does | In reactive code, Reactor Context is the source of truth |
| `ActiveMQ message groups` / `ActiveMQ virtual topics` | Group assignment to consumers; consumer queue naming | Groups order within one queue only |
| `consistent hashing explained` and `jump consistent hash` | Fraction of keys that move when buckets change | `mod N` moves ~N/(N+1); consistent hashing ~1/(N+1) |
| `re:Invent SaaS noisy neighbor queue` | Per-tenant queues vs shared queues and tiering | Dedicated queues are a tiering lever |

---

## 3. Hands-on exercises (45 min)

### Exercise 3.1: Compute the shards (10 min)

Here are the `String.hashCode()` values (computed with Java's formula):

| tenantId | `hashCode()` |
|---|---|
| `acme` | 2988346 |
| `globex` | −1243020245 |
| `initech` | 1948338298 |
| `umbrella` | −1381913276 |
| `hooli` | 99463109 |
| `stark` | 109757529 |
| `polygenelubricants` | −2147483648 (= `Integer.MIN_VALUE`) |

1. Compute `Math.floorMod(h, 4)` for the first six tenants. Which shards get two or more tenants?
2. A teammate's producer uses `Math.abs(h) % 4`. For which tenants does it disagree with `floorMod`? What happens at run time?
3. N changes from 4 to 5. Compute `floorMod(h, 5)`. How many of the six tenants move?
4. What does `Math.abs(h) % 5` return for `polygenelubricants`? What does `"PARSE.shard-" + that` produce?
5. `hooli` and `stark` turn out to be the two largest tenants. What would you do?

### Exercise 3.2: Trace the thread hops (15 min)

Follow one message for tenant `acme` through these three services. Mark **every thread hop**, say whether the tenant is present, missing, or possibly **stale** (another tenant's), and fix each one.

```java
// PARSER
@JmsListener(destination = "PARSE.shard-${shard}")
void onMessage(Message m) {
    TenantContext.set(m.getStringProperty("tenantId"));
    try {
        Trade t = parse(m);
        CompletableFuture<Void> v = CompletableFuture.runAsync(() -> validator.validate(t));   // (a)
        v.join();
        publisher.forward("ENRICH", t);                                                         // copies tenantId
    } finally { TenantContext.clear(); }
}

// ENRICHER
@JmsListener(destination = "ENRICH.shard-${shard}")
void onMessage(Message m) {
    TenantContext.set(m.getStringProperty("tenantId"));
    try {
        Trade t = read(m);
        Ref r = webClient.get().uri("/instruments/{isin}", t.isin())                            // (b)
                 .retrieve().bodyToMono(Ref.class)
                 .publishOn(Schedulers.boundedElastic())
                 .map(ref -> ref.withRating(ratings.lookup(ref)))                               // (c) ratings uses TenantContext
                 .block();
        publisher.forward("RULES", enrich(t, r));
    } finally { TenantContext.clear(); }
}

// RULES
@JmsListener(destination = "RULES.shard-${shard}")
void onMessage(Message m) {
    TenantContext.set(m.getStringProperty("tenantId"));
    try {
        Trade t = read(m);
        List<Breach> b = rules.all().parallelStream().map(r -> r.eval(t)).flatMap(Optional::stream).toList();  // (d)
        auditService.recordAsync(t, b);                                                         // (e) @Async method
        publisher.forward("REPORT", t.with(b));
    } finally { TenantContext.clear(); }
}
```

`webClient` was built from the Boot `WebClient.Builder`, with a filter that reads `TenantContext` to set `X-Tenant-Id`. `auditService.recordAsync` is `@Async` on the default executor, and there is **no** `TaskDecorator` bean.

### Exercise 3.3: The scheduler that reloads the cache (8 min)

```java
@Component
class RatingsCache {
    private volatile Map<String, Rating> byIsin = Map.of();

    @Scheduled(fixedDelay = 600_000)
    void reload() {
        byIsin = ratingsRepo.findAll().stream()
                 .collect(Collectors.toMap(Rating::isin, r -> r));
    }

    Rating get(String isin) { return byIsin.get(isin); }
}
```

The service runs in a shared deployment with schema-per-tenant. Describe what happens (a) with our fail-closed `TenantSchemaDataSource`, and (b) in a version where someone "fixed" the startup error by giving the data source a default schema. Then rewrite the class.

### Exercise 3.4: Design DLQ triage for one bad tenant (12 min)

At 09:10 `hooli` deploys a new version of its upstream system and starts sending trades with a malformed date field. By 09:40 there are 48,000 messages in `ActiveMQ.DLQ`, mixed with about 30 messages from other tenants (some with no tenant at all). `hooli` fixes their system at 10:15 and asks you to "reprocess everything".

Design the triage: detection, containment, separation, the replay, and what you change so next time is easier. Be specific about properties, selectors, ordering and rate.

---

## 4. Closing quiz (15 min)

**Q1.** Which expression maps a tenant to one of N shards correctly in Java?

- A) Math.floorMod(id.hashCode(), n)
- B) (int) Math.abs(id.hashCode()) % n
- C) id.hashCode() % n, cast to long
- D) System.identityHashCode(id) % n

**Q2.** Going from N=4 to N=5 shards with `mod N`, roughly what share of tenants move?

- A) About one fifth of all tenants
- B) About four fifths of tenants
- C) None, since hashCode is stable
- D) Exactly half of all tenants

**Q3.** A Boot service creates its client with `new RestTemplate()`. A `RestTemplateCustomizer` bean adds `X-Tenant-Id`. What is sent?

- A) The header, since customizers are global
- B) A header with an empty value on all calls
- C) The header, but only on the POST requests
- D) No header, as the builder is not involved

**Q4.** Why is `JMSXGroupID = accountNo` a problem in a shared shard queue?

- A) Group IDs must be numeric in ActiveMQ
- B) Message groups do not work with shards
- C) The broker drops groups it cannot map
- D) Groups across tenants become coupled

**Q5.** *(Day 2)* Why must the borrow-time `SET search_path` run before Spring starts the transaction?

- A) A SET in a rolled-back tx is reverted
- B) PostgreSQL forbids SET inside any tx
- C) HikariCP blocks SQL once a tx begins
- D) Spring caches the path at tx commit

**Q6.** A `@Scheduled` job needs per-tenant data. What is the correct pattern?

- A) Inherit the tenant from the last request
- B) Use a default tenant for scheduler work
- C) Loop tenants; set, run, clear for each
- D) Use InheritableThreadLocal for the job

**Q7.** *(Day 1)* What should the ingester do with a `tenantId` property that the customer put on an inbound message?

- A) Trust it if it matches a registry entry
- B) Use it only when the queue is shared
- C) Overwrite it with the queue's tenant
- D) Copy it to the X-Tenant-Id header too

**Q8.** *(Day 2)* Your RLS policy uses `current_setting('app.tenant_id', true)`, and the setting was never set on this connection. What does a SELECT return?

- A) All rows, as the policy is skipped
- B) No rows, as the comparison is null
- C) Rows of the last tenant that used it
- D) An error that the setting is missing

---

## 5. Cheat sheet: Day 3

```
DESTINATIONS   stage.shard-k (pool) | stage.<tenant> (silo) | one destination() fn
               virtual topic: VirtualTopic.X -> Consumer.<svc>.VirtualTopic.X
               inbound IN.<tenant>: broker authz = only that customer writes
               avoid selectors-per-tenant at scale

GROUPS         JMSXGroupID = tenantId + ":" + key   (order per key per tenant)
               order holds WITHIN ONE QUEUE only

SHARDING       Math.floorMod(id.hashCode(), N)   NOT abs(h)%N, NOT h%N
               N -> N+1 moves ~N/(N+1) tenants (one-way door)
               moving = drain old shard first, or ordering breaks
               options: consistent / jump hash; persist shard in registry
               hot shard -> promote big tenant to DEDICATED

BROADCAST      explicit scope=GLOBAL on allow-listed destinations
               fan out: per tenant set/try/finally clear, 1 tx per tenant
               "no tenant" on a normal message still = fail closed

DLQ            throw -> rollback -> redeliver (default 6, verify) -> DLQ
               ActiveMQ.DLQ shared by default; individualDeadLetterStrategy DLQ.<dest>
               dlqDeliveryFailureCause; metric DLQ depth BY TENANT
               replay: keep original tenantId, current destination, rate-limited

THREAD HOPS    @Async, executors, CompletableFuture (pass executor!),
               parallelStream (avoid), cache refresh, Reactor publishOn/subscribeOn
               fix: TaskDecorator | Micrometer ContextRegistry + ContextPropagatingTaskDecorator
                    | Reactor contextWrite + automatic propagation
               always capture -> set -> run -> clear in finally
               InheritableThreadLocal != fix; @Scheduled = boundary, loop tenants
               cache loader sets context FROM THE KEY

OUTBOUND       interceptor on the BUILDER; build every client from it
               new RestTemplate() / WebClient.create() / RestClient.create() = no header
```

### Glossary additions (Day 3)

Virtual topic · Consumer queue · Shard queue · Shard count (N) · One-way door · Consistent hashing · Hot shard · Dedicated queue · Message group · Broadcast message · Poison message · Redelivery policy · Dead-letter queue (DLQ) · Thread hop · Task decorator · Context snapshot · `ThreadLocalAccessor` · Automatic context propagation · Outbound propagation. Definitions: [glossary.md](glossary.md#day-3-messaging-and-context-propagation).

---

## 6. Answers

### Warm-up answers

1. `t_x` is skipped silently and `public.trades` is read. That leaks if `public.trades` exists. Rules: set **only** the tenant schema (no `public`), and keep `public` empty with no `CREATE` for the app role. Also check that the schema exists against the registry.
2. It runs once when the physical connection is created, while connections serve many tenants over their life. You must switch on every borrow.
3. All into the tenant whose context was set when the transaction **borrowed** its connection, because one transaction = one connection = one `search_path`. (Or it fails if none was set.)
4. The tenant ID. Spring's `@Cacheable` default key = method parameters only.
5. The control plane manages tenants (registry, onboarding, offboarding, per-tenant config). The application plane does tenant work (parser, enricher, rules, reporter).

### Exercise 3.1: worked answer

1. `floorMod(h, 4)`: acme **2**, globex **3**, initech **2**, umbrella **0**, hooli **1**, stark **1**. Shards 1 and 2 each get two tenants. Shard 0 has only umbrella and shard 3 only globex.
2. `Math.abs(h) % 4`: acme 2, globex **1** (floorMod: 3), initech 2, umbrella 0, hooli 1, stark 1. **globex disagrees**: the producer sends it to `shard-1`, while the tooling and dedicated-listener config expect `shard-3`. Messages still get processed (shard-1 has consumers), but monitoring, replay and any "consumer for shard-3 handles globex" assumption are wrong. If later code moves globex based on the *other* formula, ordering breaks. (For `umbrella` the two agree only by chance.) The lesson: one function, in one library.
3. `floorMod(h, 5)`: acme 1, globex 0, initech 3, umbrella 4, hooli 4, stark 4. **All six move** (2→1, 3→0, 2→3, 0→4, 1→4, 1→4). Six samples are a small sample, but the expected share is ~80%. Also, three tenants now share shard 4.
4. `Math.abs(Integer.MIN_VALUE)` is `Integer.MIN_VALUE`, and `Integer.MIN_VALUE % 5` in Java is **−3**. The destination becomes `PARSE.shard--3`. ActiveMQ creates destinations on demand by default, so the messages quietly go into a queue **nobody consumes**. No error: the messages just stop. (`floorMod` gives 2.) A name like `polygenelubricants` is unlikely, but tenant IDs are customer-chosen in self-service sign-up. Disable auto-creation of destinations, or check the destination against the known set before sending.
5. They share shard 1 (N=4): a **hot shard**. Promote at least one to the **dedicated** tier with a registry override. Drain its in-flight messages on shard-1 before switching, so order is kept. Consider persisting shard assignments in the registry so future changes are explicit.

### Exercise 3.2: worked answer

| Hop | What happens | Fix |
|---|---|---|
| (a) `CompletableFuture.runAsync` without an executor | Runs on `ForkJoinPool.commonPool()`. Tenant **missing**, or **stale** if any code ever set a context on a common-pool thread without clearing it. `validator` reading tenant config fails (fail-closed) or uses the wrong tenant. | Pass a context-propagating executor (`ContextExecutorService.wrap(...)` or a decorated `ThreadPoolTaskExecutor`). Here, simply call `validator.validate(t)` synchronously, since the code `join()`s immediately anyway. |
| (b) `webClient ... retrieve()` | The request is subscribed when `block()` is called on the listener thread, so the filter *may* see the `ThreadLocal`. But the response is handled on Netty event-loop threads. Whether the filter sees the tenant depends on where it runs. **Fragile.** | `contextWrite(Context.of("tenantId", TenantContext.require()))` on the chain. The filter reads the Reactor Context (`Mono.deferContextual`), or relies on automatic propagation with a registered accessor. |
| (c) `.publishOn(boundedElastic()).map(...)` | `map` runs on a `boundedElastic` worker. `ratings.lookup` reads `TenantContext`: **missing** or **stale**. | Enable Reactor automatic context propagation plus the registered accessor, so the `ThreadLocal` is restored around `map`. Or pass the tenant explicitly: `ratings.lookup(tenantId, ref)`. Or drop `publishOn`; nothing here needs it. |
| (d) `parallelStream()` | Some elements run on the calling thread (tenant present), some on common-pool threads (**missing/stale**). The result depends on timing. Tests often pass. | Use a sequential `stream()`. If you need parallelism, use an explicit decorated executor. |
| (e) `@Async recordAsync` with no `TaskDecorator` | Runs on `applicationTaskExecutor`. Tenant **missing**, or **stale** from a previous task if any code sets without clearing. Audit records written to the wrong schema or failing. | Add a `TaskDecorator` bean (or `ContextPropagatingTaskDecorator` + registered accessor), which Boot applies to the auto-configured executor. Better still, make the tenant an explicit argument: `recordAsync(tenantId, t, b)`, which sets and clears inside. |
| JMS hops (parser→enricher→rules) | Not thread hops but **process** hops. `publisher.forward` copies `tenantId` as a property. ✔ | — |

### Exercise 3.3: worked answer

(a) **Fail-closed data source:** the `@Scheduled` thread has **no tenant**, so `TenantContext.require()` in the data-source wrapper throws on every reload. The cache stays `Map.of()` (empty) forever, and `get` returns null. Ratings silently disappear from enrichment unless `null` is handled loudly. Fail-closed worked: no leak, but a functional outage.

(b) **With a "default schema":** the reload reads **one schema's** ratings (say `t_acme` or `public`) and serves them to **every tenant**. That is a cross-tenant leak and wrong data, with no errors. This is exactly why there is no default tenant.

There is a second bug, which applies in both cases: the cache key `isin` has no tenant.

```java
@Component
class RatingsCache {
    private volatile Map<String, Map<String, Rating>> byTenant = Map.of();   // tenant -> isin -> rating

    @Scheduled(fixedDelay = 600_000)
    void reload() {
        Map<String, Map<String, Rating>> next = new HashMap<>(byTenant);
        for (String t : registry.activeSharedTenants()) {
            TenantContext.set(t);
            try {
                next.put(t, ratingsRepo.findAll().stream()
                        .collect(Collectors.toUnmodifiableMap(Rating::isin, r -> r)));
            } catch (Exception e) {
                log.warn("ratings reload failed for tenant {}", t, e);           // keep old entry for t
            } finally {
                TenantContext.clear();
            }
        }
        next.keySet().retainAll(registry.activeSharedTenants());                // offboarded tenants drop out
        byTenant = Map.copyOf(next);
    }

    Rating get(String isin) {
        Map<String, Rating> m = byTenant.get(TenantContext.require());
        return m == null ? null : m.get(isin);
    }
}
```

If you have hundreds of tenants and many pods, consider loading lazily per tenant (a `LoadingCache<TenantKey, …>` whose loader sets the context from the key) instead of reloading everything every 10 minutes.

### Exercise 3.4: worked answer (one good design)

**Detection.** An alert on DLQ depth **by tenant** fires within minutes for `hooli`. The `dlqDeliveryFailureCause` value is the same parse exception across the hooli messages, which confirms a single cause.

**Containment.**
- Stop the bleeding without hurting others. Either pause `hooli`'s ingestion (stop the ingester endpoint for `IN.HOOLI`; the messages wait safely on their source queue) or keep ingesting while they go to the DLQ. Prefer pausing: the source queue preserves order, and the DLQ doesn't.
- Check that other tenants on hooli's shard aren't delayed by redelivery back-off. Every hooli message burned 6 redeliveries on a shared shard: that is a noisy neighbour. Next time, use a lower retry count for non-transient parse errors.

**Separation.**
- Use `individualDeadLetterStrategy` (or a one-off move) so you don't work on the shared `ActiveMQ.DLQ`. With a browser and selector `tenantId = 'hooli'`, move hooli's messages to `DLQ.HOOLI.PARK`. Move the others to their own triage. Messages with **no** tenant go to a separate investigation. They are a *different* bug (lost context) and must not be replayed with a guessed tenant.

**Replay (after 10:15 fix).**
- Can the 48,000 *stored* messages be parsed now? No: they are still malformed. Hooli fixed *future* messages. So either (1) hooli **re-sends** the 09:10–10:15 window from their side, which is cleanest, or (2) you apply a one-off, reviewed transformation to the parked messages.
- Replay keeps the original `tenantId` (and checks it is `hooli`). It sends to hooli's **current** destination (re-compute the shard: it might have moved), with a rate limit (e.g. 200 msg/s) so shard neighbours aren't starved.
- **Ordering:** messages in the DLQ lost their relative order with later messages. If later hooli messages (after 10:15) for the same accounts have already been processed, replaying old ones can apply stale state. Agree with hooli: either replay before resuming new traffic (pause, replay in original order using `JMSTimestamp`, then resume), or have them re-send amendments.

**Next time.**
- A per-destination redelivery policy with fewer retries for parse errors. Or validate at the ingester and route bad messages straight to a per-tenant `DLQ.<tenant>`.
- Per-tenant DLQs, or at least the per-tenant metric and runbook.
- A replay tool that enforces the rules above, so nobody does it by hand.

### Quiz answers

| Q | Answer | Why |
|---|---|---|
| 1 | **A** | `floorMod` is always in `[0, n)`. `abs` fails for `MIN_VALUE` and disagrees for negative values. |
| 2 | **B** | About N/(N+1) = 4/5 of keys move with `mod N`. |
| 3 | **D** | Customizers are applied by the builder. `new RestTemplate()` bypasses it. |
| 4 | **D** | Different tenants with the same account number get serialised together. Include the tenant in the group ID. |
| 5 | **A** | A session `SET` issued inside a transaction that rolls back is undone, which restores the previous tenant's path. |
| 6 | **C** | A scheduler tick is a boundary with no tenant. Loop explicitly, one tenant at a time. |
| 7 | **C** | The tenant comes from the queue. Anything the customer sends is overwritten. |
| 8 | **B** | `current_setting(..., true)` returns NULL, and `tenant_id = NULL` is never true. Fail closed. |
