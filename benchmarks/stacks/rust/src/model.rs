//! Records, their JSON shape (with optional field selection) and the shared helpers for ids, timestamps and
//! JSON responses.

use axum::{
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{
    Serialize, Serializer,
    ser::{SerializeMap, SerializeSeq},
};
use tokio_postgres::Row;

/// Serializes `value` as the body of a JSON response.
pub fn json_response<T: Serialize + ?Sized>(status: StatusCode, value: &T) -> Response {
    let mut body = Vec::with_capacity(512);
    match serde_json::to_writer(&mut body, value) {
        Ok(()) => (status, [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], body).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// A new UUID version 7, lowercase canonical form.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().hyphenated().to_string()
}

/// The current time truncated to milliseconds, so what is stored and what is returned are equal.
pub fn now_ms() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).expect("clock out of range")
}

/// `2026-10-19T16:04:45.600Z`, like JavaScript's `Date.prototype.toISOString`.
fn timestamp(value: &DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Writes a `double precision` value as a JSON integer when it is integral.
fn number<S: SerializeMap>(map: &mut S, key: &'static str, value: f64) -> Result<(), S::Error> {
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        map.serialize_entry(key, &(value as i64))
    } else {
        map.serialize_entry(key, &value)
    }
}

/// Records whose top-level fields can be selected with `fields`.
pub trait Selectable {
    /// Every field of the record, as a bit mask.
    const ALL: u16;
    fn write<S: SerializeMap>(&self, mask: u16, map: &mut S) -> Result<(), S::Error>;
}

/// A record with only the fields in `mask`.
pub struct Masked<'a, T>(pub &'a T, pub u16);

impl<T: Selectable> Serialize for Masked<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        self.0.write(self.1, &mut map)?;
        map.end()
    }
}

/// A list of records with only the fields in `mask`.
pub struct MaskedList<'a, T>(pub &'a [T], pub u16);

impl<T: Selectable> Serialize for MaskedList<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for item in self.0 {
            seq.serialize_element(&Masked(item, self.1))?;
        }
        seq.end()
    }
}

/// A list page: `{"data":[...],"total":n,"limit":n,"offset":n}`.
#[derive(Serialize)]
#[serde(bound = "")]
pub struct Page<'a, T: Selectable> {
    pub data: MaskedList<'a, T>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

// ---------------------------------------------------------------------------------------------------- users

pub const USER_COLUMNS: &str = "id, created_at, updated_at, email, name, role, age";

pub struct User {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub email: String,
    pub name: String,
    pub role: String,
    pub age: Option<f64>,
}

impl User {
    /// Reads the `USER_COLUMNS`, starting at column `offset`.
    pub fn from_row(row: &Row, offset: usize) -> Self {
        Self {
            id: row.get(offset),
            created_at: row.get(offset + 1),
            updated_at: row.get(offset + 2),
            email: row.get(offset + 3),
            name: row.get(offset + 4),
            role: row.get(offset + 5),
            age: row.get(offset + 6),
        }
    }
}

pub mod user_fields {
    pub const ID: u16 = 1;
    pub const CREATED_AT: u16 = 1 << 1;
    pub const UPDATED_AT: u16 = 1 << 2;
    pub const EMAIL: u16 = 1 << 3;
    pub const NAME: u16 = 1 << 4;
    pub const ROLE: u16 = 1 << 5;
    pub const AGE: u16 = 1 << 6;
}

impl Selectable for User {
    const ALL: u16 = (1 << 7) - 1;

