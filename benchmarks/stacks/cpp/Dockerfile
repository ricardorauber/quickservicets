# C++20 + Drogon, release build. Build context: benchmarks/stacks/cpp.
ARG DEBIAN_IMAGE=debian:trixie-20260918-slim

FROM ${DEBIAN_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make libjsoncpp-dev libpq-dev uuid-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

# Drogon v1.9.13 (2026-05-07) with the Trantor commit that release pins as its submodule.
ARG DROGON_TAG=v1.9.13
ARG DROGON_COMMIT=4c5430757ea5451a7c38fbbef4b4bef7dbb47f2f
RUN git clone --quiet --depth 1 --branch ${DROGON_TAG} --recurse-submodules --shallow-submodules \
      https://github.com/drogonframework/drogon.git /src/drogon \
 && test "$(git -C /src/drogon rev-parse HEAD)" = "${DROGON_COMMIT}" \
 && cmake -S /src/drogon -B /src/drogon/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_STANDARD=20 \
      -DBUILD_CTL=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_POSTGRESQL=ON -DBUILD_MYSQL=OFF -DBUILD_SQLITE=OFF -DBUILD_REDIS=OFF \
      -DBUILD_BROTLI=OFF -DBUILD_YAML_CONFIG=OFF \
 && cmake --build /src/drogon/build -j"$(nproc)" \
 && cmake --install /src/drogon/build

WORKDIR /src/app
COPY CMakeLists.txt ./
COPY src ./src
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j"$(nproc)" \
 && strip build/server

FROM ${DEBIAN_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends libjsoncpp26 libpq5 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/app/build/server /usr/local/bin/server
# A new volume mounted here takes this ownership, so the service can write uploads without root.
RUN mkdir -p /data/uploads && chown nobody:nogroup /data/uploads
USER nobody
WORKDIR /tmp
ENV PORT=8080
EXPOSE 8080
CMD ["/usr/local/bin/server"]
