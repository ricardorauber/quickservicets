//! `/organizations`, `/organizations/{id}` and `/organizations/{orgId}/stats`.

use std::collections::HashMap;

use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    response::Response,
};
use serde::Serialize;
use tokio_postgres::types::ToSql;

use crate::{
    SharedState,
    error::ApiError,
    model::{
        Masked, MaskedList, Members, ORGANIZATION_COLUMNS, Organization, Page, Selectable, User, json_response,
        organization_fields,
    },
    query::{self, Collection, Field, FilterType},
};

pub static ORGANIZATIONS: Collection = Collection {
    fields: &[
        Field { name: "id", column: Some("id"), mask: organization_fields::ID, filter: Some(FilterType::Text) },
        Field { name: "createdAt", column: Some("created_at"), mask: organization_fields::CREATED_AT, filter: None },
        Field { name: "updatedAt", column: Some("updated_at"), mask: organization_fields::UPDATED_AT, filter: None },
        Field { name: "name", column: Some("name"), mask: organization_fields::NAME, filter: Some(FilterType::Text) },
        Field { name: "slug", column: Some("slug"), mask: organization_fields::SLUG, filter: Some(FilterType::Text) },
        Field { name: "members", column: None, mask: organization_fields::MEMBERS, filter: None },
    ],
    populatable: &["members"],
};

/// The member ids of each organization, in position order, as a column of the organization query.
const MEMBER_IDS: &str =
    "ARRAY(SELECT m.target_id FROM organizations__members m WHERE m.owner_id = organizations.id ORDER BY m.position)";

/// The member records of a set of organizations (`$1` is a `text[]` of organization ids), in position order.
const POPULATED_MEMBERS: &str = "SELECT m.owner_id, u.id, u.created_at, u.updated_at, u.email, u.name, u.role, u.age \
     FROM organizations__members m JOIN users u ON u.id = m.target_id \
     WHERE m.owner_id = ANY($1) ORDER BY m.owner_id, m.position";

/// What to load for `members`: nothing (not selected), the ids, or the user records.
#[derive(Clone, Copy, PartialEq)]
enum MemberLoad {
    Skip,
    Ids,
    Populate,
}

fn member_load(populate: bool, mask: u16) -> MemberLoad {
    match (mask & organization_fields::MEMBERS != 0, populate) {
        (false, _) => MemberLoad::Skip,
        (true, false) => MemberLoad::Ids,
        (true, true) => MemberLoad::Populate,
    }
}

fn select_sql(load: MemberLoad) -> String {
    match load {
        MemberLoad::Ids => format!("SELECT {ORGANIZATION_COLUMNS}, {MEMBER_IDS} FROM organizations"),
        _ => format!("SELECT {ORGANIZATION_COLUMNS} FROM organizations"),
    }
}

pub async fn list(State(state): State<SharedState>, RawQuery(raw): RawQuery) -> Result<Response, ApiError> {
    let pairs = query::pairs(raw.as_deref());
    let populate = query::populate(&ORGANIZATIONS, &pairs)?;
    let mask = query::fields(&ORGANIZATIONS, &pairs, Organization::ALL)?;
    let list = query::list(&ORGANIZATIONS, &pairs)?;
    let load = member_load(populate, mask);

    let page_sql = format!("{}{}{}", select_sql(load), list.where_sql, list.page_sql());
    let count_sql = format!("SELECT count(*) FROM organizations{}", list.where_sql);
    let client = state.pool.get().await?;
    let (page_statement, count_statement) = tokio::try_join!(client.prepare_cached(&page_sql), client.prepare_cached(&count_sql))?;
    let (page_params, count_params) = (list.page_params(), list.filter_params());
    let (rows, count) = tokio::try_join!(client.query(&page_statement, &page_params), client.query_one(&count_statement, &count_params))?;
    let mut organizations: Vec<Organization> = rows.iter().map(|row| Organization::from_row(row, load == MemberLoad::Ids)).collect();

    if load == MemberLoad::Populate && !organizations.is_empty() {
        // One query for the members of the whole page.
        let ids: Vec<&str> = organizations.iter().map(|organization| organization.id.as_str()).collect();
        let statement = client.prepare_cached(POPULATED_MEMBERS).await?;
        let member_rows = client.query(&statement, &[&ids]).await?;
        drop(client);
        let index: HashMap<String, usize> =
            organizations.iter().enumerate().map(|(position, organization)| (organization.id.clone(), position)).collect();
        for organization in &mut organizations {
            organization.members = Members::Populated(Vec::new());
        }
        for row in &member_rows {
            let owner: &str = row.get(0);
            if let Some(&position) = index.get(owner)
                && let Members::Populated(users) = &mut organizations[position].members
            {
                users.push(User::from_row(row, 1));
            }
        }
    }

    let page = Page { data: MaskedList(&organizations, mask), total: count.get(0), limit: list.limit, offset: list.offset };
    Ok(json_response(StatusCode::OK, &page))
}

pub async fn read(State(state): State<SharedState>, Path(id): Path<String>, RawQuery(raw): RawQuery) -> Result<Response, ApiError> {
    let pairs = query::pairs(raw.as_deref());
    let populate = query::populate(&ORGANIZATIONS, &pairs)?;
    let mask = query::fields(&ORGANIZATIONS, &pairs, Organization::ALL)?;
    let load = member_load(populate, mask);

    let client = state.pool.get().await?;
    let sql = format!("{} WHERE id = $1", select_sql(load));
    let organization = if load == MemberLoad::Populate {
        let ids = vec![id.as_str()];
        let (statement, members_statement) = tokio::try_join!(client.prepare_cached(&sql), client.prepare_cached(POPULATED_MEMBERS))?;
        // The record and its members are fetched together (pipelined on the connection).
        let (record_params, member_params): ([&(dyn ToSql + Sync); 1], [&(dyn ToSql + Sync); 1]) = ([&id], [&ids]);
        let (row, member_rows) =
            tokio::try_join!(client.query_opt(&statement, &record_params), client.query(&members_statement, &member_params))?;
        row.map(|row| {
            let mut organization = Organization::from_row(&row, false);
            organization.members = Members::Populated(member_rows.iter().map(|row| User::from_row(row, 1)).collect());
            organization
        })
    } else {
        let statement = client.prepare_cached(&sql).await?;
        client.query_opt(&statement, &[&id]).await?.map(|row| Organization::from_row(&row, load == MemberLoad::Ids))
    };
    let organization = organization.ok_or_else(|| ApiError::not_found("Organization not found"))?;
    Ok(json_response(StatusCode::OK, &Masked(&organization, mask)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    members: i64,
    admins: i64,
    average_age: Option<f64>,
}

/// Counts the members and admins and averages the non-null ages, in one aggregate query.
pub async fn stats(State(state): State<SharedState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let client = state.pool.get().await?;
    let statement = client
        .prepare_cached(
            "SELECT count(u.id), count(u.id) FILTER (WHERE u.role = 'admin'), avg(u.age) \
             FROM organizations o \
             LEFT JOIN organizations__members m ON m.owner_id = o.id \
             LEFT JOIN users u ON u.id = m.target_id \
             WHERE o.id = $1 GROUP BY o.id",
        )
        .await?;
    let row = client.query_opt(&statement, &[&id]).await?;
    drop(client);
    let row = row.ok_or_else(|| ApiError::not_found("Organization not found"))?;
    Ok(json_response(StatusCode::OK, &Stats { members: row.get(0), admins: row.get(1), average_age: row.get(2) }))
}
