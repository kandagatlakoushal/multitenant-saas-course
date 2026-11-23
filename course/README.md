# Multi-Tenant SaaS for Java Backend Developers: a 4-Day Course

**Who it's for:** an experienced Java 17 / Spring Boot / JMS (ActiveMQ Classic) / PostgreSQL developer who has always shipped *one deployment per customer* and now needs to make *one shared deployment serve many customers*.

**By the end of Day 4 you should be able to:**

1. Convert existing Spring Boot microservices so one shared deployment serves many customers safely.
2. Review that kind of code for cross-tenant leaks.
3. Argue design trade-offs in team meetings.

---

## How to use this course

| File | Contents |
|---|---|
| [day1.md](day1.md) | SaaS multi-tenancy foundations and tenant identity |
| [day2.md](day2.md) | Data isolation (PostgreSQL, HikariCP, routing, migrations, caches) |
| [day3.md](day3.md) | Messaging, async work and context propagation |
| [day4.md](day4.md) | The trusted edge, operations, testing isolation, capstone |
| [glossary.md](glossary.md) | One glossary for all four days. Every day uses these terms. |

Each day takes **2.5 hours** and has the same shape:

| Block | Time | Rule |
|---|---|---|
| 1. Retrieval warm-up | 10 min | Answer from memory. No scrolling back. Write the answers down before you check. |
| 2. Core study | 60–75 min | Read the notes, then watch the videos for the section if you have time left. |
| 3. Hands-on exercises | 45 min | Write your answer *before* opening the worked answers. |
| 4. Closing quiz | 15 min | 8 questions. Some cover earlier days. |
| 5. Cheat sheet + glossary | 10–15 min | Read the cheat sheet once more. Add the new terms to your own notes. |

All answers (warm-up, exercises, quiz) are at the **end** of each day's file, under **Answers**.

### Conventions

- **[Source: …]** means a claim comes from the primary source named there. The full list is below.
- **⚠ UNVERIFIED** marks something I am not fully sure of, such as an exact default value or a chapter number. Check it before you quote it in a meeting.
- **Video resources:** I do not give video URLs or exact talk titles unless I am certain they exist. You get **search queries** to paste into YouTube, and **watch-for prompts** that tell you what to look for. Good channels to search: *AWS Events* (re:Invent talks, especially the SaaS track talks by Tod Golding), *Spring I/O*, *SpringDeveloper*, *Devoxx*, *GOTO Conferences*, *InfoQ*.

---

## The running example: a generic trade-processing pipeline

Every day uses this system. It is what you are converting.

```
   Customer A          Customer B          Customer C (large)
   source queue        source queue        source queue
   IN.A                IN.B                IN.C
       \                   |                   /
        \                  |                  /
         v                 v                 v
   +------------------------------------------------+
   |  INGESTER  (the trusted edge for messages)      |
   |  tenantId := registry.lookupBySourceQueue(q)    |
   |  unknown queue -> retry -> DLQ  (fail closed)   |
   +------------------------------------------------+
         |  JMS property tenantId=...
         v
   shard queues  PARSE.shard-0 .. PARSE.shard-(N-1)    (pool tier: hash(tenantId) mod N)
   dedicated     PARSE.C                               (silo tier for big tenants)
         |
         v
   PARSER --JMS--> ENRICHER --JMS--> RULES --JMS--> REPORTER
                      |
                      | REST, header X-Tenant-Id
                      v
               REFERENCE-DATA service (has caches)

   Inside every service:
     boundary (listener / HTTP filter) -> TenantContext.set(id)
       -> business code -> DB (HikariCP borrow -> SET search_path)
     finally -> TenantContext.clear()

   UI:  browser --OIDC login--> UI GATEWAY (BFF)
        tenant := f(authenticated user)    NEVER from a browser-sent header
```

**The tenant registry** (control plane data) lists every tenant and two placement choices:

```yaml
tenants:
  - id: acme
    sourceQueue: IN.ACME
    database: { isolation: SCHEMA, schema: t_acme }          # own schema in shared DB
    queues:   { tier: SHARED }                               # hash(tenantId) mod N
  - id: globex
    sourceQueue: IN.GLOBEX
    database: { isolation: DATABASE, jdbcUrl: jdbc:postgresql://db-globex:5432/globex }
    queues:   { tier: DEDICATED }                            # PARSE.globex, ...
  - id: initech
    sourceQueue: IN.INITECH
    database: { isolation: LEGACY }                          # still on old per-customer stack
    queues:   { tier: LEGACY }
```

