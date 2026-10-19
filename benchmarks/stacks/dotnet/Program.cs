using System.Net;
using System.Text;
using Npgsql;
using QsBench;

var builder = WebApplication.CreateSlimBuilder(args);
var port = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out var p) ? p : 8080;
builder.WebHost.ConfigureKestrel(options =>
{
    options.Listen(IPAddress.Any, port);
    // File names in Content-Disposition may be non-ASCII.
    options.ResponseHeaderEncodingSelector = _ => Encoding.UTF8;
});
builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(5));

var app = builder.Build();
var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("QsBench");

// Contract errors (ApiError) and unexpected failures become the JSON error body.
app.Use(async (ctx, next) =>
{
    try
    {
        await next(ctx);
    }
    catch (ApiError e)
    {
        if (ctx.Response.HasStarted) throw;
        ctx.Response.Clear();
        await Json.Error(ctx, e.Status, e.Message, e.Details);
    }
    catch (BadHttpRequestException e) when (!ctx.Response.HasStarted)
    {
        ctx.Response.Clear();
        await Json.Error(ctx, e.StatusCode, e.StatusCode == 413 ? "Payload too large" : "Bad request");
    }
    catch (Exception e) when (!ctx.Response.HasStarted && !ctx.RequestAborted.IsCancellationRequested)
    {
        logger.LogError(e, "Unhandled error on {Method} {Path}", ctx.Request.Method, ctx.Request.Path);
        ctx.Response.Clear();
        await Json.Error(ctx, 500, "Internal server error");
    }
});

app.MapGet("/health", (RequestDelegate)(ctx => Json.Send(ctx, 200, new Health(true), AppJson.Default.Health)));

app.MapGet("/users", (RequestDelegate)Users.List);
app.MapPost("/users", (RequestDelegate)Users.Create);
app.MapGet("/users/{id}", (RequestDelegate)Users.Get);
app.MapPatch("/users/{id}", (RequestDelegate)Users.Update);
app.MapDelete("/users/{id}", (RequestDelegate)Users.Delete);

app.MapGet("/organizations", (RequestDelegate)Organizations.List);
app.MapGet("/organizations/{id}", (RequestDelegate)Organizations.Get);
app.MapGet("/organizations/{orgId}/stats", (RequestDelegate)Organizations.GetStats);

app.MapPost("/media", (RequestDelegate)Media.Upload);
app.MapGet("/media/{id}", (RequestDelegate)Media.Get);
app.MapGet("/media/{id}/file", (RequestDelegate)Media.GetFile);

app.MapFallback((RequestDelegate)(ctx => Json.Error(ctx, 404, "Route not found")));

app.Lifetime.ApplicationStopped.Register(() => Program.DataSource.Dispose());
app.Run();

public partial class Program
{
    public static readonly NpgsqlDataSource DataSource = Db.Create();
}
