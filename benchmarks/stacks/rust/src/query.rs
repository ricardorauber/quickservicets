//! Query string handling for the list and read routes: `limit`, `offset`, `sort`, `where[field][op]`, `fields`
//! and `populate`, validated as CONTRACT.md describes and turned into SQL clauses with bound parameters.

use std::{borrow::Cow, collections::HashSet, fmt::Write};

use tokio_postgres::types::ToSql;

use crate::error::{ApiError, Detail, detail};

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 100;
const MAX_LIST_VALUES: usize = 100;

/// Every operator name the API knows. Each field type accepts a subset; the others are "not allowed".
const OPERATORS: &[&str] = &[
    "eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "isNull", "containsAny",
    "containsAll", "size", "isEmpty",
];

#[derive(Clone, Copy)]
pub enum FilterType {
    Text,
    Number,
    Enum(&'static [&'static str]),
}

impl FilterType {
    fn allows(self, op: &str) -> bool {
        match self {
            FilterType::Text | FilterType::Enum(_) => matches!(op, "eq" | "ne" | "in" | "nin"),
            FilterType::Number => matches!(op, "eq" | "ne" | "in" | "nin" | "gt" | "gte" | "lt" | "lte"),
        }
    }
}

pub struct Field {
    pub name: &'static str,
    /// Column name, or `None` for fields that are not columns (`members`).
    pub column: Option<&'static str>,
    pub mask: u16,
    pub filter: Option<FilterType>,
}

pub struct Collection {
    pub fields: &'static [Field],
    /// The reference arrays `populate` accepts.
    pub populatable: &'static [&'static str],
}

impl Collection {
    fn field(&self, name: &str) -> Option<&'static Field> {
        self.fields.iter().find(|field| field.name == name)
    }
}

/// The decoded `(name, value)` pairs of a query string, in order.
pub type Pairs<'a> = Vec<(Cow<'a, str>, Cow<'a, str>)>;

pub fn pairs(raw: Option<&str>) -> Pairs<'_> {
    form_urlencoded::parse(raw.unwrap_or("").as_bytes()).collect()
}

fn first<'a>(pairs: &'a Pairs<'_>, name: &str) -> Option<&'a str> {
    pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_ref())
}

fn split_list(raw: &str) -> Vec<&str> {
    raw.split(',').map(str::trim).filter(|item| !item.is_empty()).collect()
}

/// Validates `populate`; returns whether `members` is populated.
pub fn populate(collection: &Collection, pairs: &Pairs<'_>) -> Result<bool, ApiError> {
    let Some(raw) = first(pairs, "populate") else { return Ok(false) };
    let mut populated = false;
    let mut details: Vec<Detail> = Vec::new();
    for path in split_list(raw) {
        if collection.populatable.contains(&path) {
            populated = true;
        } else {
            details.push(detail("populate", format!("Cannot populate: {path}")));
        }
    }
    if let Some(first) = details.first() {
        let message = first.message.clone();
        return Err(ApiError::with_details(axum::http::StatusCode::BAD_REQUEST, message, details));
    }
    Ok(populated)
}

/// Validates `fields`; returns the selected fields as a mask (`all` when the parameter is absent).
pub fn fields(collection: &Collection, pairs: &Pairs<'_>, all: u16) -> Result<u16, ApiError> {
    let Some(raw) = first(pairs, "fields") else { return Ok(all) };
    let entries = split_list(raw);
    if entries.is_empty() {
        return Err(ApiError::invalid_query(vec![detail("fields", "Must list at least one field")]));
    }
    let mut mask = 0;
    let mut details = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        if !seen.insert(entry) {
            continue;
        }
        match collection.field(entry) {
            Some(field) => mask |= field.mask,
            None => details.push(detail("fields", format!("Unknown field: {entry}"))),
        }
    }
    if details.is_empty() { Ok(mask) } else { Err(ApiError::invalid_query(details)) }
}

/// A validated list query: the `WHERE` and `ORDER BY` clauses, their parameters, and the page.
pub struct ListQuery {
    /// Empty, or ` WHERE ...` with placeholders `$1..$n`.
    pub where_sql: String,
    /// `ORDER BY` items, such as `created_at DESC, id DESC`.
    pub order_sql: String,
    pub params: Vec<Box<dyn ToSql + Sync + Send>>,
    pub limit: i64,
    pub offset: i64,
}

