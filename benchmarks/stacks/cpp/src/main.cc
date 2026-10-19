// Entry point: configuration from the environment, the Drogon application and its routes.
#include "records.h"

#include <drogon/orm/DbConfig.h>

#include <cstdlib>

namespace
{
std::string env(const char *name, std::string fallback)
{
    const char *value = std::getenv(name);
    return value && *value ? std::string(value) : std::move(fallback);
}

std::string percentDecode(std::string_view s)
{
    std::string out;
    for (size_t i = 0; i < s.size(); ++i)
    {
        if (s[i] == '%' && i + 2 < s.size())
        {
            out.push_back(static_cast<char>(std::stoi(std::string(s.substr(i + 1, 2)), nullptr, 16)));
            i += 2;
        }
        else
            out.push_back(s[i]);
    }
    return out;
}

/** The connection settings from DATABASE_URL (postgres://user:password@host:port/database) or DB_*. */
drogon::orm::PostgresConfig databaseConfig(size_t connections)
{
    drogon::orm::PostgresConfig config{
        .host = env("DB_HOST", "localhost"),
        .port = static_cast<unsigned short>(std::stoi(env("DB_PORT", "55432"))),
        .databaseName = env("DB_NAME", "bench"),
        .username = env("DB_USER", "bench"),
        .password = env("DB_PASSWORD", "bench"),
        .connectionNumber = connections,
        .name = "default",
        // Not a "fast" (per-IO-thread) client: Drogon also gives the main loop one, which would open a third
        // set of connections; the shared client keeps the total at exactly DB_POOL_SIZE.
        .isFast = false,
        .characterSet = "",
        .timeout = -1.0,
        .autoBatch = false,
        // Timestamps come back as "2026-01-01 00:00:00+00", converted to ISO 8601 without a time zone lookup.
        .connectOptions = {{"TimeZone", "UTC"}},
    };
    std::string url = env("DATABASE_URL", "");
    auto scheme = url.find("://");
    if (scheme == std::string::npos)
        return config;
    std::string_view rest = std::string_view(url).substr(scheme + 3);
    auto slash = rest.find('/');
    auto authority = rest.substr(0, slash);
    if (slash != std::string_view::npos)
    {
        auto database = rest.substr(slash + 1);
        database = database.substr(0, database.find('?'));
        if (!database.empty())
            config.databaseName = percentDecode(database);
    }
    auto at = authority.rfind('@');
    if (at != std::string_view::npos)
    {
        auto credentials = authority.substr(0, at);
        authority = authority.substr(at + 1);
        auto colon = credentials.find(':');
        config.username = percentDecode(credentials.substr(0, colon));
        if (colon != std::string_view::npos)
            config.password = percentDecode(credentials.substr(colon + 1));
    }
    auto colon = authority.rfind(':');
    if (colon != std::string_view::npos && authority.find(']') == std::string_view::npos)
    {
        config.port = static_cast<unsigned short>(std::stoi(std::string(authority.substr(colon + 1))));
        authority = authority.substr(0, colon);
    }
    if (!authority.empty())
        config.host = std::string(authority);
    return config;
}
}  // namespace

int main()
{
    using namespace drogon;

    // The container has 2 CPUs: one HTTP event loop per CPU (hardware_concurrency would report the host's CPUs).
    const size_t threads = std::max(1, std::stoi(env("IO_THREADS", "2")));
    const size_t poolSize = std::max(1, std::stoi(env("DB_POOL_SIZE", "10")));
    const auto port = static_cast<uint16_t>(std::stoi(env("PORT", "8080")));
    bench::setUploadDir(env("UPLOAD_DIR", "./uploads"));

    bench::registerUserRoutes();
    bench::registerOrganizationRoutes();
    bench::registerMediaRoutes();
    app().registerHandler(
        "/health",
        [](const HttpRequestPtr &, std::function<void(const HttpResponsePtr &)> &&callback) {
            Json::Value body(Json::objectValue);
            body["ok"] = true;
            callback(HttpResponse::newHttpJsonResponse(body));
        },
        {Get});

    app()
        .setThreadNum(threads)
        .addListener("0.0.0.0", port)
        .addDbClient(databaseConfig(poolSize))
        // Uploads up to 1 MiB plus the multipart framing reach the handler and stay in memory.
        .setClientMaxBodySize(8 * 1024 * 1024)
        .setClientMaxMemoryBodySize(8 * 1024 * 1024)
        // No static files: every path is an API route or a JSON 404.
        .setFileTypes({})
        .setDefaultHandler([](const HttpRequestPtr &, std::function<void(const HttpResponsePtr &)> &&callback) {
            callback(bench::errorResponse(k404NotFound, "Route not found"));
        })
        .setExceptionHandler([](const std::exception &e,
                                const HttpRequestPtr &,
                                std::function<void(const HttpResponsePtr &)> &&callback) {
            LOG_ERROR << e.what();
            callback(bench::errorResponse(k500InternalServerError, "Internal server error"));
        })
        .run();
    return 0;
}
