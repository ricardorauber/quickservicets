// The list and read query parameters: filters, sorting, paging, field selection and populate.
#pragma once

#include "common.h"

#include <optional>

namespace bench
{
enum class FieldType
{
    Id,
    Date,
    String,
    Number,
    Enum,
    RefArray,
};

struct FieldDef
{
    std::string_view name;
    std::string_view column;  // empty for reference arrays
    FieldType type;
    const std::vector<std::string> *values = nullptr;  // enum values
};

struct Entity
{
    std::string_view table;
    std::vector<FieldDef> fields;
    /** The reference array that `populate` accepts, if any. */
    std::string_view populatable;

    const FieldDef *find(std::string_view name) const;
};

const Entity &userEntity();
const Entity &organizationEntity();

/** The fields a response includes: every field, or the ones `fields` lists. */
struct Selection
{
    std::vector<const FieldDef *> fields;
    bool has(std::string_view name) const;
};

struct ListQuery
{
    std::string where;    // "" or " WHERE ..."
    std::string orderBy;  // " ORDER BY ..."
    std::vector<SqlParam> params;
    int64_t limit = 20;
    int64_t offset = 0;
};

/** Validates `populate`; returns the 400 response when it names something that cannot be populated. */
std::optional<HttpResponsePtr> parsePopulate(const Entity &entity,
                                             const QueryParams &params,
                                             bool &populate);
/** Validates `fields`; returns the 400 response when it is invalid. */
std::optional<HttpResponsePtr> parseSelection(const Entity &entity,
                                              const QueryParams &params,
                                              Selection &selection);
/** Validates the list parameters (filters, sort, limit, offset, unknown and repeated keys). */
std::optional<HttpResponsePtr> parseListQuery(const Entity &entity,
                                              const QueryParams &params,
                                              ListQuery &query);

/** Comma-separated column list for the selected fields (reference arrays excluded), `id` always included. */
std::string selectColumns(const Selection &selection, std::string_view prefix = "");

}  // namespace bench
