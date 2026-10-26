#include "query.h"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <unordered_set>

namespace bench
{
namespace
{
const std::vector<std::string> kRoles = {"member", "admin"};

constexpr size_t kMaxListValues = 100;
constexpr int64_t kMaxLimit = 100;
constexpr double kMaxSafeInteger = 9007199254740991.0;

const std::vector<std::string_view> kOperators = {
    "eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains",
    "startsWith", "exists", "isNull", "containsAny", "containsAll", "size",
    "isEmpty"};

bool operatorAllowed(FieldType type, std::string_view op)
{
    static const std::vector<std::string_view> common = {
        "eq", "ne", "in", "nin", "exists", "isNull"};
    auto in = [&](std::initializer_list<std::string_view> list) {
        return std::find(list.begin(), list.end(), op) != list.end();
    };
    if (type == FieldType::RefArray)
        return in({"contains", "containsAny", "containsAll", "size", "isEmpty"});
    if (std::find(common.begin(), common.end(), op) != common.end())
        return true;
    if (type == FieldType::String)
        return in({"contains", "startsWith"});
    if (type == FieldType::Number || type == FieldType::Date)
        return in({"gt", "gte", "lt", "lte"});
    return false;
}

/** JavaScript's `Number(raw)` for the decimal and 0x/0o/0b forms; nullopt when not a finite number. */
std::optional<double> jsNumber(std::string_view raw)
{
    auto s = jsTrim(raw);
    if (s.empty())
        return std::nullopt;
    if (s.size() > 2 && s[0] == '0' &&
        (s[1] == 'x' || s[1] == 'X' || s[1] == 'o' || s[1] == 'O' ||
         s[1] == 'b' || s[1] == 'B'))
    {
        int base = (s[1] == 'x' || s[1] == 'X') ? 16 : (s[1] == 'o' || s[1] == 'O') ? 8 : 2;
        double value = 0;
        for (char c : s.substr(2))
        {
            int digit = std::isdigit(static_cast<unsigned char>(c))
                            ? c - '0'
                            : (std::isalpha(static_cast<unsigned char>(c))
                                   ? std::tolower(c) - 'a' + 10
                                   : 99);
            if (digit >= base)
                return std::nullopt;
            value = value * base + digit;
        }
        return value;
    }
    for (char c : s)
        if (!(std::isdigit(static_cast<unsigned char>(c)) || c == '.' ||
              c == 'e' || c == 'E' || c == '+' || c == '-'))
            return std::nullopt;
    std::string copy(s);
    char *end = nullptr;
    double value = std::strtod(copy.c_str(), &end);
    if (end != copy.c_str() + copy.size() || !std::isfinite(value))
        return std::nullopt;
    return value;
}

std::string formatNumber(double value)
{
    char buf[32];
    auto [end, ec] = std::to_chars(buf, buf + sizeof(buf), value);
    return std::string(buf, end);
}

bool digitsAt(std::string_view s, size_t pos, size_t count)
{
    if (pos + count > s.size())
        return false;
    for (size_t i = pos; i < pos + count; ++i)
        if (!std::isdigit(static_cast<unsigned char>(s[i])))
            return false;
    return true;
}

int number(std::string_view s, size_t pos, size_t count)
{
    int value = 0;
    for (size_t i = pos; i < pos + count; ++i)
        value = value * 10 + (s[i] - '0');
    return value;
}

/** `^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$`, with valid ranges. */
bool isIsoDate(std::string_view s)
{
    if (!digitsAt(s, 0, 4) || s.size() < 10 || s[4] != '-' || !digitsAt(s, 5, 2) ||
        s[7] != '-' || !digitsAt(s, 8, 2))
        return false;
    int month = number(s, 5, 2), day = number(s, 8, 2);
    if (month < 1 || month > 12 || day < 1 || day > 31)
        return false;
    size_t pos = 10;
    if (pos == s.size())
        return true;
    if (s[pos] != 'T' || !digitsAt(s, pos + 1, 2) || pos + 3 >= s.size() ||
        s[pos + 3] != ':' || !digitsAt(s, pos + 4, 2))
        return false;
    if (number(s, pos + 1, 2) > 23 || number(s, pos + 4, 2) > 59)
        return false;
    pos += 6;
    if (pos < s.size() && s[pos] == ':')
    {
        if (!digitsAt(s, pos + 1, 2) || number(s, pos + 1, 2) > 59)
            return false;
        pos += 3;
        if (pos < s.size() && s[pos] == '.')
        {
            size_t start = ++pos;
            while (pos < s.size() && std::isdigit(static_cast<unsigned char>(s[pos])))
                ++pos;
            if (pos == start)
                return false;
        }
    }
    if (pos == s.size())
        return true;
    if (s[pos] == 'Z')
        return pos + 1 == s.size();
    if ((s[pos] == '+' || s[pos] == '-') && pos + 6 == s.size() &&
        digitsAt(s, pos + 1, 2) && s[pos + 3] == ':' && digitsAt(s, pos + 4, 2))
        return number(s, pos + 1, 2) <= 23 && number(s, pos + 4, 2) <= 59;
    return false;
}

/** Converts one filter value to its SQL parameter text, or returns the error message. */
std::optional<std::string> convertValue(const FieldDef &field,
                                        std::string_view raw,
                                        std::string &error)
{
    switch (field.type)
    {
        case FieldType::Number:
        {
            auto value = jsNumber(raw);
            if (!value)
            {
                error = "Must be a number";
                return std::nullopt;
            }
            return formatNumber(*value);
        }
        case FieldType::Enum:
        {
            if (std::find(field.values->begin(), field.values->end(), raw) ==
                field.values->end())
            {
                error = "Must be one of: ";
                for (size_t i = 0; i < field.values->size(); ++i)
                    error += (i ? ", " : "") + (*field.values)[i];
                return std::nullopt;
            }
            return std::string(raw);
        }
        case FieldType::Date:
            if (!isIsoDate(raw))
            {
                error = "Must be an ISO 8601 date";
                return std::nullopt;
            }
            return std::string(raw);
        default:
            return std::string(raw);
    }
}

std::string likePattern(std::string_view value, bool prefixOnly)
{
    std::string out = prefixOnly ? "" : "%";
    for (char c : value)
    {
        if (c == '%' || c == '_' || c == '\\')
            out.push_back('\\');
        out.push_back(c);
    }
    out.push_back('%');
    return out;
}

/** Parses `where[field][op]`; false when the key has another shape. */
bool parseWhereKey(std::string_view key,
                   std::string_view &field,
                   std::string_view &op,
                   std::optional<std::string_view> &comparison)
{
    if (key.substr(0, 6) != "where[")
        return false;
    auto close1 = key.find(']', 6);
    if (close1 == std::string_view::npos || close1 == 6 || close1 + 1 >= key.size() ||
        key[close1 + 1] != '[')
        return false;
    auto close2 = key.find(']', close1 + 2);
    if (close2 == std::string_view::npos || close2 == close1 + 2)
        return false;
    field = key.substr(6, close1 - 6);
    op = key.substr(close1 + 2, close2 - close1 - 2);
    comparison.reset();
    if (close2 + 1 == key.size())
        return true;
    // An optional third segment, `where[field][size][eq]`.
    if (key[close2 + 1] != '[' || key.back() != ']' || key.size() - close2 - 3 == 0)
        return false;
    auto third = key.substr(close2 + 2, key.size() - close2 - 3);
    if (third.find(']') != std::string_view::npos)
        return false;
    comparison = third;
    return true;
}

/** Filters on the reference array `members` (organizations only), through the junction table. */
void addMembersCondition(std::string_view op,
                         std::optional<std::string_view> comparison,
                         const std::string &raw,
                         const std::function<void(std::string)> &fail,
                         const std::function<std::string(SqlParam)> &placeholder,
                         std::vector<std::string> &conditions)
{
    static const std::string junction =
        "FROM organizations__members m WHERE m.owner_id = organizations.id";
    if (op == "size")
    {
        static const std::vector<std::pair<std::string_view, std::string_view>> sizeComparisons = {
            {"eq", " = "}, {"ne", " <> "}, {"gt", " > "}, {"gte", " >= "}, {"lt", " < "}, {"lte", " <= "}};
        auto match = std::find_if(sizeComparisons.begin(), sizeComparisons.end(),
                                  [&](const auto &c) { return c.first == *comparison; });
        if (match == sizeComparisons.end())
            return fail("Unknown operator \"" + std::string(*comparison) + "\"");
        if (raw.empty() || !std::all_of(raw.begin(), raw.end(), [](char c) { return c >= '0' && c <= '9'; }))
            return fail("Must be a non-negative integer");
        conditions.push_back("(SELECT count(*) " + junction + ")" + std::string(match->second) +
                             placeholder(static_cast<int64_t>(std::strtod(raw.c_str(), nullptr))));
        return;
    }
    if (op == "isEmpty")
    {
        if (raw != "true" && raw != "false")
            return fail("Must be true or false");
        conditions.push_back(std::string(raw == "true" ? "NOT " : "") + "EXISTS (SELECT 1 " + junction + ")");
        return;
    }
    if (op == "containsAny" || op == "containsAll")
    {
        auto items = splitList(raw);
        std::vector<std::string> unique;
        for (auto &item : items)
            if (std::find(unique.begin(), unique.end(), item) == unique.end())
                unique.push_back(std::move(item));
        if (unique.empty())
            return fail("Must list at least one value");
        if (unique.size() > kMaxListValues)
            return fail("Must list at most 100 values");
        auto ids = placeholder(pgTextArray(unique));
        if (op == "containsAny")
            conditions.push_back("EXISTS (SELECT 1 " + junction + " AND m.target_id = ANY(" + ids + "))");
        else
            conditions.push_back("(SELECT count(*) " + junction + " AND m.target_id = ANY(" + ids + ")) = " +
                                 placeholder(static_cast<int64_t>(unique.size())));
        return;
    }
    // contains: one id.
    if (jsTrim(raw).empty())
        return fail("Must not be empty");
    conditions.push_back("EXISTS (SELECT 1 " + junction + " AND m.target_id = " + placeholder(raw) + ")");
}

void addCondition(const FieldDef &field,
                  std::string_view op,
                  std::optional<std::string_view> comparison,
                  const std::string &raw,
                  const std::string &key,
                  ListQuery &query,
                  std::vector<std::string> &conditions,
                  Details &details)
{
    auto fail = [&](std::string message) { details.push_back({key, std::move(message)}); };
    if (std::find(kOperators.begin(), kOperators.end(), op) == kOperators.end())
        return fail("Unknown operator \"" + std::string(op) + "\"");
    if (!operatorAllowed(field.type, op))
        return fail("Operator \"" + std::string(op) + "\" is not allowed for this field");
    if ((op == "size") != comparison.has_value())
        return fail(op == "size" ? "Use where[field][size][eq|ne|gt|gte|lt|lte]"
                                 : "Unknown operator \"" + std::string(op) + "\"");

    const std::string column(field.column);
    auto placeholder = [&](SqlParam param) {
        query.params.push_back(std::move(param));
        return "$" + std::to_string(query.params.size());
    };
    if (field.type == FieldType::RefArray)
        return addMembersCondition(op, comparison, raw, fail, placeholder, conditions);
    if (op == "exists" || op == "isNull")
    {
        if (raw != "true" && raw != "false")
            return fail("Must be true or false");
        bool notNull = (op == "exists") == (raw == "true");
        conditions.push_back(column + (notNull ? " IS NOT NULL" : " IS NULL"));
        return;
    }
    if (op == "in" || op == "nin")
    {
        auto items = splitList(raw);
        if (items.empty())
            return fail("Must list at least one value");
        if (items.size() > kMaxListValues)
            return fail("Must list at most 100 values");
        std::vector<std::string> values;
        size_t before = details.size();
        for (const auto &item : items)
        {
            std::string error;
            auto value = convertValue(field, item, error);
            if (value)
                values.push_back(std::move(*value));
            else
                fail(error);
        }
        if (details.size() > before)
            return;
        auto p = placeholder(pgTextArray(values));
        conditions.push_back(op == "in" ? column + " = ANY(" + p + ")"
                                        : column + " <> ALL(" + p + ")");
        return;
    }
    std::string error;
    auto value = convertValue(field, raw, error);
    if (!value)
        return fail(error);
    if (op == "contains" || op == "startsWith")
    {
        auto p = placeholder(likePattern(*value, op == "startsWith"));
        conditions.push_back(column + " ILIKE " + p);
        return;
    }
    static const std::vector<std::pair<std::string_view, std::string_view>> comparisons = {
        {"eq", " = "}, {"ne", " <> "}, {"gt", " > "}, {"gte", " >= "}, {"lt", " < "}, {"lte", " <= "}};
    for (const auto &[name, sql] : comparisons)
    {
        if (op == name)
        {
            auto p = field.type == FieldType::Number
                         ? placeholder(std::strtod(value->c_str(), nullptr))
                         : placeholder(std::move(*value));
            conditions.push_back(column + std::string(sql) + p);
            return;
        }
    }
}

/** `/^-?\d+$/` then the range check, as QuickService.ts's parseInteger. */
bool parseInteger(const std::string &raw, double min, double max, int64_t &out)
{
    size_t start = (!raw.empty() && raw[0] == '-') ? 1 : 0;
    if (raw.size() == start)
        return false;
    for (size_t i = start; i < raw.size(); ++i)
        if (!std::isdigit(static_cast<unsigned char>(raw[i])))
            return false;
    double value = std::strtod(raw.c_str(), nullptr);
    if (value < min || value > max)
        return false;
    out = static_cast<int64_t>(value);
    return true;
}
}  // namespace

const FieldDef *Entity::find(std::string_view name) const
{
    for (const auto &field : fields)
        if (field.name == name)
            return &field;
    return nullptr;
}

const Entity &userEntity()
{
    static const Entity entity{"users",
                               {{"id", "id", FieldType::Id},
                                {"createdAt", "created_at", FieldType::Date},
                                {"updatedAt", "updated_at", FieldType::Date},
                                {"email", "email", FieldType::String},
                                {"name", "name", FieldType::String},
                                {"role", "role", FieldType::Enum, &kRoles},
                                {"age", "age", FieldType::Number}},
                               ""};
    return entity;
}

const Entity &organizationEntity()
{
    static const Entity entity{"organizations",
                               {{"id", "id", FieldType::Id},
                                {"createdAt", "created_at", FieldType::Date},
                                {"updatedAt", "updated_at", FieldType::Date},
                                {"name", "name", FieldType::String},
                                {"slug", "slug", FieldType::String},
                                {"members", "", FieldType::RefArray}},
                               "members"};
    return entity;
}

bool Selection::has(std::string_view name) const
{
    for (const auto *field : fields)
        if (field->name == name)
            return true;
    return false;
}

std::optional<HttpResponsePtr> parsePopulate(const Entity &entity,
                                             const QueryParams &params,
                                             bool &populate)
{
    populate = false;
    const auto *raw = firstParam(params, "populate");
    if (!raw)
        return std::nullopt;
    Details details;
    for (const auto &path : splitList(*raw))
    {
        if (!entity.populatable.empty() && path == entity.populatable)
            populate = true;
        else
            details.push_back({"populate", "Cannot populate: " + path});
    }
    if (details.empty())
        return std::nullopt;
    auto message = details.front().message;
    return errorResponse(drogon::k400BadRequest, message, details);
}

std::optional<HttpResponsePtr> parseSelection(const Entity &entity,
                                              const QueryParams &params,
                                              Selection &selection)
{
    selection.fields.clear();
    const auto *raw = firstParam(params, "fields");
    if (!raw)
    {
        for (const auto &field : entity.fields)
            selection.fields.push_back(&field);
        return std::nullopt;
    }
    Details details;
    auto items = splitList(*raw);
    if (items.empty())
        details.push_back({"fields", "Must list at least one field"});
    std::unordered_set<std::string> seen;
    for (const auto &item : items)
    {
        if (!seen.insert(item).second)
            continue;
        const auto *field = entity.find(item);
        if (field)
            selection.fields.push_back(field);
        else
            details.push_back({"fields", "Unknown field: " + item});
    }
    if (details.empty())
        return std::nullopt;
    return errorResponse(drogon::k400BadRequest, "Invalid query", details);
}

std::optional<HttpResponsePtr> parseListQuery(const Entity &entity,
                                              const QueryParams &params,
                                              ListQuery &query)
{
    Details details;
    std::vector<std::string> conditions;
    std::unordered_set<std::string_view> seen;
    const std::string *sort = nullptr;
    const std::string *limit = nullptr;
    const std::string *offset = nullptr;

    for (const auto &[key, raw] : params)
    {
        if (!seen.insert(key).second)
        {
            details.push_back({key, "Parameter is repeated"});
            continue;
        }
        std::string_view fieldName, op;
        std::optional<std::string_view> comparison;
        if (parseWhereKey(key, fieldName, op, comparison))
        {
            const auto *field = entity.find(fieldName);
            if (!field)
                details.push_back({key, "Field \"" + std::string(fieldName) + "\" cannot be filtered"});
            else
                addCondition(*field, op, comparison, raw, key, query, conditions, details);
        }
        else if (key == "sort")
            sort = &raw;
        else if (key == "limit")
            limit = &raw;
        else if (key == "offset")
            offset = &raw;
        else if (key != "fields" && key != "populate")
            details.push_back({key, "Unknown parameter"});
    }

    // Sort: the given fields, then id descending unless id is listed.
    std::vector<std::pair<const FieldDef *, bool>> order;
    if (!sort)
        order.emplace_back(entity.find("createdAt"), true);
    else
    {
        size_t start = 0;
        while (start <= sort->size())
        {
            size_t end = sort->find(',', start);
            if (end == std::string::npos)
                end = sort->size();
            auto part = jsTrim(std::string_view(*sort).substr(start, end - start));
            start = end + 1;
            bool descending = !part.empty() && part[0] == '-';
            auto name = descending ? part.substr(1) : part;
            const auto *field = entity.find(name);
            if (!field || field->type == FieldType::RefArray)
            {
                details.push_back({"sort", "Field \"" + std::string(name) + "\" cannot be sorted"});
                continue;
            }
            if (std::any_of(order.begin(), order.end(), [&](const auto &o) { return o.first == field; }))
            {
                details.push_back({"sort", "Field \"" + std::string(name) + "\" is listed more than once"});
                continue;
            }
            order.emplace_back(field, descending);
        }
    }
    const auto *idField = entity.find("id");
    if (std::none_of(order.begin(), order.end(), [&](const auto &o) { return o.first == idField; }))
        order.emplace_back(idField, true);

    if (limit && !parseInteger(*limit, 1, kMaxLimit, query.limit))
        details.push_back({"limit", "Must be an integer from 1 to 100"});
    if (offset && !parseInteger(*offset, 0, kMaxSafeInteger, query.offset))
        details.push_back({"offset", "Must be an integer of at least 0"});

    if (!details.empty())
        return errorResponse(drogon::k400BadRequest, "Invalid query", details);

    if (!conditions.empty())
    {
        query.where = " WHERE ";
        for (size_t i = 0; i < conditions.size(); ++i)
        {
            if (i)
                query.where += " AND ";
            query.where += conditions[i];
        }
    }
    query.orderBy = " ORDER BY ";
    for (size_t i = 0; i < order.size(); ++i)
    {
        if (i)
            query.orderBy += ", ";
        query.orderBy += order[i].first->column;
        query.orderBy += order[i].second ? " DESC" : " ASC";
    }
    return std::nullopt;
}

std::string selectColumns(const Selection &selection, std::string_view prefix)
{
    std::string sql(prefix);
    sql += "id";
    for (const auto *field : selection.fields)
    {
        if (field->type == FieldType::RefArray)
            continue;
        sql += ", ";
        sql += prefix;
        sql += field->column;
    }
    return sql;
}

}  // namespace bench
