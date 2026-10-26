// Command server is the Go stack of the QuickService.ts benchmark: the API of benchmarks/CONTRACT.md on the
// standard library's net/http (ServeMux method and path patterns) and pgx/v5's connection pool.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type app struct {
	db        *pgxpool.Pool
	uploadDir string
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// databaseURL reads DATABASE_URL, or builds the URL from DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME.
func databaseURL() string {
	if value := os.Getenv("DATABASE_URL"); value != "" {
		return value
	}
	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(env("DB_USER", "bench"), env("DB_PASSWORD", "bench")),
		Host:   env("DB_HOST", "localhost") + ":" + env("DB_PORT", "55432"),
		Path:   "/" + env("DB_NAME", "bench"),
	}
	return u.String()
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	config, err := pgxpool.ParseConfig(databaseURL())
	if err != nil {
		log.Fatalf("database configuration: %v", err)
	}
	poolSize, err := strconv.Atoi(env("DB_POOL_SIZE", "10"))
	if err != nil || poolSize < 1 {
		log.Fatalf("DB_POOL_SIZE must be a positive integer")
	}
	config.MaxConns = int32(poolSize)
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		log.Fatalf("database pool: %v", err)
	}
	defer pool.Close()

	a := &app{db: pool, uploadDir: env("UPLOAD_DIR", "uploads")}
	server := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           a.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			fmt.Fprintf(os.Stderr, "shutdown: %v\n", err)
		}
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("listen: %v", err)
	}
	<-stopped
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)

	mux.HandleFunc("GET /users", a.listUsers)
	mux.HandleFunc("POST /users", a.createUser)
	mux.HandleFunc("GET /users/{id}", a.getUser)
	mux.HandleFunc("PATCH /users/{id}", a.updateUser)
	mux.HandleFunc("DELETE /users/{id}", a.deleteUser)

	mux.HandleFunc("GET /organizations", a.listOrganizations)
	mux.HandleFunc("GET /organizations/{id}", a.getOrganization)
	mux.HandleFunc("GET /organizations/{id}/stats", a.organizationStats)

	mux.HandleFunc("POST /media", a.createMedia)
	mux.HandleFunc("GET /media/{id}", a.getMedia)
	mux.HandleFunc("GET /media/{id}/file", a.getMediaFile)

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Route not found", nil)
	})
	return mux
}

var healthBody = []byte(`{"ok":true}`)

func health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthBody)
}
