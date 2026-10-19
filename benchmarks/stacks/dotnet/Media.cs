using System.Buffers;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Net.Http.Headers;
using Npgsql;

namespace QsBench;

public static class Media
{
    private const int MaxSize = 1024 * 1024;
    private static readonly string[] ReadOnlyFields = ["id", "createdAt", "updatedAt", "filename", "mimeType", "size", "storage", "url"];
    private static readonly string[] AcceptedTypes = ["image/png", "image/jpeg"];

    public static readonly string UploadDir = Path.GetFullPath(
        Environment.GetEnvironmentVariable("UPLOAD_DIR") is { Length: > 0 } dir ? dir : "uploads");

    private static readonly JsonEncodedText Id = JsonEncodedText.Encode("id");
    private static readonly JsonEncodedText CreatedAt = JsonEncodedText.Encode("createdAt");
    private static readonly JsonEncodedText UpdatedAt = JsonEncodedText.Encode("updatedAt");
    private static readonly JsonEncodedText Filename = JsonEncodedText.Encode("filename");
    private static readonly JsonEncodedText MimeType = JsonEncodedText.Encode("mimeType");
    private static readonly JsonEncodedText Size = JsonEncodedText.Encode("size");
    private static readonly JsonEncodedText Storage = JsonEncodedText.Encode("storage");
    private static readonly JsonEncodedText Url = JsonEncodedText.Encode("url");

    private static void Write(Utf8JsonWriter w, string id, DateTime createdAt, DateTime updatedAt, string filename, string mimeType, double size, string storage)
    {
        w.WriteStartObject();
        w.WriteString(Id, id);
        Json.WriteTimestamp(w, CreatedAt, createdAt);
        Json.WriteTimestamp(w, UpdatedAt, updatedAt);
        w.WriteString(Filename, filename);
        w.WriteString(MimeType, mimeType);
        Json.WriteNumber(w, Size, size);
        w.WriteString(Storage, storage);
        w.WriteString(Url, $"/media/{id}/file");
        w.WriteEndObject();
    }

