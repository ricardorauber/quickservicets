//! The error body of every failure: `{"error":{"code","message","details"?}}`.

use std::borrow::Cow;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Detail {
    pub field: Cow<'static, str>,
    pub message: Cow<'static, str>,
}

pub fn detail(field: impl Into<Cow<'static, str>>, message: impl Into<Cow<'static, str>>) -> Detail {
    Detail { field: field.into(), message: message.into() }
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: Cow<'static, str>,
    details: Option<Vec<Detail>>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<Cow<'static, str>>) -> Self {
        Self { status, message: message.into(), details: None }
    }

    pub fn with_details(status: StatusCode, message: impl Into<Cow<'static, str>>, details: Vec<Detail>) -> Self {
        Self { status, message: message.into(), details: Some(details) }
    }

    pub fn not_found(message: &'static str) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    pub fn invalid_query(details: Vec<Detail>) -> Self {
        Self::with_details(StatusCode::BAD_REQUEST, "Invalid query", details)
    }

    pub fn invalid_body(details: Vec<Detail>) -> Self {
        Self::with_details(StatusCode::BAD_REQUEST, "Invalid body", details)
    }

    pub fn email_taken() -> Self {
        Self::with_details(StatusCode::CONFLICT, "Value already exists", vec![detail("email", "Value already exists")])
    }

    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
    }
}

fn code(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 => "VALIDATION_ERROR",
        404 => "NOT_FOUND",
        409 => "CONFLICT",
        413 => "PAYLOAD_TOO_LARGE",
        415 => "UNSUPPORTED_MEDIA_TYPE",
        _ => "INTERNAL_ERROR",
    }
}

#[derive(Serialize)]
struct Body<'a> {
    error: Inner<'a>,
}

#[derive(Serialize)]
struct Inner<'a> {
    code: &'static str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<&'a [Detail]>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Body { error: Inner { code: code(self.status), message: &self.message, details: self.details.as_deref() } };
        crate::model::json_response(self.status, &body)
    }
}

impl From<tokio_postgres::Error> for ApiError {
    fn from(error: tokio_postgres::Error) -> Self {
        eprintln!("database error: {error}");
        Self::internal()
    }
}

impl From<deadpool_postgres::PoolError> for ApiError {
    fn from(error: deadpool_postgres::PoolError) -> Self {
        eprintln!("connection pool error: {error}");
        Self::internal()
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        eprintln!("file error: {error}");
        Self::internal()
    }
}
