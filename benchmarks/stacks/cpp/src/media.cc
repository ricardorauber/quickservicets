// /media: multipart upload, record read and file download.
#include "records.h"

#include <cstdio>
#include <filesystem>
#include <system_error>

namespace bench
{
namespace
{
using drogon::Get;
using drogon::Post;

constexpr size_t kMaxFileSize = 1024 * 1024;

std::string lower(std::string_view s)
{
    std::string out(s);
    for (auto &c : out)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return out;
}

bool startsWithInsensitive(std::string_view s, std::string_view prefix)
{
    return s.size() >= prefix.size() && lower(s.substr(0, prefix.size())) == prefix;
}

/** One part of a multipart/form-data body. */
struct Part
{
    std::string name;
    bool isFile = false;
    std::string filename;
    std::optional<std::string> contentType;
    std::string_view content;
};

/** The parameters of a Content-Disposition value (`form-data; name="file"; filename="a.png"`), keys lowercased. */
std::vector<std::pair<std::string, std::string>> dispositionParams(std::string_view value)
{
    std::vector<std::pair<std::string, std::string>> params;
    size_t i = value.find(';');
    while (i != std::string_view::npos && i < value.size())
    {
        ++i;
        while (i < value.size() && (value[i] == ' ' || value[i] == '\t'))
            ++i;
        size_t eq = value.find('=', i);
        if (eq == std::string_view::npos)
            break;
        std::string key = lower(jsTrim(value.substr(i, eq - i)));
        i = eq + 1;
        std::string val;
        if (i < value.size() && value[i] == '"')
        {
            for (++i; i < value.size() && value[i] != '"'; ++i)
            {
                if (value[i] == '\\' && i + 1 < value.size())
                    ++i;
                val.push_back(value[i]);
            }
            i = value.find(';', i);
        }
        else
        {
            size_t end = value.find(';', i);
            val = std::string(jsTrim(value.substr(i, end == std::string_view::npos ? std::string_view::npos : end - i)));
            i = end;
        }
        params.emplace_back(std::move(key), std::move(val));
    }
    return params;
}

/** RFC 5987 `filename*=UTF-8''percent%20encoded`. */
std::string decodeExtendedValue(std::string_view value)
{
    auto quote = value.find("''");
    if (quote != std::string_view::npos)
        value = value.substr(quote + 2);
    std::string out;
    for (size_t i = 0; i < value.size(); ++i)
    {
        if (value[i] == '%' && i + 2 < value.size() && std::isxdigit(static_cast<unsigned char>(value[i + 1])) &&
            std::isxdigit(static_cast<unsigned char>(value[i + 2])))
        {
            out.push_back(static_cast<char>(std::stoi(std::string(value.substr(i + 1, 2)), nullptr, 16)));
            i += 2;
        }
        else
            out.push_back(value[i]);
    }
    return out;
}

/** Splits a multipart/form-data body (held in memory) into its parts. */
std::vector<Part> parseMultipart(std::string_view body, std::string_view boundary)
{
    std::vector<Part> parts;
    const std::string delimiter = "--" + std::string(boundary);
    const std::string next = "\r\n" + delimiter;
    size_t pos = body.find(delimiter);
    while (pos != std::string_view::npos)
    {
        pos += delimiter.size();
        if (body.substr(pos, 2) == "--")
            break;
        size_t lineEnd = body.find("\r\n", pos);
        if (lineEnd == std::string_view::npos)
            break;
        size_t headersStart = lineEnd + 2;
        size_t contentStart;
        std::string_view headers;
        if (body.substr(headersStart, 2) == "\r\n")
            contentStart = headersStart + 2;
        else
        {
            size_t headersEnd = body.find("\r\n\r\n", headersStart);
            if (headersEnd == std::string_view::npos)
                break;
            headers = body.substr(headersStart, headersEnd - headersStart);
            contentStart = headersEnd + 4;
        }
        size_t contentEnd = body.find(next, contentStart);
        if (contentEnd == std::string_view::npos)
            break;

        Part part;
        bool named = false;
        size_t lineStart = 0;
        while (lineStart <= headers.size())
        {
            size_t end = headers.find("\r\n", lineStart);
            if (end == std::string_view::npos)
                end = headers.size();
            auto line = headers.substr(lineStart, end - lineStart);
            lineStart = end + 2;
            auto colon = line.find(':');
            if (colon == std::string_view::npos)
                continue;
            auto header = lower(jsTrim(line.substr(0, colon)));
            auto value = jsTrim(line.substr(colon + 1));
            if (header == "content-type")
                part.contentType = std::string(value);
            else if (header == "content-disposition")
            {
                std::optional<std::string> filename, extended;
                for (auto &[key, val] : dispositionParams(value))
                {
                    if (key == "name" && !named)
                    {
                        part.name = std::move(val);
                        named = true;
                    }
                    else if (key == "filename")
                        filename = std::move(val);
                    else if (key == "filename*")
                        extended = decodeExtendedValue(val);
                }
                part.isFile = filename.has_value() || extended.has_value();
                part.filename = extended ? *extended : filename.value_or("");
            }
        }
        part.content = body.substr(contentStart, contentEnd - contentStart);
        if (named)
            parts.push_back(std::move(part));
        pos = contentEnd + 2;
    }
    return parts;
}

/** The boundary parameter of a multipart Content-Type. */
std::string boundaryOf(std::string_view contentType)
{
    auto lowered = lower(contentType);
    auto pos = lowered.find("boundary=");
    if (pos == std::string::npos)
        return "";
    pos += 9;
    if (pos < contentType.size() && contentType[pos] == '"')
    {
        auto end = contentType.find('"', pos + 1);
        return std::string(contentType.substr(pos + 1, end == std::string_view::npos ? std::string_view::npos : end - pos - 1));
    }
    size_t end = pos;
    while (end < contentType.size() && contentType[end] != ';' && contentType[end] != ' ' && contentType[end] != '\t')
        ++end;
    return std::string(contentType.substr(pos, end - pos));
}

/** The type the content shows, from its first bytes; empty when not recognized. */
std::string_view detectType(std::string_view b)
{
    auto starts = [&](std::string_view sig, size_t offset = 0) { return b.substr(offset, sig.size()) == sig; };
    if (starts("\x89PNG\r\n\x1a\n"))
        return "image/png";
    if (starts("\xFF\xD8\xFF"))
        return "image/jpeg";
    if (starts("GIF87a") || starts("GIF89a"))
        return "image/gif";
    if (starts("RIFF") && starts("WEBP", 8))
        return "image/webp";
    if (starts("%PDF-"))
        return "application/pdf";
    if (starts("ID3"))
        return "audio/mpeg";
    return "";
}

/** A MIME type without parameters, in lower case. */
std::string essence(std::string_view type)
{
    auto semicolon = type.find(';');
    return lower(jsTrim(type.substr(0, semicolon)));
}

/** The base name, without control characters, cut to 255 UTF-16 code units. */
std::string sanitizeFilename(std::string_view name)
{
    auto slash = name.find_last_of("/\\");
    if (slash != std::string_view::npos)
        name = name.substr(slash + 1);
    std::string out;
    size_t units = 0;
    for (size_t i = 0; i < name.size();)
    {
        auto c = static_cast<unsigned char>(name[i]);
        size_t length = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 1;
        length = std::min(length, name.size() - i);
        if (c < 0x20 || c == 0x7F)
        {
            i += 1;
            continue;
        }
        size_t cost = length == 4 ? 2 : 1;
        if (units + cost > 255)
            break;
        units += cost;
        out.append(name.substr(i, length));
        i += length;
    }
    return out;
}

/** The lowercased extension with its dot, or empty (also for names like `.hidden`). */
std::string extensionOf(const std::string &filename)
{
    auto dot = filename.rfind('.');
    if (dot == std::string::npos || dot == 0)
        return "";
    return lower(filename.substr(dot));
}

Json::Value mediaJson(std::string id,
                      std::string createdAt,
                      std::string updatedAt,
                      std::string filename,
                      std::string mimeType,
                      double size)
{
    Json::Value media(Json::objectValue);
    media["url"] = "/media/" + id + "/file";
    media["id"] = std::move(id);
    media["createdAt"] = std::move(createdAt);
    media["updatedAt"] = std::move(updatedAt);
    media["filename"] = std::move(filename);
    media["mimeType"] = std::move(mimeType);
    media["size"] = numberValue(size);
    media["storage"] = "default";
    return media;
}

HttpResponsePtr invalidFile(std::string message)
{
    Details details{{"file", std::move(message)}};
    return errorResponse(drogon::k400BadRequest, "Invalid body", details);
}

HttpResponsePtr mediaNotFound()
{
    return errorResponse(drogon::k404NotFound, "Media not found");
}

Task<HttpResponsePtr> uploadMedia(HttpRequestPtr req)
{
    const auto &contentType = req->getHeader("content-type");
    if (!startsWithInsensitive(contentType, "multipart/form-data"))
        co_return errorResponse(drogon::k415UnsupportedMediaType, "Must be multipart/form-data");
    auto parts = parseMultipart(req->body(), boundaryOf(contentType));

    const Part *file = nullptr;
    for (const auto &part : parts)
        if (part.name == "file")
        {
            file = &part;
            break;
        }
    if (!file || !file->isFile)
        co_return invalidFile("Is required");

    // The type: a recognized format must match a declared type, unless that one is missing or generic.
    auto detected = detectType(file->content);
    auto declared = essence(file->contentType.value_or(""));
    std::string mimeType;
    if (detected.empty())
        mimeType = declared;
    else if (declared.empty() || declared == "application/octet-stream" || declared == detected)
        mimeType = detected;
    else
    {
        Details details{{"file", "Detected " + std::string(detected) + ", declared " + declared}};
        co_return errorResponse(drogon::k415UnsupportedMediaType, "File content does not match its type", details);
    }
    if (file->content.size() > kMaxFileSize)
        co_return errorResponse(drogon::k413RequestEntityTooLarge, "File too large");
    if (mimeType != "image/png" && mimeType != "image/jpeg")
        co_return invalidFile("File type not allowed");

    Details details;
    for (const auto &part : parts)
    {
        if (part.name == "file" ||
            std::any_of(details.begin(), details.end(), [&](const Detail &d) { return d.field == part.name; }))
            continue;
        static const std::vector<std::string_view> readOnly = {
            "id", "createdAt", "updatedAt", "filename", "mimeType", "size", "storage", "url"};
        bool isReadOnly = std::find(readOnly.begin(), readOnly.end(), part.name) != readOnly.end();
        details.push_back({part.name, isReadOnly ? "Field is read-only" : "Unknown field"});
    }
    if (!details.empty())
        co_return errorResponse(drogon::k400BadRequest, "Invalid body", details);

    // Store the bytes, then insert the row; remove the file if the insert fails.
    const auto id = uuidv7();
    const auto filename = sanitizeFilename(file->filename);
    const auto storageKey = "media/" + id + "/" + uuidv7() + extensionOf(filename);
    const std::filesystem::path path = std::filesystem::path(uploadDir()) / storageKey;
    std::filesystem::create_directories(path.parent_path());
    {
        std::FILE *out = std::fopen(path.c_str(), "wb");
        if (!out)
            throw std::runtime_error("cannot open " + path.string());
        bool ok = std::fwrite(file->content.data(), 1, file->content.size(), out) == file->content.size();
        ok = std::fclose(out) == 0 && ok;
        if (!ok)
            throw std::runtime_error("cannot write " + path.string());
    }
    const auto now = nowIso();
    const auto size = static_cast<double>(file->content.size());
    try
    {
        co_await db()->execSqlCoro(
            "INSERT INTO media (id, created_at, updated_at, filename, mime_type, size, storage, storage_key) "
            "VALUES ($1, $2, $2, $3, $4, $5, 'default', $6)",
            id, now, filename, mimeType, size, storageKey);
    }
    catch (...)
    {
        std::error_code ignored;
        std::filesystem::remove_all(path.parent_path(), ignored);
        throw;
    }
    co_return jsonResponse(mediaJson(id, now, now, filename, mimeType, size), drogon::k201Created);
}

Task<HttpResponsePtr> getMedia(HttpRequestPtr, std::string id)
{
    auto rows = co_await db()->execSqlCoro(
        "SELECT id, created_at, updated_at, filename, mime_type, size FROM media WHERE id = $1", id);
    if (rows.empty())
        co_return mediaNotFound();
    const auto &row = rows[0];
    co_return jsonResponse(mediaJson(row[0].as<std::string>(),
                                     pgTimestampToIso(row[1].as<std::string_view>()),
                                     pgTimestampToIso(row[2].as<std::string_view>()),
                                     row[3].as<std::string>(),
                                     row[4].as<std::string>(),
                                     std::strtod(row[5].c_str(), nullptr)));
}

Task<HttpResponsePtr> getMediaFile(HttpRequestPtr, std::string id)
{
    auto rows = co_await db()->execSqlCoro(
        "SELECT filename, mime_type, storage_key FROM media WHERE id = $1", id);
    if (rows.empty())
        co_return mediaNotFound();
    const auto &row = rows[0];
    auto path = (std::filesystem::path(uploadDir()) / row[2].as<std::string>()).string();
    auto resp = drogon::HttpResponse::newFileResponse(path, "", drogon::CT_NONE, row[1].as<std::string>());
    if (resp->statusCode() != drogon::k200OK)
        co_return mediaNotFound();
    std::string filename;
    const auto stored = row[0].as<std::string>();
    for (char c : stored)
        if (c != '"' && c != '\\' && static_cast<unsigned char>(c) >= 0x20)
            filename.push_back(c);
    resp->addHeader("Content-Disposition", "inline; filename=\"" + filename + "\"");
    co_return resp;
}
}  // namespace

void registerMediaRoutes()
{
    auto &app = drogon::app();
    app.registerHandler("/media", &uploadMedia, {Post});
    app.registerHandler("/media/{id}", &getMedia, {Get});
    app.registerHandler("/media/{id}/file", &getMediaFile, {Get});
}

}  // namespace bench