impl ListQuery {
    /// The filter parameters, for the count query.
    pub fn filter_params(&self) -> Vec<&(dyn ToSql + Sync)> {
        self.params.iter().map(|param| param.as_ref() as &(dyn ToSql + Sync)).collect()
    }

    /// The filter parameters followed by `limit` and `offset`, for the page query.
    pub fn page_params(&self) -> Vec<&(dyn ToSql + Sync)> {
        let mut params = self.filter_params();
        params.push(&self.limit);
        params.push(&self.offset);
        params
    }

    /// ` ORDER BY ... LIMIT $n OFFSET $m`.
    pub fn page_sql(&self) -> String {
        let n = self.params.len();
        format!(" ORDER BY {} LIMIT ${} OFFSET ${}", self.order_sql, n + 1, n + 2)
    }
}

/// Parses every list parameter, reporting all problems together under "Invalid query".
pub fn list(collection: &Collection, pairs: &Pairs<'_>) -> Result<ListQuery, ApiError> {
    let mut details: Vec<Detail> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let (mut sort, mut limit, mut offset) = (None, None, None);
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();

    for (key, raw) in pairs {
        let key = key.as_ref();
        if !seen.insert(key) {
            details.push(detail(key.to_owned(), "Parameter is repeated"));
            continue;
        }
        if let Some((name, op, comparison)) = parse_where_key(key) {
            if let Some(condition) = condition(collection, key, name, op, comparison, raw, &mut params, &mut details) {
                conditions.push(condition);
            }
            continue;
        }
        match key {
            "sort" => sort = Some(raw.as_ref()),
            "limit" => limit = Some(raw.as_ref()),
            "offset" => offset = Some(raw.as_ref()),
            "fields" | "populate" => {}
            _ => details.push(detail(key.to_owned(), "Unknown parameter")),
        }
    }

    let order_sql = order(collection, sort, &mut details);
    let limit = integer(limit, 1, MAX_LIMIT, DEFAULT_LIMIT).unwrap_or_else(|| {
        details.push(detail("limit", format!("Must be an integer from 1 to {MAX_LIMIT}")));
        DEFAULT_LIMIT
    });
    let offset = integer(offset, 0, i64::MAX, 0).unwrap_or_else(|| {
        details.push(detail("offset", "Must be an integer of at least 0"));
        0
    });

    if !details.is_empty() {
        return Err(ApiError::invalid_query(details));
    }
    let where_sql = if conditions.is_empty() { String::new() } else { format!(" WHERE {}", conditions.join(" AND ")) };
    Ok(ListQuery { where_sql, order_sql, params, limit, offset })
}

/// `where[field][op]` or `where[field][op][comparison]`.
fn parse_where_key(key: &str) -> Option<(&str, &str, Option<&str>)> {
    let rest = key.strip_prefix("where[")?;
    let (name, rest) = rest.split_once("][")?;
    let (op, rest) = rest.split_once(']')?;
    let comparison = match rest {
        "" => None,
        _ => Some(rest.strip_prefix('[')?.strip_suffix(']')?),
    };
    let valid = |segment: &str| !segment.is_empty() && !segment.contains(['[', ']']);
    (valid(name) && valid(op) && comparison.is_none_or(valid)).then_some((name, op, comparison))
}