    fn write<S: SerializeMap>(&self, mask: u16, map: &mut S) -> Result<(), S::Error> {
        use user_fields::*;
        if mask & ID != 0 {
            map.serialize_entry("id", &self.id)?;
        }
        if mask & CREATED_AT != 0 {
            map.serialize_entry("createdAt", &timestamp(&self.created_at))?;
        }
        if mask & UPDATED_AT != 0 {
            map.serialize_entry("updatedAt", &timestamp(&self.updated_at))?;
        }
        if mask & EMAIL != 0 {
            map.serialize_entry("email", &self.email)?;
        }
        if mask & NAME != 0 {
            map.serialize_entry("name", &self.name)?;
        }
        if mask & ROLE != 0 {
            map.serialize_entry("role", &self.role)?;
        }
        if mask & AGE != 0 {
            match self.age {
                Some(age) => number(map, "age", age)?,
                None => map.serialize_entry("age", &())?,
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------- organizations

pub const ORGANIZATION_COLUMNS: &str = "id, created_at, updated_at, name, slug";

pub enum Members {
    /// Not loaded: `members` is not selected.
    Skipped,
    Ids(Vec<String>),
    Populated(Vec<User>),
}

pub struct Organization {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub slug: String,
    pub members: Members,
}

impl Organization {
    /// Reads the `ORGANIZATION_COLUMNS`, then the member ids from column 5 when `with_member_ids` is set.
    pub fn from_row(row: &Row, with_member_ids: bool) -> Self {
        Self {
            id: row.get(0),
            created_at: row.get(1),
            updated_at: row.get(2),
            name: row.get(3),
            slug: row.get(4),
            members: if with_member_ids { Members::Ids(row.get(5)) } else { Members::Skipped },
        }
    }
}

pub mod organization_fields {
    pub const ID: u16 = 1;
    pub const CREATED_AT: u16 = 1 << 1;
    pub const UPDATED_AT: u16 = 1 << 2;
    pub const NAME: u16 = 1 << 3;
    pub const SLUG: u16 = 1 << 4;
    pub const MEMBERS: u16 = 1 << 5;
}

impl Selectable for Organization {
    const ALL: u16 = (1 << 6) - 1;

    fn write<S: SerializeMap>(&self, mask: u16, map: &mut S) -> Result<(), S::Error> {
        use organization_fields::*;
        if mask & ID != 0 {
            map.serialize_entry("id", &self.id)?;
        }
        if mask & CREATED_AT != 0 {
            map.serialize_entry("createdAt", &timestamp(&self.created_at))?;
        }
        if mask & UPDATED_AT != 0 {
            map.serialize_entry("updatedAt", &timestamp(&self.updated_at))?;
        }
        if mask & NAME != 0 {
            map.serialize_entry("name", &self.name)?;
        }
        if mask & SLUG != 0 {
            map.serialize_entry("slug", &self.slug)?;
        }
        if mask & MEMBERS != 0 {
            match &self.members {
                Members::Ids(ids) => map.serialize_entry("members", ids)?,
                Members::Populated(users) => map.serialize_entry("members", &MaskedList(users, User::ALL))?,
                Members::Skipped => map.serialize_entry("members", &[] as &[String])?,
            }
        }
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------------------ media

pub const MEDIA_COLUMNS: &str = "id, created_at, updated_at, filename, mime_type, size, storage";

pub struct Media {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub filename: String,
    pub mime_type: String,
    pub size: f64,
    pub storage: String,
}

impl Media {
    pub fn from_row(row: &Row) -> Self {
        Self {
            id: row.get(0),
            created_at: row.get(1),
            updated_at: row.get(2),
            filename: row.get(3),
            mime_type: row.get(4),
            size: row.get(5),
            storage: row.get(6),
        }
    }
}

impl Serialize for Media {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(8))?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("createdAt", &timestamp(&self.created_at))?;
        map.serialize_entry("updatedAt", &timestamp(&self.updated_at))?;
        map.serialize_entry("filename", &self.filename)?;
        map.serialize_entry("mimeType", &self.mime_type)?;
        number(&mut map, "size", self.size)?;
        map.serialize_entry("storage", &self.storage)?;
        map.serialize_entry("url", &format!("/media/{}/file", self.id))?;
        map.end()
    }
}
