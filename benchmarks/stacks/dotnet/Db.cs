using Npgsql;

namespace QsBench;

public static class Db
{
    /** One pool of DB_POOL_SIZE connections for the whole process (one process per container). */
    public static NpgsqlDataSource Create()
    {
        var csb = new NpgsqlConnectionStringBuilder();
        var url = Environment.GetEnvironmentVariable("DATABASE_URL");
        if (!string.IsNullOrEmpty(url))
        {
            var uri = new Uri(url);
            var user = uri.UserInfo.Split(':', 2);
            csb.Host = uri.Host;
            csb.Port = uri.Port > 0 ? uri.Port : 5432;
            csb.Username = Uri.UnescapeDataString(user[0]);
            if (user.Length > 1) csb.Password = Uri.UnescapeDataString(user[1]);
            csb.Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/'));
        }
        else
        {
            csb.Host = Env("DB_HOST", "localhost");
            csb.Port = int.Parse(Env("DB_PORT", "5432"));
            csb.Username = Env("DB_USER", "bench");
            csb.Password = Env("DB_PASSWORD", "bench");
            csb.Database = Env("DB_NAME", "bench");
        }
        csb.MaxPoolSize = int.Parse(Env("DB_POOL_SIZE", "10"));
        csb.MinPoolSize = 0;
        // Npgsql's documented performance settings: prepare the statements this service repeats, and skip the
        // DISCARD ALL on returning a connection to the pool (the service never changes session state).
        csb.MaxAutoPrepare = 64;
        csb.AutoPrepareMinUsages = 2;
        csb.NoResetOnClose = true;
        // The server offers no GSSAPI encryption; skip the attempt (and the libgssapi probe) on every new connection.
        csb.GssEncryptionMode = GssEncryptionMode.Disable;
        csb.ApplicationName = "qsbench-dotnet";
        return new NpgsqlDataSourceBuilder(csb.ConnectionString).Build();
    }

    private static string Env(string name, string fallback) =>
        Environment.GetEnvironmentVariable(name) is { Length: > 0 } value ? value : fallback;
}
