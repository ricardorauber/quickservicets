# java: Spring Boot

Spring Boot 3.5.16 on Java 21 (Eclipse Temurin 21.0.12.1): Spring MVC on embedded Tomcat 10.1, JdbcTemplate, HikariCP and the PostgreSQL JDBC driver (versions managed by Spring Boot). Built with the Maven wrapper (Maven 3.9.16).

| | |
| --- | --- |
| Build | `./mvnw package`, then `java -Djarmode=tools extract --layers` (Spring Boot's container layout) |
| Runtime image | `eclipse-temurin:21.0.12.1_1-jre-alpine-3.22`, non-root user |
| Startup | Class data sharing archive from a training run at build time (`-XX:ArchiveClassesAtExit`, `-Dspring.context.exit=onRefresh`), as the Spring Boot reference recommends for containers |
| JVM | `-XX:+UseG1GC -XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError` |

## How it uses 2 CPUs

One JVM process. `spring.threads.virtual.enabled=true`: Tomcat runs each request on a virtual thread, carried by a ForkJoinPool sized to the 2 available processors (the JVM detects the container's CPU limit). The JIT and G1 also size their threads for 2 CPUs. HikariCP holds exactly `DB_POOL_SIZE` (10) connections (`maximum-pool-size` = `minimum-idle`); the pool starts on the first database request.

Without flags, the JVM would choose the Serial collector and a 256 MB heap in a 1 GB, 2-CPU container (it is not a "server-class machine" below 1792 MB), so G1 and a 75 % heap are set explicitly.

## Notable choices

- Configuration from `PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_SIZE` and `UPLOAD_DIR` (`DATABASE_URL` is not read: JDBC needs its own URL form, and `run.ts` sets the `DB_*` variables too).
- SQL by hand with JdbcTemplate: filters, sort and paging in SQL with bound parameters; a page of organizations loads its members (ids, or user records with `populate=members`) with one `= ANY(?)` query; stats are one aggregate query; `DELETE /users/{id}` is one statement (a data-modifying CTE) that deletes the user and moves the `updatedAt` of its organizations.
- JSON bodies are read as a Jackson tree and validated by hand, so every problem is reported with the contract's messages. Records are built as ordered maps and serialized by Spring's Jackson converter.
- `server.tomcat.relaxed-query-chars` allows the unencoded brackets of `where[field][op]`, which Tomcat rejects by default.
- Uploads use the Servlet multipart parser (parts up to 2 MB stay in memory); the 1 MiB limit is checked by the handler after type detection, in the contract's order.
- Filter operators: the contract's set plus `nin`, `contains`, `startsWith`, `exists` and `isNull` on columns; `members` cannot be filtered.
- Logging: Spring Boot's default (startup lines only, no request logs).

## Running on the host

```bash
./mvnw package -DskipTests
PORT=8080 DB_PORT=55432 DB_NAME=bench java -jar target/application.jar
```
