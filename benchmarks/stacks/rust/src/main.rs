//! Hand-written benchmark service: axum 0.8 on the multi-threaded tokio runtime, tokio-postgres with a
//! deadpool connection pool. See benchmarks/CONTRACT.md for the API.

mod error;
mod media;
mod model;
mod orgs;
mod query;
mod users;

use std::{env, net::SocketAddr, path::PathBuf, str::FromStr, sync::Arc};

use axum::{
    Router,
    response::Response,
    routing::{get, post},
    serve::ListenerExt,
};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use tokio_postgres::NoTls;

use crate::error::ApiError;

pub struct AppState {
    pub pool: Pool,
    pub upload_dir: PathBuf,
}

pub type SharedState = Arc<AppState>;

#[tokio::main]
async fn main() {
    let state = Arc::new(AppState { pool: build_pool(), upload_dir: PathBuf::from(env_or("UPLOAD_DIR", "uploads")) });

    let app = Router::new()
        .route("/health", get(health))
        .route("/users", get(users::list).post(users::create))
        .route("/users/{id}", get(users::read).patch(users::update).delete(users::remove))
        .route("/organizations", get(orgs::list))
        .route("/organizations/{id}", get(orgs::read))
        .route("/organizations/{id}/stats", get(orgs::stats))
        .route("/media", post(media::upload))
        .route("/media/{id}", get(media::read))
        .route("/media/{id}/file", get(media::file))
        .fallback(route_not_found)
        .with_state(state);

    let port: u16 = env_or("PORT", "8080").parse().expect("PORT must be a port number");
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
        .expect("cannot bind the HTTP port")
        .tap_io(|tcp| {
            let _ = tcp.set_nodelay(true);
        });
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await.expect("server error");
}

fn env_or(name: &str, fallback: &str) -> String {
    env::var(name).ok().filter(|value| !value.is_empty()).unwrap_or_else(|| fallback.to_owned())
}

/// The pool holds `DB_POOL_SIZE` connections (10 in the run), opened lazily and shared by every worker thread.
fn build_pool() -> Pool {
    let config = match env::var("DATABASE_URL") {
        Ok(url) if !url.is_empty() => tokio_postgres::Config::from_str(&url).expect("invalid DATABASE_URL"),
        _ => {
            let mut config = tokio_postgres::Config::new();
            config
                .host(env_or("DB_HOST", "localhost"))
                .port(env_or("DB_PORT", "55432").parse().expect("invalid DB_PORT"))
                .user(env_or("DB_USER", "bench"))
                .password(env_or("DB_PASSWORD", "bench"))
                .dbname(env_or("DB_NAME", "bench"));
            config
        }
    };
    let size: usize = env_or("DB_POOL_SIZE", "10").parse().expect("invalid DB_POOL_SIZE");
    let manager = Manager::from_config(config, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
    Pool::builder(manager).max_size(size).build().expect("cannot build the connection pool")
}

async fn health() -> Response {
    model::json_response(axum::http::StatusCode::OK, &serde_json::json!({ "ok": true }))
}

async fn route_not_found() -> ApiError {
    ApiError::not_found("Route not found")
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("cannot install the SIGTERM handler");
        signal.recv().await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
