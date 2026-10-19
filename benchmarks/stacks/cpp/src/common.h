// Shared helpers: configuration, error responses, ids, timestamps, JSON and query-string utilities.
#pragma once

#include <drogon/drogon.h>
#include <drogon/orm/DbClient.h>
#include <json/json.h>

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace bench
{
using drogon::HttpRequestPtr;
using drogon::HttpResponsePtr;
using drogon::HttpStatusCode;
using drogon::Task;

/** The directory uploads are stored under (UPLOAD_DIR). */
const std::string &uploadDir();
void setUploadDir(std::string dir);

/** One `{field, message}` entry of an error's `details`. */
struct Detail
{
    std::string field;
    std::string message;
};
using Details = std::vector<Detail>;

/** `{"error":{"code","message","details"?}}`, the code derived from the status. */
HttpResponsePtr errorResponse(HttpStatusCode status,
                              std::string_view message,
                              const Details *details = nullptr);
inline HttpResponsePtr errorResponse(HttpStatusCode status,
                                     std::string_view message,
                                     const Details &details)
{
    return errorResponse(status, message, &details);
}
HttpResponsePtr jsonResponse(const Json::Value &body,
                             HttpStatusCode status = drogon::k200OK);

/** A lowercase canonical UUID version 7 (RFC 9562). */
std::string uuidv7();
/** The current time truncated to milliseconds, as `2026-10-19T16:04:45.600Z`. */
std::string nowIso();
/** A PostgreSQL `timestamptz` in text form (session time zone UTC) as ISO 8601 with milliseconds. */
std::string pgTimestampToIso(std::string_view text);
/** A JSON number: integral values become JSON integers. */
Json::Value numberValue(double value);

/** URLSearchParams-style parsing of a raw query string, in order, with repeated keys kept. */
using QueryParams = std::vector<std::pair<std::string, std::string>>;
QueryParams parseQueryString(std::string_view raw);
/** The first value of a parameter, or nullptr. */
const std::string *firstParam(const QueryParams &params, std::string_view name);

/** String.prototype.trim. */
std::string_view jsTrim(std::string_view s);
/** Splits on commas, trims each item and drops empty ones (like `split(",").map(trim).filter(Boolean)`). */
std::vector<std::string> splitList(std::string_view raw);
/** The length in UTF-16 code units, as JavaScript's `String.prototype.length`. */
size_t utf16Length(std::string_view s);
/** `^[^\s@]+@[^\s@]+\.[^\s@]+$` with JavaScript's definition of `\s`. */
bool isEmail(std::string_view s);

/** A PostgreSQL array literal of text values: `{"a","b"}`. */
std::string pgTextArray(const std::vector<std::string> &values);

/** A query parameter of any type this service binds. */
using SqlParam = std::variant<std::string, double, int64_t, std::nullptr_t>;
/** Runs a statement with a list of parameters known only at run time (prepared and cached by Drogon). */
drogon::orm::internal::SqlAwaiter execSql(const drogon::orm::DbClientPtr &db,
                                          std::string sql,
                                          const std::vector<SqlParam> &params);

/** The database client: one pool of DB_POOL_SIZE connections shared by the IO threads. */
inline const drogon::orm::DbClientPtr &db()
{
    static const drogon::orm::DbClientPtr client = drogon::app().getDbClient();
    return client;
}

}  // namespace bench
