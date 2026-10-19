// /organizations: list, read (with populate=members) and the custom stats endpoint.
#include "records.h"

#include <cstdlib>
#include <unordered_map>

namespace bench
{
namespace
{
using drogon::Get;

/** Member ids in position order, as a text array in the same row. */
constexpr const char *kMemberIds =
    "ARRAY(SELECT m.target_id FROM organizations__members m WHERE m.owner_id = organizations.id "
    "ORDER BY m.position)";

/** Parses PostgreSQL's text form of a one-dimensional text array: `{a,"b c"}`. */
Json::Value parseTextArray(std::string_view text)
{
    Json::Value out(Json::arrayValue);
    if (text.size() < 2)
        return out;
    size_t i = 1;
    const size_t end = text.size() - 1;
    while (i < end)
    {
        std::string item;
        if (text[i] == '"')
        {
            for (++i; i < end && text[i] != '"'; ++i)
            {
                if (text[i] == '\\' && i + 1 < end)
                    ++i;
                item.push_back(text[i]);
            }
            ++i;  // closing quote
        }
        else
        {
            for (; i < end && text[i] != ','; ++i)
                item.push_back(text[i]);
        }
        out.append(std::move(item));
        ++i;  // comma
    }
    return out;
}

/** Full user records of the members of the given organizations, by organization id, in position order. */
Task<std::unordered_map<std::string, Json::Value>> loadMembers(std::vector<std::string> ownerIds)
{
    std::unordered_map<std::string, Json::Value> members;
    for (const auto &id : ownerIds)
        members.emplace(id, Json::Value(Json::arrayValue));
    if (ownerIds.empty())
        co_return members;
    auto rows = co_await db()->execSqlCoro(
        std::string("SELECT m.owner_id, ") + "u.id, u.created_at, u.updated_at, u.email, u.name, u.role, u.age" +
            " FROM organizations__members m JOIN users u ON u.id = m.target_id"
            " WHERE m.owner_id = ANY($1) ORDER BY m.owner_id, m.position",
        pgTextArray(ownerIds));
    for (const auto &row : rows)
        members[row[0].as<std::string>()].append(userFromRow(row, 1));
    co_return members;
}

std::string organizationSelect(const Selection &selection, bool memberIds)
{
    std::string sql = "SELECT " + selectColumns(selection);
    if (memberIds)
        sql += std::string(", ") + kMemberIds;
    return sql + " FROM organizations";
}

/** Column index of the member id array: after id and the selected non-reference fields. */
drogon::orm::Row::SizeType memberColumn(const Selection &selection)
{
    drogon::orm::Row::SizeType index = 1;
    for (const auto *field : selection.fields)
        if (field->type != FieldType::RefArray)
            ++index;
    return index;
}

/** Serializes organization rows, loading populated members with one query for the whole page. */
Task<Json::Value> organizationsJson(const drogon::orm::Result &rows, const Selection &selection, bool populate)
{
    const bool members = selection.has("members");
    std::unordered_map<std::string, Json::Value> populated;
    if (members && populate)
    {
        std::vector<std::string> ids;
        ids.reserve(rows.size());
        for (const auto &row : rows)
            ids.push_back(row[0].as<std::string>());
        populated = co_await loadMembers(std::move(ids));
    }
    const auto column = memberColumn(selection);
    Json::Value data(Json::arrayValue);
    for (const auto &row : rows)
    {
        Json::Value org(Json::objectValue);
        putColumns(org, row, selection);
        if (members)
            org["members"] = populate ? std::move(populated[row[0].as<std::string>()])
                                      : parseTextArray(row[column].as<std::string_view>());
        data.append(std::move(org));
    }
    co_return data;
}

Task<HttpResponsePtr> listOrganizations(HttpRequestPtr req)
{
    const auto &entity = organizationEntity();
    auto params = parseQueryString(req->query());
    bool populate;
    if (auto error = parsePopulate(entity, params, populate))
        co_return *error;
    Selection selection;
    if (auto error = parseSelection(entity, params, selection))
        co_return *error;
    ListQuery query;
    if (auto error = parseListQuery(entity, params, query))
        co_return *error;

    auto client = db();
    auto pageParams = query.params;
    pageParams.emplace_back(query.limit);
    pageParams.emplace_back(query.offset);
    const auto n = query.params.size();
    auto rows = co_await execSql(client,
                                 organizationSelect(selection, selection.has("members") && !populate) +
                                     query.where + query.orderBy + " LIMIT $" + std::to_string(n + 1) +
                                     " OFFSET $" + std::to_string(n + 2),
                                 pageParams);
    auto data = co_await organizationsJson(rows, selection, populate);
    auto count = co_await execSql(client, "SELECT count(*) FROM organizations" + query.where, query.params);
    co_return jsonResponse(page(std::move(data), count[0][0].as<int64_t>(), query.limit, query.offset));
}

Task<HttpResponsePtr> getOrganization(HttpRequestPtr req, std::string id)
{
    const auto &entity = organizationEntity();
    auto params = parseQueryString(req->query());
    bool populate;
    if (auto error = parsePopulate(entity, params, populate))
        co_return *error;
    Selection selection;
    if (auto error = parseSelection(entity, params, selection))
        co_return *error;

    auto rows = co_await db()->execSqlCoro(
        organizationSelect(selection, selection.has("members") && !populate) + " WHERE id = $1", id);
    if (rows.empty())
        co_return errorResponse(drogon::k404NotFound, "Organization not found");
    auto data = co_await organizationsJson(rows, selection, populate);
    co_return jsonResponse(data[0]);
}

Task<HttpResponsePtr> organizationStats(HttpRequestPtr, std::string id)
{
    auto rows = co_await db()->execSqlCoro(
        "SELECT count(u.id), count(*) FILTER (WHERE u.role = 'admin'), avg(u.age) "
        "FROM organizations o "
        "LEFT JOIN organizations__members m ON m.owner_id = o.id "
        "LEFT JOIN users u ON u.id = m.target_id "
        "WHERE o.id = $1 GROUP BY o.id",
        id);
    if (rows.empty())
        co_return errorResponse(drogon::k404NotFound, "Organization not found");
    const auto &row = rows[0];
    Json::Value stats(Json::objectValue);
    stats["members"] = static_cast<Json::Int64>(row[0].as<int64_t>());
    stats["admins"] = static_cast<Json::Int64>(row[1].as<int64_t>());
    stats["averageAge"] = row[2].isNull() ? Json::Value(Json::nullValue)
                                          : Json::Value(std::strtod(row[2].c_str(), nullptr));
    co_return jsonResponse(stats);
}
}  // namespace

void registerOrganizationRoutes()
{
    auto &app = drogon::app();
    app.registerHandler("/organizations", &listOrganizations, {Get});
    app.registerHandler("/organizations/{id}", &getOrganization, {Get});
    app.registerHandler("/organizations/{orgId}/stats", &organizationStats, {Get});
}

}  // namespace bench
