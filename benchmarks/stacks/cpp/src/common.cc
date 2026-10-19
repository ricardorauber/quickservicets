#include "common.h"

#include <chrono>
#include <cmath>
#include <ctime>
#include <random>

namespace bench
{
namespace
{
std::string &uploadDirStorage()
{
    static std::string dir = "./uploads";
    return dir;
}

const char *codeFor(HttpStatusCode status)
{
    switch (status)
    {
        case drogon::k400BadRequest:
            return "VALIDATION_ERROR";
        case drogon::k404NotFound:
            return "NOT_FOUND";
        case drogon::k409Conflict:
            return "CONFLICT";
        case drogon::k413RequestEntityTooLarge:
            return "PAYLOAD_TOO_LARGE";
        case drogon::k415UnsupportedMediaType:
            return "UNSUPPORTED_MEDIA_TYPE";
        default:
            return "INTERNAL_ERROR";
    }
}

/** Decodes one UTF-8 code point at `i`; malformed bytes decode as themselves, one byte long. */
char32_t decodeUtf8(std::string_view s, size_t i, size_t &length)
{
    auto c = static_cast<unsigned char>(s[i]);
    auto continuation = [&](size_t n) {
        for (size_t k = 1; k <= n; ++k)
            if (i + k >= s.size() ||
                (static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80)
                return false;
        return true;
    };
    if (c < 0x80)
    {
        length = 1;
        return c;
    }
    if ((c & 0xE0) == 0xC0 && continuation(1))
    {
        length = 2;
        return ((c & 0x1F) << 6) | (s[i + 1] & 0x3F);
    }
    if ((c & 0xF0) == 0xE0 && continuation(2))
    {
        length = 3;
        return ((c & 0x0F) << 12) | ((s[i + 1] & 0x3F) << 6) |
               (s[i + 2] & 0x3F);
    }
    if ((c & 0xF8) == 0xF0 && continuation(3))
    {
        length = 4;
        return ((c & 0x07) << 18) | ((s[i + 1] & 0x3F) << 12) |
               ((s[i + 2] & 0x3F) << 6) | (s[i + 3] & 0x3F);
    }
    length = 1;
    return c;
}

/** JavaScript's WhiteSpace and LineTerminator code points (what `\s` and `trim` use). */
bool isJsSpace(char32_t c)
{
    return (c >= 0x09 && c <= 0x0D) || c == 0x20 || c == 0xA0 ||
           c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 ||
           c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 ||
           c == 0xFEFF;
}

int hexValue(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

/** application/x-www-form-urlencoded decoding: `+` is a space, malformed escapes stay as they are. */
std::string formDecode(std::string_view s)
{
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i)
    {
        char c = s[i];
        if (c == '+')
            out.push_back(' ');
        else if (c == '%' && i + 2 < s.size() && hexValue(s[i + 1]) >= 0 && hexValue(s[i + 2]) >= 0)
        {
            out.push_back(static_cast<char>(hexValue(s[i + 1]) * 16 +
                                            hexValue(s[i + 2])));
            i += 2;
        }
        else
            out.push_back(c);
    }
    return out;
}
}  // namespace

const std::string &uploadDir()
{
    return uploadDirStorage();
}

void setUploadDir(std::string dir)
{
    uploadDirStorage() = std::move(dir);
}

HttpResponsePtr errorResponse(HttpStatusCode status,
                              std::string_view message,
                              const Details *details)
{
    Json::Value error(Json::objectValue);
    error["code"] = codeFor(status);
    error["message"] = std::string(message);
    if (details)
    {
        Json::Value list(Json::arrayValue);
        for (const auto &d : *details)
        {
            Json::Value item(Json::objectValue);
            item["field"] = d.field;
            item["message"] = d.message;
            list.append(std::move(item));
        }
        error["details"] = std::move(list);
    }
    Json::Value body(Json::objectValue);
    body["error"] = std::move(error);
    return jsonResponse(body, status);
}

HttpResponsePtr jsonResponse(const Json::Value &body, HttpStatusCode status)
{
    auto resp = drogon::HttpResponse::newHttpJsonResponse(body);
    resp->setStatusCode(status);
    return resp;
}

std::string uuidv7()
{
    thread_local std::mt19937_64 rng{std::random_device{}()};
    const auto ms = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count());
    const uint64_t a = rng();
    const uint64_t b = rng();
    unsigned char bytes[16];
    for (int i = 0; i < 6; ++i)
        bytes[i] = static_cast<unsigned char>(ms >> (8 * (5 - i)));
    bytes[6] = static_cast<unsigned char>(0x70 | (a & 0x0F));
    bytes[7] = static_cast<unsigned char>(a >> 8);
    bytes[8] = static_cast<unsigned char>(0x80 | (b & 0x3F));
    for (int i = 9; i < 16; ++i)
        bytes[i] = static_cast<unsigned char>(b >> (8 * (i - 8)));
    static const char hex[] = "0123456789abcdef";
    std::string out;
    out.reserve(36);
    for (int i = 0; i < 16; ++i)
    {
        if (i == 4 || i == 6 || i == 8 || i == 10)
            out.push_back('-');
        out.push_back(hex[bytes[i] >> 4]);
        out.push_back(hex[bytes[i] & 0x0F]);
    }
    return out;
}

std::string nowIso()
{
    const auto now = std::chrono::system_clock::now();
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        now.time_since_epoch())
                        .count();
    const std::time_t seconds = static_cast<std::time_t>(ms / 1000);
    std::tm tm{};
    gmtime_r(&seconds, &tm);
    char buf[48];
    std::snprintf(buf,
                  sizeof(buf),
                  "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                  tm.tm_year + 1900,
                  tm.tm_mon + 1,
                  tm.tm_mday,
                  tm.tm_hour,
                  tm.tm_min,
                  tm.tm_sec,
                  static_cast<int>(ms % 1000));
    return buf;
}