**Ground rules of the target design** (you will meet each one in depth):

1. The tenant is assigned **once**, at a trusted edge: the ingester (by source queue) or the UI gateway (by logged-in user).
2. Later services only **pass it on**: JMS property between services, `X-Tenant-Id` header on internal REST calls.
3. Inside a service, the tenant lives in a `ThreadLocal` `TenantContext`. It is set at the boundary and cleared in `finally`.
4. The DB layer switches PostgreSQL `search_path` **on every connection borrow** from HikariCP.
5. **Fail closed:** no tenant or an unknown tenant means retry a few times, then DLQ. There is **no default tenant**.
6. An opt-in flag (`multitenancy.enabled`) keeps the old single-customer behaviour as the default. When it is on, the old JMS listeners are switched off with `@ConditionalOnProperty`.

---

## Primary sources

Cited by short name in the notes. Where a URL might have moved, search for the page title.

| Short name | Source |
|---|---|
| **Golding** | Tod Golding, *Building Multi-Tenant SaaS Architectures*, O'Reilly, 2024. Cited by topic, not page. ⚠ UNVERIFIED: I do not cite chapter numbers because I am not sure of them. |
| **AWS-Fund** | AWS whitepaper *SaaS Architecture Fundamentals*. `https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/` |
| **AWS-Iso** | AWS whitepaper *SaaS Tenant Isolation Strategies*. `https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/` |
| **Azure-MT** | Azure Architecture Center, *Architect multitenant solutions on Azure*. `https://learn.microsoft.com/azure/architecture/guide/multitenant/overview`. Sub-pages used: *Tenancy models*, *Tenant lifecycle*, *Control planes*, *Map requests to tenants*, *Storage and data approaches*, *Messaging approaches*, *Noisy Neighbor antipattern*, *Deployment Stamps pattern*. |
| **PG-Schemas** | PostgreSQL docs, *5.x Schemas* (the "ddl-schemas" page). `https://www.postgresql.org/docs/current/ddl-schemas.html` |
| **PG-Client** | PostgreSQL docs, *Client Connection Defaults* (`search_path`). `https://www.postgresql.org/docs/current/runtime-config-client.html` |
| **PG-SET** | PostgreSQL docs, *SET* command. `https://www.postgresql.org/docs/current/sql-set.html` |
| **PG-RLS** | PostgreSQL docs, *Row Security Policies*. `https://www.postgresql.org/docs/current/ddl-rowsecurity.html` |
| **Hikari** | HikariCP README and wiki (*About Pool Sizing*). `https://github.com/brettwooldridge/HikariCP` |
| **AMQ-VD** | ActiveMQ Classic docs, *Virtual Destinations*. |
| **AMQ-MG** | ActiveMQ Classic docs, *Message Groups*. |
| **AMQ-RD** | ActiveMQ Classic docs, *Redelivery Policy* and *Message Redelivery and DLQ Handling*. (Index: `https://activemq.apache.org/components/classic/documentation`) |
| **Boot-AC** | Spring Boot reference, *Creating Your Own Auto-configuration*, plus the `@ConditionalOnProperty` and `@Conditional` javadoc. |
| **Spring-Task** | Spring Framework reference, *Task Execution and Scheduling*; `TaskDecorator` and `ContextPropagatingTaskDecorator` javadoc. |
| **Micrometer-CP** | Micrometer *Context Propagation* reference. `https://docs.micrometer.io/context-propagation/reference/` |
| **Reactor-CP** | Reactor reference, *Context-Propagation Support* (automatic mode). |
| **SpringSec** | Spring Security reference, *Servlet Applications → Architecture*. `https://docs.spring.io/spring-security/reference/servlet/architecture.html` |
| **OWASP-A01** | OWASP Top 10, *A01 Broken Access Control* (2021 edition; also A01 in the 2025 edition, ⚠ UNVERIFIED for 2025 final wording). `https://owasp.org/Top10/A01_2021-Broken_Access_Control/` |
| **SRE-Overload** | Google, *Site Reliability Engineering*, chapter "Handling Overload". `https://sre.google/sre-book/handling-overload/` |

**Secondary sources mentioned once or twice:** Karger et al., "Consistent Hashing and Random Trees" (STOC 1997); Lamping & Veach, "A Fast, Minimal Memory, Consistent Hash Algorithm" (2014, "jump consistent hash"); the Spring Framework `AbstractRoutingDataSource` javadoc; the Hibernate ORM user guide, *Multitenancy* chapter.