    // POST /media
    public static async Task Upload(HttpContext ctx)
    {
        var contentType = ctx.Request.ContentType ?? "";
        if (!contentType.StartsWith("multipart/form-data", StringComparison.OrdinalIgnoreCase))
            throw new ApiError(415, "Must be multipart/form-data");
        var boundary = MediaTypeHeaderValue.TryParse(contentType, out var mediaType)
            ? HeaderUtilities.RemoveQuotes(mediaType.Boundary).ToString()
            : "";
        if (boundary.Length == 0) throw FileRequired();

        byte[]? data = null;
        try
        {
            var size = 0;
            string? declared = null, originalName = null;
            var sawFile = false;
            var others = new List<string>();
            try
            {
                var reader = new MultipartReader(boundary, ctx.Request.Body);
                while (await reader.ReadNextSectionAsync() is { } section)
                {
                    if (!ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition)) continue;
                    var name = HeaderUtilities.RemoveQuotes(disposition.Name).ToString();
                    if (name != "file")
                    {
                        if (!others.Contains(name)) others.Add(name);
                        continue;
                    }
                    // Like FormData.get: the first part named "file" decides, and it must be a file.
                    if (sawFile) continue;
                    sawFile = true;
                    if (!disposition.FileName.HasValue && !disposition.FileNameStar.HasValue) continue;
                    originalName = disposition.FileNameStar.HasValue
                        ? disposition.FileNameStar.ToString()
                        : HeaderUtilities.UnescapeAsQuotedString(disposition.FileName).ToString();
                    declared = section.ContentType ?? "";
                    (data, size) = await ReadLimited(section.Body);
                }
            }
            catch (Exception e) when (e is IOException or InvalidDataException)
            {
                throw FileRequired();
            }
            if (data is null) throw FileRequired();

            // Type: the content's format wins over a missing or generic declared type, and must match any other.
            var detected = Detect(data.AsSpan(0, size));
            var essence = declared!.Split(';')[0].Trim().ToLowerInvariant();
            string type;
            if (detected is null) type = essence;
            else if (essence is "" or "application/octet-stream" || essence == detected) type = detected;
            else throw new ApiError(415, "File content does not match its type", [new Detail("file", $"Detected {detected}, declared {essence}")]);

            if (size > MaxSize) throw new ApiError(413, "File too large");
            if (Array.IndexOf(AcceptedTypes, type) < 0) throw ApiError.InvalidBody(new Detail("file", "File type not allowed"));
            if (others.Count > 0)
                throw new ApiError(400, "Invalid body", others
                    .Select(name => new Detail(name, Array.IndexOf(ReadOnlyFields, name) >= 0 ? "Field is read-only" : "Unknown field"))
                    .ToList());

            var id = Guid.CreateVersion7().ToString();
            var filename = SanitizeFilename(originalName ?? "file");
            var storageKey = $"media/{id}/{Guid.CreateVersion7()}{ExtensionOf(filename)}";
            var path = Path.Combine(UploadDir, storageKey);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllBytesAsync(path, data.AsMemory(0, size));

            var now = Json.Now();
            try
            {
                await using var cmd = Program.DataSource.CreateCommand(
                    "INSERT INTO media (id, created_at, updated_at, filename, mime_type, size, storage, storage_key) VALUES ($1, $2, $2, $3, $4, $5, 'default', $6)");
                cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = id });
                cmd.Parameters.Add(new NpgsqlParameter<DateTime> { TypedValue = now });
                cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = filename });
                cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = type });
                cmd.Parameters.Add(new NpgsqlParameter<double> { TypedValue = size });
                cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = storageKey });
                await cmd.ExecuteNonQueryAsync();
            }
            catch
            {
                File.Delete(path);
                throw;
            }

            var buffer = JsonBuffer.Rent();
            Write(buffer.Writer, id, now, now, filename, type, size, "default");
            await buffer.SendAsync(ctx, 201);
        }
        finally
        {
            if (data is not null) ArrayPool<byte>.Shared.Return(data);
        }
    }

    /** Reads a part into a pooled buffer, stopping once it is known to be over the limit. */
    private static async Task<(byte[] Data, int Size)> ReadLimited(Stream body)
    {
        var data = ArrayPool<byte>.Shared.Rent(64 * 1024);
        var size = 0;
        while (size <= MaxSize)
        {
            if (size == data.Length)
            {
                var larger = ArrayPool<byte>.Shared.Rent(Math.Min(data.Length * 2, MaxSize + 1));
                data.AsSpan(0, size).CopyTo(larger);
                ArrayPool<byte>.Shared.Return(data);
                data = larger;
            }
            var read = await body.ReadAsync(data.AsMemory(size, Math.Min(data.Length, MaxSize + 1) - size));
            if (read == 0) break;
            size += read;
        }
        return (data, size);
    }

    /** Magic bytes of the formats the contract requires. */
    private static string? Detect(ReadOnlySpan<byte> head)
    {
        if (head.StartsWith((ReadOnlySpan<byte>)[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return "image/png";
        if (head.StartsWith((ReadOnlySpan<byte>)[0xFF, 0xD8, 0xFF])) return "image/jpeg";
        if (head.StartsWith("GIF87a"u8) || head.StartsWith("GIF89a"u8)) return "image/gif";
        if (head.Length >= 12 && head.StartsWith("RIFF"u8) && head.Slice(8, 4).SequenceEqual("WEBP"u8)) return "image/webp";
        if (head.StartsWith("%PDF-"u8)) return "application/pdf";
        return null;
    }

    /** The base name, without control characters, cut to 255 characters. */
    private static string SanitizeFilename(string name)
    {
        var start = name.LastIndexOfAny(['/', '\\']) + 1;
        var builder = new StringBuilder(name.Length - start);
        foreach (var c in name.AsSpan(start))
            if (c >= 0x20 && c != 0x7f) builder.Append(c);
        return builder.Length > 255 ? builder.ToString(0, 255) : builder.ToString();
    }

    private static string ExtensionOf(string filename)
    {
        var dot = filename.LastIndexOf('.');
        return dot > 0 ? filename[dot..].ToLowerInvariant() : "";
    }

    private static ApiError FileRequired() => ApiError.InvalidBody(new Detail("file", "Is required"));

    private static ApiError NotFound() => new(404, "Media not found");

    // GET /media/{id}
    public static async Task Get(HttpContext ctx)
    {
        var id = (string)ctx.Request.RouteValues["id"]!;
        var buffer = JsonBuffer.Rent();
        await using (var cmd = Program.DataSource.CreateCommand(
            "SELECT id, created_at, updated_at, filename, mime_type, size, storage FROM media WHERE id = $1"))
        {
            cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = id });
            await using var reader = await cmd.ExecuteReaderAsync();
            if (!await reader.ReadAsync())
            {
                buffer.Return();
                throw NotFound();
            }
            Write(buffer.Writer, reader.GetString(0), reader.GetDateTime(1), reader.GetDateTime(2), reader.GetString(3),
                reader.GetString(4), reader.GetDouble(5), reader.GetString(6));
        }
        await buffer.SendAsync(ctx, 200);
    }

    // GET /media/{id}/file
    public static async Task GetFile(HttpContext ctx)
    {
        var id = (string)ctx.Request.RouteValues["id"]!;
        string filename, mimeType, storageKey;
        long size;
        await using (var cmd = Program.DataSource.CreateCommand("SELECT filename, mime_type, size, storage_key FROM media WHERE id = $1"))
        {
            cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = id });
            await using var reader = await cmd.ExecuteReaderAsync();
            if (!await reader.ReadAsync()) throw NotFound();
            (filename, mimeType, size, storageKey) = (reader.GetString(0), reader.GetString(1), (long)reader.GetDouble(2), reader.GetString(3));
        }
        var path = Path.Combine(UploadDir, storageKey);
        if (!File.Exists(path)) throw NotFound();

        var safe = new StringBuilder(filename.Length);
        foreach (var c in filename)
            if (c >= 0x20 && c != '"' && c != '\\') safe.Append(c);
        var response = ctx.Response;
        response.StatusCode = 200;
        response.ContentType = mimeType;
        response.ContentLength = size;
        response.Headers.ContentDisposition = $"inline; filename=\"{safe}\"";
        await response.SendFileAsync(path);
    }
}
