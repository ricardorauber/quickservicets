using System.Buffers;
using System.Collections.Concurrent;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace QsBench;

public sealed record Detail(string Field, string Message);

public sealed record ErrorInfo(
    string Code,
    string Message,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<Detail>? Details);

public sealed record ErrorBody(ErrorInfo Error);

public sealed record Health(bool Ok);

public sealed record Stats(long Members, long Admins, double? AverageAge);

/** System.Text.Json source generation for the fixed-shape bodies; records with field selection are written by hand. */
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ErrorBody))]
[JsonSerializable(typeof(Health))]
[JsonSerializable(typeof(Stats))]
public sealed partial class AppJson : JsonSerializerContext;

/** An error that becomes the contract's error body. */
public sealed class ApiError(int status, string message, IReadOnlyList<Detail>? details = null) : Exception(message)
{
    public int Status { get; } = status;
    public IReadOnlyList<Detail>? Details { get; } = details;

    public static string CodeFor(int status) => status switch
    {
        400 => "VALIDATION_ERROR",
        404 => "NOT_FOUND",
        409 => "CONFLICT",
        413 => "PAYLOAD_TOO_LARGE",
        415 => "UNSUPPORTED_MEDIA_TYPE",
        _ => "INTERNAL_ERROR",
    };

    public static ApiError InvalidBody(params Detail[] details) => new(400, "Invalid body", details);
}

/** A pooled output buffer with its JSON writer: responses are built in memory, then sent with a Content-Length. */
public sealed class JsonBuffer
{
    private static readonly ConcurrentQueue<JsonBuffer> Pool = new();
    private static readonly JsonWriterOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, SkipValidation = true };
    private const int MaxRetainedBytes = 256 * 1024;

    private readonly ArrayBufferWriter<byte> _buffer = new(8 * 1024);
    public Utf8JsonWriter Writer { get; }

    private JsonBuffer() => Writer = new Utf8JsonWriter(_buffer, Options);

    public static JsonBuffer Rent()
    {
        if (!Pool.TryDequeue(out var buffer)) buffer = new JsonBuffer();
        return buffer;
    }

    /** Sends the written JSON and returns the buffer to the pool. */
    public async Task SendAsync(HttpContext ctx, int status)
    {
        try
        {
            Writer.Flush();
            var response = ctx.Response;
            response.StatusCode = status;
            response.ContentType = "application/json; charset=utf-8";
            response.ContentLength = _buffer.WrittenCount;
            response.BodyWriter.Write(_buffer.WrittenSpan);
            await response.BodyWriter.FlushAsync();
        }
        finally
        {
            Return();
        }
    }

    public void Return()
    {
        if (_buffer.Capacity > MaxRetainedBytes) return;
        _buffer.ResetWrittenCount();
        Writer.Reset(_buffer);
        Pool.Enqueue(this);
    }
}

public static class Json
{
    public static Task Send<T>(HttpContext ctx, int status, T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type)
    {
        var buffer = JsonBuffer.Rent();
        JsonSerializer.Serialize(buffer.Writer, value, type);
        return buffer.SendAsync(ctx, status);
    }

    public static Task Error(HttpContext ctx, int status, string message, IReadOnlyList<Detail>? details = null) =>
        Send(ctx, status, new ErrorBody(new ErrorInfo(ApiError.CodeFor(status), message, details)), AppJson.Default.ErrorBody);

    /** Writes a UTC timestamp as JavaScript's toISOString does: 2026-10-19T16:04:45.600Z. */
    public static void WriteTimestamp(Utf8JsonWriter writer, JsonEncodedText name, DateTime value)
    {
        Span<byte> s = stackalloc byte[24];
        var utc = value.Kind == DateTimeKind.Local ? value.ToUniversalTime() : value;
        Four(s, 0, utc.Year);
        s[4] = (byte)'-';
        Two(s, 5, utc.Month);
        s[7] = (byte)'-';
        Two(s, 8, utc.Day);
        s[10] = (byte)'T';
        Two(s, 11, utc.Hour);
        s[13] = (byte)':';
        Two(s, 14, utc.Minute);
        s[16] = (byte)':';
        Two(s, 17, utc.Second);
        s[19] = (byte)'.';
        var ms = utc.Millisecond;
        s[20] = (byte)('0' + ms / 100);
        s[21] = (byte)('0' + ms / 10 % 10);
        s[22] = (byte)('0' + ms % 10);
        s[23] = (byte)'Z';
        writer.WriteString(name, s);
    }

    private static void Two(Span<byte> s, int at, int v)
    {
        s[at] = (byte)('0' + v / 10);
        s[at + 1] = (byte)('0' + v % 10);
    }

    private static void Four(Span<byte> s, int at, int v)
    {
        s[at] = (byte)('0' + v / 1000);
        s[at + 1] = (byte)('0' + v / 100 % 10);
        s[at + 2] = (byte)('0' + v / 10 % 10);
        s[at + 3] = (byte)('0' + v % 10);
    }

    /** The current time truncated to milliseconds, so that what is stored and what is returned are equal. */
    public static DateTime Now()
    {
        var ticks = DateTime.UtcNow.Ticks;
        return new DateTime(ticks - ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
    }

    /** age and size are double precision columns; integral values are written as JSON integers. */
    public static void WriteNumber(Utf8JsonWriter writer, JsonEncodedText name, double value)
    {
        if (Math.Abs(value) < 9007199254740992 && value == Math.Floor(value)) writer.WriteNumber(name, (long)value);
        else writer.WriteNumber(name, value);
    }
}
