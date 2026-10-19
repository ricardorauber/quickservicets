//! `/users` and `/users/{id}`.

use axum::{
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value};
use tokio_postgres::{error::SqlState, types::ToSql};

use crate::{
    SharedState,
    error::{ApiError, Detail, detail},
    model::{Masked, MaskedList, Page, Selectable, USER_COLUMNS, User, json_response, new_id, now_ms, user_fields},
    query::{self, Collection, Field, FilterType},
};

pub const ROLES: &[&str] = &["member", "admin"];

pub static USERS: Collection = Collection {
    fields: &[
        Field { name: "id", column: Some("id"), mask: user_fields::ID, filter: Some(FilterType::Text) },
        Field { name: "createdAt", column: Some("created_at"), mask: user_fields::CREATED_AT, filter: None },
        Field { name: "updatedAt", column: Some("updated_at"), mask: user_fields::UPDATED_AT, filter: None },
        Field { name: "email", column: Some("email"), mask: user_fields::EMAIL, filter: Some(FilterType::Text) },
        Field { name: "name", column: Some("name"), mask: user_fields::NAME, filter: Some(FilterType::Text) },
        Field { name: "role", column: Some("role"), mask: user_fields::ROLE, filter: Some(FilterType::Enum(ROLES)) },
        Field { name: "age", column: Some("age"), mask: user_fields::AGE, filter: Some(FilterType::Number) },
    ],
    populatable: &[],
};

pub async fn list(State(state): State<SharedState>, RawQuery(raw): RawQuery) -> Result<Response, ApiError> {
    let pairs = query::pairs(raw.as_deref());
    query::populate(&USERS, &pairs)?;
    let mask = query::fields(&USERS, &pairs, User::ALL)?;
    let list = query::list(&USERS, &pairs)?;

    let page_sql = format!("SELECT {USER_COLUMNS} FROM users{}{}", list.where_sql, list.page_sql());
    let count_sql = format!("SELECT count(*) FROM users{}", list.where_sql);
    let client = state.pool.get().await?;
    let (page_statement, count_statement) = tokio::try_join!(client.prepare_cached(&page_sql), client.prepare_cached(&count_sql))?;
    // Both queries go out on the same connection without waiting for each other (tokio-postgres pipelining).
    let (page_params, count_params) = (list.page_params(), list.filter_params());
    let (rows, count) = tokio::try_join!(client.query(&page_statement, &page_params), client.query_one(&count_statement, &count_params))?;
    drop(client);

    let users: Vec<User> = rows.iter().map(|row| User::from_row(row, 0)).collect();
    let page = Page { data: MaskedList(&users, mask), total: count.get(0), limit: list.limit, offset: list.offset };
    Ok(json_response(StatusCode::OK, &page))
}

pub async fn read(State(state): State<SharedState>, Path(id): Path<String>, RawQuery(raw): RawQuery) -> Result<Response, ApiError> {
    let pairs = query::pairs(raw.as_deref());
    query::populate(&USERS, &pairs)?;
    let mask = query::fields(&USERS, &pairs, User::ALL)?;

    let client = state.pool.get().await?;
    let statement = client.prepare_cached("SELECT id, created_at, updated_at, email, name, role, age FROM users WHERE id = $1").await?;
    let row = client.query_opt(&statement, &[&id]).await?;
    drop(client);
    let user = row.map(|row| User::from_row(&row, 0)).ok_or_else(|| ApiError::not_found("User not found"))?;
    Ok(json_response(StatusCode::OK, &Masked(&user, mask)))
}

pub async fn create(State(state): State<SharedState>, body: Bytes) -> Result<Response, ApiError> {
    let input = validate(&body, true)?;
    let now = now_ms();
    let user = User {
        id: new_id(),
        created_at: now,
        updated_at: now,
        email: input.email.expect("validated"),
        name: input.name.expect("validated"),
        role: input.role.unwrap_or_else(|| "member".to_owned()),
        age: input.age.flatten(),
    };

    let client = state.pool.get().await?;
    let statement = client
        .prepare_cached("INSERT INTO users (id, created_at, updated_at, email, name, role, age) VALUES ($1, $2, $2, $3, $4, $5, $6)")
        .await?;
    client
        .execute(&statement, &[&user.id, &user.created_at, &user.email, &user.name, &user.role, &user.age])
        .await
        .map_err(conflict_or_internal)?;
    drop(client);
    Ok(json_response(StatusCode::CREATED, &Masked(&user, User::ALL)))
}

pub async fn update(State(state): State<SharedState>, Path(id): Path<String>, body: Bytes) -> Result<Response, ApiError> {
    let input = validate(&body, false)?;
    let now = now_ms();

    let mut params: Vec<&(dyn ToSql + Sync)> = vec![&id, &now];
    let mut sql = String::from("UPDATE users SET updated_at = $2");
    if let Some(email) = &input.email {
        params.push(email);
        sql.push_str(&format!(", email = ${}", params.len()));
    }
    if let Some(name) = &input.name {
        params.push(name);
        sql.push_str(&format!(", name = ${}", params.len()));
    }
    if let Some(role) = &input.role {
        params.push(role);
        sql.push_str(&format!(", role = ${}", params.len()));
    }
    if let Some(age) = &input.age {
        params.push(age);
        sql.push_str(&format!(", age = ${}", params.len()));
    }
    sql.push_str(&format!(" WHERE id = $1 RETURNING {USER_COLUMNS}"));

    let client = state.pool.get().await?;
    let statement = client.prepare_cached(&sql).await?;
    let row = client.query_opt(&statement, &params).await.map_err(conflict_or_internal)?;
    drop(client);
    let user = row.map(|row| User::from_row(&row, 0)).ok_or_else(|| ApiError::not_found("User not found"))?;
    Ok(json_response(StatusCode::OK, &Masked(&user, User::ALL)))
}

