// /users: list, read, create, update, delete.
#include "records.h"

#include <drogon/orm/Exception.h>

#include <cmath>

namespace bench
{
namespace
{
using drogon::Get;
using drogon::Patch;
using drogon::Post;
using drogon::Delete;

struct UserInput
{
    std::optional<std::string> email;
    std::optional<std::string> name;
    std::optional<std::string> role;
    bool hasAge = false;
    std::optional<double> age;  // nullopt with hasAge = null
};

bool isNumber(const Json::Value &v)
{
    return v.type() == Json::intValue || v.type() == Json::uintValue ||
           v.type() == Json::realValue;
}

/** Validates a create (all rules) or update (only the given fields) body; one message per field. */
Details validateUser(const Json::Value &body, bool create, UserInput &input)
{
    Details details;
    auto stringField = [&](const char *name, std::optional<std::string> &out, auto check) {
        const Json::Value *value = body.find(name, name + std::strlen(name));
        if (!value)
        {
            if (create)
                details.push_back({name, "Is required"});
            return;
        }
        if (value->isNull())
            return details.push_back({name, "Cannot be null"});
        if (!value->isString())
            return details.push_back({name, "Must be a string"});
        std::string text = value->asString();
        if (auto message = check(text); !message.empty())
            return details.push_back({name, message});
        out = std::move(text);
    };

    stringField("email", input.email, [](const std::string &v) -> std::string {
        return isEmail(v) ? "" : "Must be a valid email";
    });
    stringField("name", input.name, [](const std::string &v) -> std::string {
        auto length = utf16Length(v);
        if (length < 1)
            return "Must be at least 1 characters";
        if (length > 100)
            return "Must be at most 100 characters";
        return "";
    });

    if (const Json::Value *role = body.find("role", "role" + 4))
    {
        if (role->isNull())
            details.push_back({"role", "Cannot be null"});
        else if (!role->isString() || (role->asString() != "member" && role->asString() != "admin"))
            details.push_back({"role", "Must be one of: member, admin"});
        else
            input.role = role->asString();
    }
    else if (create)
        input.role = "member";

    if (const Json::Value *age = body.find("age", "age" + 3))
    {
        if (age->isNull())
            input.hasAge = true;
        else if (!isNumber(*age))
            details.push_back({"age", "Must be a number"});
        else
        {
            double value = age->asDouble();
            if (std::floor(value) != value)
                details.push_back({"age", "Must be an integer"});
            else if (value < 0)
                details.push_back({"age", "Must be at least 0"});
            else if (value > 150)
                details.push_back({"age", "Must be at most 150"});
            else
            {
                input.hasAge = true;
                input.age = value;
            }
        }
    }

    for (auto it = body.begin(); it != body.end(); ++it)
    {
        auto key = it.name();
        if (key == "email" || key == "name" || key == "role" || key == "age")
            continue;
        if (key == "id" || key == "createdAt" || key == "updatedAt")
            details.push_back({key, "Field is read-only"});
        else
            details.push_back({key, "Unknown field"});
    }
    return details;
}

HttpResponsePtr invalidBody(const Details &details)
{
    return errorResponse(drogon::k400BadRequest, "Invalid body", details);
}

HttpResponsePtr emailTaken()
{
    Details details{{"email", "Value already exists"}};
    return errorResponse(drogon::k409Conflict, "Value already exists", details);
}

HttpResponsePtr userNotFound()
{
    return errorResponse(drogon::k404NotFound, "User not found");
}

Task<HttpResponsePtr> listUsers(HttpRequestPtr req)
{
    const auto &entity = userEntity();
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
                                 "SELECT " + selectColumns(selection) + " FROM users" + query.where +
                                     query.orderBy + " LIMIT $" + std::to_string(n + 1) + " OFFSET $" +
                                     std::to_string(n + 2),
                                 pageParams);
    auto count = co_await execSql(client, "SELECT count(*) FROM users" + query.where, query.params);

