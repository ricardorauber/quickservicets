#include "records.h"

#include <drogon/orm/Exception.h>

#include <cstdlib>
#include <memory>

namespace bench
{
const char *const kUserColumns = "id, created_at, updated_at, email, name, role, age";

Json::Value columnValue(const FieldDef &field, const drogon::orm::Field &column)
{
    if (column.isNull())
        return Json::Value(Json::nullValue);
    switch (field.type)
    {
        case FieldType::Date:
            return Json::Value(pgTimestampToIso(column.as<std::string_view>()));
        case FieldType::Number:
            return numberValue(std::strtod(column.c_str(), nullptr));
        default:
        {
            auto text = column.as<std::string_view>();
            return Json::Value(text.data(), text.data() + text.size());
        }
    }
}

void putColumns(Json::Value &out, const drogon::orm::Row &row, const Selection &selection)
{
    drogon::orm::Row::SizeType index = 1;
    for (const auto *field : selection.fields)
    {
        if (field->type == FieldType::RefArray)
            continue;
        out[std::string(field->name)] = columnValue(*field, row[index++]);
    }
}

Json::Value userFromRow(const drogon::orm::Row &row, size_t first)
{
    const auto &fields = userEntity().fields;
    Json::Value user(Json::objectValue);
    for (size_t i = 0; i < fields.size(); ++i)
        user[std::string(fields[i].name)] =
            columnValue(fields[i], row[static_cast<drogon::orm::Row::SizeType>(first + i)]);
    return user;
}

Json::Value page(Json::Value data, int64_t total, int64_t limit, int64_t offset)
{
    Json::Value body(Json::objectValue);
    body["data"] = std::move(data);
    body["total"] = static_cast<Json::Int64>(total);
    body["limit"] = static_cast<Json::Int64>(limit);
    body["offset"] = static_cast<Json::Int64>(offset);
    return body;
}

std::optional<HttpResponsePtr> parseJsonObject(const HttpRequestPtr &req, Json::Value &body)
{
    // JSON.parse semantics: any JSON value at the root, nothing after it, no comments.
    thread_local std::unique_ptr<Json::CharReader> reader = [] {
        Json::CharReaderBuilder builder;
        Json::CharReaderBuilder::strictMode(&builder.settings_);
        builder["strictRoot"] = false;
        builder["rejectDupKeys"] = false;
        return std::unique_ptr<Json::CharReader>(builder.newCharReader());
    }();
    auto text = req->body();
    std::string errors;
    if (text.empty() || !reader->parse(text.data(), text.data() + text.size(), &body, &errors))
        return errorResponse(drogon::k400BadRequest, "Invalid JSON body");
    if (!body.isObject())
    {
        Details details{{"", "Body must be a JSON object"}};
        return errorResponse(drogon::k400BadRequest, "Invalid body", details);
    }
    return std::nullopt;
}

bool isUniqueViolation(const drogon::orm::DrogonDbException &error)
{
    if (const auto *sqlError = dynamic_cast<const drogon::orm::SqlError *>(&error.base()))
        return sqlError->sqlState() == "23505";
    // Drogon's libpq connections report server errors as a plain Failure holding the server message, without the
    // SQLSTATE: recognize the violated unique index by its name, which the message always quotes.
    return std::string_view(error.base().what()).find("\"users_email_uq\"") != std::string_view::npos;
}

}  // namespace bench
