// Row-to-JSON serialization and the routes of each resource.
#pragma once

#include "query.h"

#include <drogon/orm/Field.h>
#include <drogon/orm/Row.h>

namespace bench
{
/** The value of one column as JSON, by the field's type. */
Json::Value columnValue(const FieldDef &field, const drogon::orm::Field &column);

/**
 * Writes the selected fields of a row into `out`. The row holds `id` in column 0 and the selected non-reference
 * fields from column 1 on, in selection order (see selectColumns).
 */
void putColumns(Json::Value &out, const drogon::orm::Row &row, const Selection &selection);

/** The full user columns, in the order userFromRow reads them. */
extern const char *const kUserColumns;
/** A full user record from columns `first` to `first + 6` (kUserColumns order). */
Json::Value userFromRow(const drogon::orm::Row &row, size_t first = 0);

/** `{"data","total","limit","offset"}`. */
Json::Value page(Json::Value data, int64_t total, int64_t limit, int64_t offset);

/** Parses a JSON request body: the 400 response when it is not valid JSON or not an object. */
std::optional<HttpResponsePtr> parseJsonObject(const HttpRequestPtr &req, Json::Value &body);

/** Whether a database exception is the unique violation SQLSTATE 23505. */
bool isUniqueViolation(const drogon::orm::DrogonDbException &error);

void registerUserRoutes();
void registerOrganizationRoutes();
void registerMediaRoutes();

}  // namespace bench
