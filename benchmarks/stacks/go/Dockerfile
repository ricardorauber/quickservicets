# Go stack: net/http + pgx/v5, a static binary on an empty (scratch) image.
#   docker build -t qsbench-go benchmarks/stacks/go

FROM golang:1.27.1-alpine3.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server . \
  && mkdir -p /out/data/uploads

FROM scratch
COPY --from=build /out/server /server
COPY --from=build --chown=65532:65532 /out/data /data
ENV PORT=8080 UPLOAD_DIR=/data/uploads
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/server"]
