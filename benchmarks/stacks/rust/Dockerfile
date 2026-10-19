# syntax=docker/dockerfile:1
# Rust benchmark service (axum + tokio + tokio-postgres). Build context: this folder.
#   docker build -t qsbench-rust benchmarks/stacks/rust

FROM rust:1.98.1-slim-trixie AS build
WORKDIR /app
# Dependencies first, so source changes do not rebuild them.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
  && cargo build --release --locked \
  && rm -rf src target/release/deps/qsbench_rust* target/release/qsbench-rust*
COPY src src
RUN cargo build --release --locked \
  && mkdir -p /out/data/uploads \
  && cp target/release/qsbench-rust /out/qsbench-rust

# glibc and libgcc only, no shell; runs as the nonroot user (65532).
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2
ENV PORT=8080 UPLOAD_DIR=/data/uploads
COPY --from=build --chown=65532:65532 /out/data /data
COPY --from=build /out/qsbench-rust /usr/local/bin/qsbench-rust
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/qsbench-rust"]
