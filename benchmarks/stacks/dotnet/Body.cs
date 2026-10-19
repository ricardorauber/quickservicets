using System.Text.Json;

namespace QsBench;

public static class Body
{
    /**
     * Reads the whole request body and hands its root object to `parse`. The document points into the request
     * buffer, so `parse` must copy what it keeps before this returns.
     */
    public static async Task<T> ReadObject<T>(HttpContext ctx, Func<JsonElement, T> parse)
    {
        var reader = ctx.Request.BodyReader;
        while (true)
        {
            var result = await reader.ReadAsync();
            var buffer = result.Buffer;
            if (!result.IsCompleted)
            {
                reader.AdvanceTo(buffer.Start, buffer.End);
                continue;
            }
            try
            {
                JsonDocument document;
                try
                {
                    document = JsonDocument.Parse(buffer);
                }
                catch (Exception e) when (e is JsonException or ArgumentException)
                {
                    throw new ApiError(400, "Invalid JSON body");
                }
                using (document)
                {
                    if (document.RootElement.ValueKind != JsonValueKind.Object)
                        throw ApiError.InvalidBody(new Detail("", "Body must be a JSON object"));
                    return parse(document.RootElement);
                }
            }
            finally
            {
                reader.AdvanceTo(buffer.End);
            }
        }
    }
}