/// Deletes the user and, in the same statement, moves `updatedAt` of every organization that listed it; the
/// junction rows go through the foreign key's `ON DELETE CASCADE`.
pub async fn remove(State(state): State<SharedState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let now = now_ms();
    let client = state.pool.get().await?;
    let statement = client
        .prepare_cached(
            "WITH deleted AS (DELETE FROM users WHERE id = $1 RETURNING id), \
             touched AS (UPDATE organizations SET updated_at = $2 \
               WHERE id IN (SELECT owner_id FROM organizations__members WHERE target_id = $1) \
               AND EXISTS (SELECT 1 FROM deleted)) \
             SELECT count(*) FROM deleted",
        )
        .await?;
    let deleted: i64 = client.query_one(&statement, &[&id, &now]).await?.get(0);
    drop(client);
    if deleted == 0 {
        return Err(ApiError::not_found("User not found"));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn conflict_or_internal(error: tokio_postgres::Error) -> ApiError {
    match error.as_db_error() {
        Some(db) if *db.code() == SqlState::UNIQUE_VIOLATION && db.constraint() == Some("users_email_uq") => ApiError::email_taken(),
        _ => error.into(),
    }
}

// ------------------------------------------------------------------------------------------------- validation

/// The fields of a valid body. `age` is `Some(None)` when the body sets it to `null`.
struct UserInput {
    email: Option<String>,
    name: Option<String>,
    role: Option<String>,
    age: Option<Option<f64>>,
}

fn invalid_json() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "Invalid JSON body")
}

fn validate(body: &[u8], create: bool) -> Result<UserInput, ApiError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_json())?;
    let Value::Object(mut map) = value else {
        return Err(ApiError::invalid_body(vec![detail("", "Body must be a JSON object")]));
    };
    let mut details: Vec<Detail> = Vec::new();
    let mut input = UserInput { email: None, name: None, role: None, age: None };

    match string_field(&mut map, "email", create, &mut details) {
        Some(email) if !is_email(&email) => details.push(detail("email", "Must be a valid email")),
        email => input.email = email,
    }
    match string_field(&mut map, "name", create, &mut details) {
        Some(name) => match name.encode_utf16().count() {
            0 => details.push(detail("name", "Must be at least 1 characters")),
            101.. => details.push(detail("name", "Must be at most 100 characters")),
            _ => input.name = Some(name),
        },
        None => {}
    }
    match map.remove("role") {
        None => {}
        Some(Value::Null) => details.push(detail("role", "Cannot be null")),
        Some(Value::String(role)) if ROLES.contains(&role.as_str()) => input.role = Some(role),
        Some(_) => details.push(detail("role", "Must be one of: member, admin")),
    }
    match map.remove("age") {
        None => {}
        Some(Value::Null) => input.age = Some(None),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(age) if age.fract() != 0.0 => details.push(detail("age", "Must be an integer")),
            Some(age) if age < 0.0 => details.push(detail("age", "Must be at least 0")),
            Some(age) if age > 150.0 => details.push(detail("age", "Must be at most 150")),
            Some(age) => input.age = Some(Some(age)),
            None => details.push(detail("age", "Must be a number")),
        },
        Some(_) => details.push(detail("age", "Must be a number")),
    }
    for key in map.keys() {
        let message = if matches!(key.as_str(), "id" | "createdAt" | "updatedAt") { "Field is read-only" } else { "Unknown field" };
        details.push(detail(key.clone(), message));
    }

    if details.is_empty() { Ok(input) } else { Err(ApiError::invalid_body(details)) }
}

/// A string field: "Is required" when missing on create, "Cannot be null", "Must be a string".
fn string_field(map: &mut Map<String, Value>, name: &'static str, required: bool, details: &mut Vec<Detail>) -> Option<String> {
    match map.remove(name) {
        None => {
            if required {
                details.push(detail(name, "Is required"));
            }
            None
        }
        Some(Value::Null) => {
            details.push(detail(name, "Cannot be null"));
            None
        }
        Some(Value::String(value)) => Some(value),
        Some(_) => {
            details.push(detail(name, "Must be a string"));
            None
        }
    }
}

/// JavaScript's `\s`: white space and line terminators.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}'
            | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `^[^\s@]+@[^\s@]+\.[^\s@]+$`: exactly one `@`, no white space, and a dot inside the domain.
fn is_email(value: &str) -> bool {
    if value.chars().any(is_js_space) {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else { return false };
    if local.is_empty() || domain.contains('@') {
        return false;
    }
    let bytes = domain.as_bytes();
    bytes.iter().enumerate().any(|(index, &byte)| byte == b'.' && index > 0 && index + 1 < bytes.len())
}

#[cfg(test)]
mod tests {
    use super::is_email;

    #[test]
    fn emails() {
        assert!(is_email("user00000@example.com"));
        assert!(is_email("a@b.c"));
        assert!(is_email("a@b..c"));
        assert!(!is_email("not-an-email"));
        assert!(!is_email("a b@example.com"));
        assert!(!is_email("a@b@c.d"));
        assert!(!is_email("a@.c"));
        assert!(!is_email("a@b."));
        assert!(!is_email("@b.c"));
    }
}
