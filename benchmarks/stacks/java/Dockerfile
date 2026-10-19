# syntax=docker/dockerfile:1
# Spring Boot benchmark service. Build context: this folder.
#   docker build -t qsbench-java benchmarks/stacks/java

# 1. Build the executable jar with the Maven wrapper, then extract it into layers (Spring Boot's jarmode tools).
FROM eclipse-temurin:21.0.12.1_1-jdk-alpine-3.22 AS build
WORKDIR /build
COPY mvnw pom.xml ./
COPY .mvn .mvn
RUN ./mvnw -B -q dependency:go-offline
COPY src src
RUN ./mvnw -B -q package -DskipTests \
  && java -Djarmode=tools -jar target/application.jar extract --layers --destination extracted

# 2. Runtime: the JRE, the extracted application and a class data sharing archive from a training run.
FROM eclipse-temurin:21.0.12.1_1-jre-alpine-3.22
WORKDIR /app
COPY --from=build /build/extracted/dependencies/ ./
COPY --from=build /build/extracted/spring-boot-loader/ ./
COPY --from=build /build/extracted/snapshot-dependencies/ ./
COPY --from=build /build/extracted/application/ ./
# CDS training run (Spring Boot's documented setup): starts the context without serving, records the loaded classes.
RUN java -XX:+UseG1GC -XX:ArchiveClassesAtExit=application.jsa -Dspring.context.exit=onRefresh -jar application.jar \
  && addgroup -S app && adduser -S -G app app && mkdir -p /data/uploads && chown app:app /data/uploads
USER app
ENV PORT=8080 UPLOAD_DIR=/data/uploads
EXPOSE 8080
# 1 GB container with 2 CPUs: G1 (the JVM would pick Serial below 1792 MB), 75 % of the memory for the heap
# (virtual thread stacks live there), the rest for metaspace, code cache, thread and direct buffers.
ENTRYPOINT ["java", "-XX:SharedArchiveFile=application.jsa", "-XX:+UseG1GC", "-XX:MaxRAMPercentage=75", "-XX:+ExitOnOutOfMemoryError", "-jar", "application.jar"]