std::string pgTimestampToIso(std::string_view text)
{
    // "2026-10-19 16:04:45.6+00" -> "2026-10-19T16:04:45.600Z"
    if (text.size() < 19)
        return std::string(text);
    std::string out;
    out.reserve(24);
    out.append(text.substr(0, 10));
    out.push_back('T');
    out.append(text.substr(11, 8));
    out.push_back('.');
    size_t digits = 0;
    if (text.size() > 19 && text[19] == '.')
    {
        for (size_t i = 20; i < text.size() && digits < 3 &&
                            text[i] >= '0' && text[i] <= '9';
             ++i, ++digits)
            out.push_back(text[i]);
    }
    for (; digits < 3; ++digits)
        out.push_back('0');
    out.push_back('Z');
    return out;
}

Json::Value numberValue(double value)
{
    if (std::isfinite(value) && std::floor(value) == value &&
        std::fabs(value) < 9007199254740992.0)
        return Json::Value(static_cast<Json::Int64>(value));
    return Json::Value(value);
}

QueryParams parseQueryString(std::string_view raw)
{
    QueryParams params;
    size_t start = 0;
    while (start <= raw.size())
    {
        size_t end = raw.find('&', start);
        if (end == std::string_view::npos)
            end = raw.size();
        auto piece = raw.substr(start, end - start);
        if (!piece.empty())
        {
            auto eq = piece.find('=');
            if (eq == std::string_view::npos)
                params.emplace_back(formDecode(piece), std::string());
            else
                params.emplace_back(formDecode(piece.substr(0, eq)),
                                    formDecode(piece.substr(eq + 1)));
        }
        start = end + 1;
    }
    return params;
}

const std::string *firstParam(const QueryParams &params, std::string_view name)
{
    for (const auto &[key, value] : params)
        if (key == name)
            return &value;
    return nullptr;
}

std::string_view jsTrim(std::string_view s)
{
    size_t begin = 0;
    while (begin < s.size())
    {
        size_t len;
        if (!isJsSpace(decodeUtf8(s, begin, len)))
            break;
        begin += len;
    }
    size_t end = begin;
    size_t lastNonSpace = begin;
    while (end < s.size())
    {
        size_t len;
        bool space = isJsSpace(decodeUtf8(s, end, len));
        end += len;
        if (!space)
            lastNonSpace = end;
    }
    return s.substr(begin, lastNonSpace - begin);
}

std::vector<std::string> splitList(std::string_view raw)
{
    std::vector<std::string> items;
    size_t start = 0;
    while (start <= raw.size())
    {
        size_t end = raw.find(',', start);
        if (end == std::string_view::npos)
            end = raw.size();
        auto item = jsTrim(raw.substr(start, end - start));
        if (!item.empty())
            items.emplace_back(item);
        start = end + 1;
    }
    return items;
}

size_t utf16Length(std::string_view s)
{
    size_t units = 0;
    for (size_t i = 0; i < s.size();)
    {
        size_t len;
        char32_t c = decodeUtf8(s, i, len);
        units += c >= 0x10000 ? 2 : 1;
        i += len;
    }
    return units;
}

bool isEmail(std::string_view s)
{
    size_t at = std::string_view::npos;
    for (size_t i = 0; i < s.size();)
    {
        size_t len;
        char32_t c = decodeUtf8(s, i, len);
        if (isJsSpace(c))
            return false;
        if (c == '@')
        {
            if (at != std::string_view::npos)
                return false;
            at = i;
        }
        i += len;
    }
    if (at == std::string_view::npos || at == 0)
        return false;
    // The domain needs a dot with at least one character on each side.
    auto domain = s.substr(at + 1);
    for (size_t i = 1; i + 1 < domain.size(); ++i)
        if (domain[i] == '.')
            return true;
    return false;
}

std::string pgTextArray(const std::vector<std::string> &values)
{
    std::string out = "{";
    for (size_t i = 0; i < values.size(); ++i)
    {
        if (i > 0)
            out.push_back(',');
        out.push_back('"');
        for (char c : values[i])
        {
            if (c == '"' || c == '\\')
                out.push_back('\\');
            out.push_back(c);
        }
        out.push_back('"');
    }
    out.push_back('}');
    return out;
}

drogon::orm::internal::SqlAwaiter execSql(const drogon::orm::DbClientPtr &db,
                                          std::string sql,
                                          const std::vector<SqlParam> &params)
{
    auto binder = *db << std::move(sql);
    for (const auto &param : params)
        std::visit([&binder](const auto &value) { binder << value; }, param);
    return drogon::orm::internal::SqlAwaiter(std::move(binder));
}

}  // namespace bench
