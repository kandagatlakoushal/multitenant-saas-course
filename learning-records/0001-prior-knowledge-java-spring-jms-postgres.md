# Prior knowledge: Java 17, Spring Boot, ActiveMQ Classic, PostgreSQL, per-customer deployments

The learner stated they already work daily with Java 17, Spring Boot, JMS on ActiveMQ Classic (virtual topics, consumer queues, message groups for per-key ordering), PostgreSQL, REST between microservices, and Spring profiles for per-customer behaviour. All of that experience is on a platform deployed once per customer; multi-tenant SaaS is new.

**Implications:** don't teach JMS, Spring, or SQL basics. Start from what changes when one JVM serves many tenants. Expect the main misconceptions to come from per-customer habits: startup-time config, profiles per customer, `public`-schema assumptions, and business keys assumed globally unique.