    Json::Value data(Json::arrayValue);
    for (const auto &row : rows)
    {
        Json::Value user(Json::objectValue);
        putColumns(user, row, selection);
        data.append(std::move(user));
    }
    co_return jsonResponse(page(std::move(data), count[0][0].as<int64_t>(), query.limit, query.offset));
}

Task<HttpResponsePtr> getUser(HttpRequestPtr req, std::string id)
{
    const auto &entity = userEntity();
    auto params = parseQueryString(req->query());
    bool populate;
    if (auto error = parsePopulate(entity, params, populate))
        co_return *error;
    Selection selection;
    if (auto error = parseSelection(entity, params, selection))
        co_return *error;

    auto rows = co_await db()->execSqlCoro(
        "SELECT " + selectColumns(selection) + " FROM users WHERE id = $1", id);
    if (rows.empty())
        co_return userNotFound();
    Json::Value user(Json::objectValue);
    putColumns(user, rows[0], selection);
    co_return jsonResponse(user);
}

Task<HttpResponsePtr> createUser(HttpRequestPtr req)
{
    Json::Value body;
    if (auto error = parseJsonObject(req, body))
        co_return *error;
    UserInput input;
    if (auto details = validateUser(body, true, input); !details.empty())
        co_return invalidBody(details);

    const auto id = uuidv7();
    const auto now = nowIso();
    try
    {
        co_await db()->execSqlCoro(
            "INSERT INTO users (id, created_at, updated_at, email, name, role, age) "
            "VALUES ($1, $2, $2, $3, $4, $5, $6)",
            id, now, *input.email, *input.name, *input.role, input.age);
    }
    catch (const drogon::orm::DrogonDbException &e)
    {
        if (isUniqueViolation(e))
            co_return emailTaken();
        throw;
    }

    Json::Value user(Json::objectValue);
    user["id"] = id;
    user["createdAt"] = now;
    user["updatedAt"] = now;
    user["email"] = *input.email;
    user["name"] = *input.name;
    user["role"] = *input.role;
    user["age"] = input.age ? numberValue(*input.age) : Json::Value(Json::nullValue);
    co_return jsonResponse(user, drogon::k201Created);
}

Task<HttpResponsePtr> updateUser(HttpRequestPtr req, std::string id)
{
    Json::Value body;
    if (auto error = parseJsonObject(req, body))
        co_return *error;
    UserInput input;
    if (auto details = validateUser(body, false, input); !details.empty())
        co_return invalidBody(details);

    std::vector<SqlParam> params{nowIso()};
    std::string sql = "UPDATE users SET updated_at = $1";
    auto set = [&](const char *column, SqlParam value) {
        params.push_back(std::move(value));
        sql += std::string(", ") + column + " = $" + std::to_string(params.size());
    };
    if (input.email)
        set("email", *input.email);
    if (input.name)
        set("name", *input.name);
    if (input.role)
        set("role", *input.role);
    if (input.hasAge)
        set("age", input.age ? SqlParam(*input.age) : SqlParam(nullptr));
    params.push_back(std::move(id));
    sql += " WHERE id = $" + std::to_string(params.size()) + " RETURNING " + kUserColumns;

    try
    {
        auto rows = co_await execSql(db(), std::move(sql), params);
        if (rows.empty())
            co_return userNotFound();
        co_return jsonResponse(userFromRow(rows[0]));
    }
    catch (const drogon::orm::DrogonDbException &e)
    {
        if (isUniqueViolation(e))
            co_return emailTaken();
        throw;
    }
}

Task<HttpResponsePtr> deleteUser(HttpRequestPtr, std::string id)
{
    // One statement, so one transaction: delete the user (the junction rows cascade) and touch the owning
    // organizations, found from the junction rows as they were before the delete.
    auto rows = co_await db()->execSqlCoro(
        "WITH deleted AS (DELETE FROM users WHERE id = $1 RETURNING id), "
        "touched AS (UPDATE organizations SET updated_at = $2 WHERE id IN "
        "(SELECT owner_id FROM organizations__members WHERE target_id IN (SELECT id FROM deleted))) "
        "SELECT count(*) FROM deleted",
        id, nowIso());
    if (rows[0][0].as<int64_t>() == 0)
        co_return userNotFound();
    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k204NoContent);
    co_return resp;
}
}  // namespace

void registerUserRoutes()
{
    auto &app = drogon::app();
    app.registerHandler("/users", &listUsers, {Get});
    app.registerHandler("/users", &createUser, {Post});
    app.registerHandler("/users/{id}", &getUser, {Get});
    app.registerHandler("/users/{id}", &updateUser, {Patch});
    app.registerHandler("/users/{id}", &deleteUser, {Delete});
}

}  // namespace bench