#[allow(clippy::too_many_arguments)]
fn condition(
    collection: &Collection,
    key: &str,
    name: &str,
    op: &str,
    comparison: Option<&str>,
    raw: &str,
    params: &mut Vec<Box<dyn ToSql + Sync + Send>>,
    details: &mut Vec<Detail>,
) -> Option<String> {
    let field = collection.field(name).filter(|field| field.filter.is_some());
    let Some(field) = field else {
        details.push(detail(key.to_owned(), format!("Field \"{name}\" cannot be filtered")));
        return None;
    };
    let (Some(column), Some(filter)) = (field.column, field.filter) else { return None };
    if !OPERATORS.contains(&op) {
        details.push(detail(key.to_owned(), format!("Unknown operator \"{op}\"")));
        return None;
    }
    if !filter.allows(op) {
        details.push(detail(key.to_owned(), format!("Operator \"{op}\" is not allowed for this field")));
        return None;
    }
    if comparison.is_some() {
        details.push(detail(key.to_owned(), format!("Unknown operator \"{op}\"")));
        return None;
    }

    let param: Box<dyn ToSql + Sync + Send> = if op == "in" || op == "nin" {
        let items = split_list(raw);
        if items.is_empty() {
            details.push(detail(key.to_owned(), "Must list at least one value"));
            return None;
        }
        if items.len() > MAX_LIST_VALUES {
            details.push(detail(key.to_owned(), format!("Must list at most {MAX_LIST_VALUES} values")));
            return None;
        }
        match filter {
            FilterType::Number => Box::new(items.iter().map(|item| number(item)).collect::<Option<Vec<f64>>>().or_else(|| {
                details.push(detail(key.to_owned(), "Must be a number"));
                None
            })?),
            FilterType::Enum(values) => {
                if items.iter().any(|item| !values.contains(item)) {
                    details.push(detail(key.to_owned(), format!("Must be one of: {}", values.join(", "))));
                    return None;
                }
                Box::new(items.iter().map(|item| (*item).to_owned()).collect::<Vec<String>>())
            }
            FilterType::Text => Box::new(items.iter().map(|item| (*item).to_owned()).collect::<Vec<String>>()),
        }
    } else {
        match filter {
            FilterType::Number => match number(raw) {
                Some(value) => Box::new(value),
                None => {
                    details.push(detail(key.to_owned(), "Must be a number"));
                    return None;
                }
            },
            FilterType::Enum(values) => {
                if !values.contains(&raw) {
                    details.push(detail(key.to_owned(), format!("Must be one of: {}", values.join(", "))));
                    return None;
                }
                Box::new(raw.to_owned())
            }
            FilterType::Text => Box::new(raw.to_owned()),
        }
    };
    params.push(param);
    let n = params.len();
    Some(match op {
        "eq" => format!("{column} = ${n}"),
        "ne" => format!("{column} <> ${n}"),
        "gt" => format!("{column} > ${n}"),
        "gte" => format!("{column} >= ${n}"),
        "lt" => format!("{column} < ${n}"),
        "lte" => format!("{column} <= ${n}"),
        "in" => format!("{column} = ANY(${n})"),
        _ => format!("{column} <> ALL(${n})"), // nin
    })
}

/// A finite number, as JavaScript's `Number()` reads query values (blank is not a number).
fn number(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// An integer within `min..=max` written as `-?\d+`; `fallback` when the parameter is absent.
fn integer(raw: Option<&str>, min: i64, max: i64, fallback: i64) -> Option<i64> {
    let Some(raw) = raw else { return Some(fallback) };
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse::<i64>().ok().filter(|value| (min..=max).contains(value))
}

/// The `ORDER BY` items for `sort`, with `id DESC` appended unless `id` is listed.
fn order(collection: &Collection, sort: Option<&str>, details: &mut Vec<Detail>) -> String {
    let mut sql = String::new();
    let mut listed: Vec<&str> = Vec::new();
    let parts: Vec<&str> = match sort {
        None => vec!["-createdAt"],
        Some(raw) => raw.split(',').map(str::trim).collect(),
    };
    for part in parts {
        let (name, descending) = match part.strip_prefix('-') {
            Some(name) => (name, true),
            None => (part, false),
        };
        let Some(column) = collection.field(name).and_then(|field| field.column) else {
            details.push(detail("sort", format!("Field \"{name}\" cannot be sorted")));
            continue;
        };
        if listed.contains(&name) {
            details.push(detail("sort", format!("Field \"{name}\" is listed more than once")));
            continue;
        }
        listed.push(name);
        if !sql.is_empty() {
            sql.push_str(", ");
        }
        let _ = write!(sql, "{column} {}", if descending { "DESC" } else { "ASC" });
    }
    if !listed.contains(&"id") {
        if !sql.is_empty() {
            sql.push_str(", ");
        }
        sql.push_str("id DESC");
    }
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_keys() {
        assert_eq!(parse_where_key("where[age][gte]"), Some(("age", "gte", None)));
        assert_eq!(parse_where_key("where[tags][size][eq]"), Some(("tags", "size", Some("eq"))));
        assert_eq!(parse_where_key("where[age]"), None);
        assert_eq!(parse_where_key("where"), None);
        assert_eq!(parse_where_key("where[age][gte]x"), None);
    }

    #[test]
    fn integers() {
        assert_eq!(integer(Some("20"), 1, 100, 20), Some(20));
        assert_eq!(integer(Some("2.5"), 1, 100, 20), None);
        assert_eq!(integer(Some("abc"), 1, 100, 20), None);
        assert_eq!(integer(Some("-1"), 0, i64::MAX, 0), None);
        assert_eq!(integer(None, 1, 100, 20), Some(20));
    }
}
