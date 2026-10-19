using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Npgsql;
using NpgsqlTypes;

namespace QsBench;

public static partial class Users
{
    public static readonly string[] Roles = ["member", "admin"];

    public static readonly EntityDef Entity = new()
    {
        Table = "users",
        Fields =
        [
            new("id", "id", FieldType.Id, 0),
            new("createdAt", "created_at", FieldType.Date, 1),
            new("updatedAt", "updated_at", FieldType.Date, 2),
            new("email", "email", FieldType.String, 3),
            new("name", "name", FieldType.String, 4),
            new("role", "role", FieldType.Enum, 5, Values: Roles),
            new("age", "age", FieldType.Number, 6),
        ],
    };

    public const int All = 0b111_1111;
    public const string AllColumns = "id, created_at, updated_at, email, name, role, age";

    private static readonly JsonEncodedText Id = JsonEncodedText.Encode("id");
    private static readonly JsonEncodedText CreatedAt = JsonEncodedText.Encode("createdAt");
    private static readonly JsonEncodedText UpdatedAt = JsonEncodedText.Encode("updatedAt");
    private static readonly JsonEncodedText Email = JsonEncodedText.Encode("email");
    private static readonly JsonEncodedText Name = JsonEncodedText.Encode("name");
    private static readonly JsonEncodedText Role = JsonEncodedText.Encode("role");
    private static readonly JsonEncodedText Age = JsonEncodedText.Encode("age");

    /** The select list for a field mask, cached: columns in field order. */
    private static readonly string[] ColumnsByMask = Enumerable.Range(0, All + 1)
        .Select(mask => string.Join(", ", Entity.Fields.Where(f => (mask & (1 << f.Bit)) != 0).Select(f => f.Column)))
        .ToArray();

    /** Writes the user whose selected columns start at `ordinal`; returns the ordinal after them. */
    public static int Write(Utf8JsonWriter w, NpgsqlDataReader r, int mask, int ordinal)
    {
        w.WriteStartObject();
        if ((mask & 1) != 0) w.WriteString(Id, r.GetString(ordinal++));
        if ((mask & 2) != 0) Json.WriteTimestamp(w, CreatedAt, r.GetDateTime(ordinal++));
        if ((mask & 4) != 0) Json.WriteTimestamp(w, UpdatedAt, r.GetDateTime(ordinal++));
        if ((mask & 8) != 0) w.WriteString(Email, r.GetString(ordinal++));
        if ((mask & 16) != 0) w.WriteString(Name, r.GetString(ordinal++));
        if ((mask & 32) != 0) w.WriteString(Role, r.GetString(ordinal++));
        if ((mask & 64) != 0)
        {
            if (r.IsDBNull(ordinal)) w.WriteNull(Age);
            else Json.WriteNumber(w, Age, r.GetDouble(ordinal));
            ordinal++;
        }
        w.WriteEndObject();
        return ordinal;
    }

    private static void Write(Utf8JsonWriter w, string id, DateTime createdAt, DateTime updatedAt, string email, string name, string role, double? age)
    {
        w.WriteStartObject();
        w.WriteString(Id, id);
        Json.WriteTimestamp(w, CreatedAt, createdAt);
        Json.WriteTimestamp(w, UpdatedAt, updatedAt);
        w.WriteString(Email, email);
        w.WriteString(Name, name);
        w.WriteString(Role, role);
        if (age is { } value) Json.WriteNumber(w, Age, value);
        else w.WriteNull(Age);
        w.WriteEndObject();
    }

    // GET /users
    public static async Task List(HttpContext ctx)
    {
        var query = Query.Parse(ctx.Request);
        Query.ParsePopulate(Entity, query);
        var mask = Query.ParseFields(Entity, query);
        var list = Query.ParseList(Entity, query);

        var count = new NpgsqlBatchCommand();
        var countSql = new StringBuilder("SELECT count(*) FROM users");
        Query.AppendWhere(countSql, list.Where, count);
        count.CommandText = countSql.ToString();

        var page = new NpgsqlBatchCommand();
        var sql = new StringBuilder("SELECT ").Append(ColumnsByMask[mask]).Append(" FROM users");
        Query.AppendWhere(sql, list.Where, page);
        Query.AppendOrder(sql, list.Sort, "");
        Query.AppendPage(sql, list, page);
        page.CommandText = sql.ToString();

        var buffer = JsonBuffer.Rent();
        var w = buffer.Writer;
        await using (var batch = Program.DataSource.CreateBatch())
        {
            batch.BatchCommands.Add(count);
            batch.BatchCommands.Add(page);
            await using var reader = await batch.ExecuteReaderAsync();
            await reader.ReadAsync();
            var total = reader.GetInt64(0);
            await reader.NextResultAsync();
            w.WriteStartObject();
            w.WriteStartArray("data"u8);
            while (await reader.ReadAsync()) Write(w, reader, mask, 0);
            w.WriteEndArray();
            w.WriteNumber("total"u8, total);
            w.WriteNumber("limit"u8, list.Limit);
            w.WriteNumber("offset"u8, list.Offset);
            w.WriteEndObject();
        }
        await buffer.SendAsync(ctx, 200);
    }

    // GET /users/{id}
    public static async Task Get(HttpContext ctx)
    {
        var id = (string)ctx.Request.RouteValues["id"]!;
        var query = Query.Parse(ctx.Request);
        Query.ParsePopulate(Entity, query);
        var mask = Query.ParseFields(Entity, query);

        var buffer = JsonBuffer.Rent();
        await using (var cmd = Program.DataSource.CreateCommand($"SELECT {ColumnsByMask[mask]} FROM users WHERE id = $1"))
        {
            cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = id });
            await using var reader = await cmd.ExecuteReaderAsync();
            if (!await reader.ReadAsync())
            {
                buffer.Return();
                throw NotFound();
            }
            Write(buffer.Writer, reader, mask, 0);
        }
        await buffer.SendAsync(ctx, 200);
    }

    // POST /users
    public static async Task Create(HttpContext ctx)
    {
        var input = await Body.ReadObject(ctx, static root => UserInput.Parse(root, create: true));
        var id = Guid.CreateVersion7().ToString();
        var now = Json.Now();
        await using (var cmd = Program.DataSource.CreateCommand(
            "INSERT INTO users (id, created_at, updated_at, email, name, role, age) VALUES ($1, $2, $2, $3, $4, $5, $6)"))
        {
            cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = id });
            cmd.Parameters.Add(new NpgsqlParameter<DateTime> { TypedValue = now });
            cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = input.Email! });
            cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = input.Name! });
            cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = input.Role ?? "member" });
            cmd.Parameters.Add(AgeParameter(input.Age));
            try
            {
                await cmd.ExecuteNonQueryAsync();
            }
            catch (PostgresException e) when (IsEmailConflict(e))
            {
                throw Conflict();
            }
        }
        var buffer = JsonBuffer.Rent();
        Write(buffer.Writer, id, now, now, input.Email!, input.Name!, input.Role ?? "member", input.Age);
        await buffer.SendAsync(ctx, 201);
    }

    // PATCH /users/{id}
    public static async Task Update(HttpContext ctx)
    {
        var input = await Body.ReadObject(ctx, static root => UserInput.Parse(root, create: false));
        var id = (string)ctx.Request.RouteValues["id"]!;
        var sql = new StringBuilder("UPDATE users SET updated_at = $1");
        await using var cmd = Program.DataSource.CreateCommand();
        cmd.Parameters.Add(new NpgsqlParameter<DateTime> { TypedValue = Json.Now() });
        if (input.HasEmail) Set(sql, cmd, "email", new NpgsqlParameter<string> { TypedValue = input.Email! });
        if (input.HasName) Set(sql, cmd, "name", new NpgsqlParameter<string> { TypedValue = input.Name! });
        if (input.HasRole) Set(sql, cmd, "role", new NpgsqlParameter<string> { TypedValue = input.Role! });
        if (input.HasAge) Set(sql, cmd, "age", AgeParameter(input.Age));
        cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = id });
        sql.Append(" WHERE id = $").Append(cmd.Parameters.Count).Append(" RETURNING ").Append(AllColumns);
        cmd.CommandText = sql.ToString();

        var buffer = JsonBuffer.Rent();
        try
        {
            await using var reader = await cmd.ExecuteReaderAsync();
            if (!await reader.ReadAsync()) throw NotFound();
            Write(buffer.Writer, reader, All, 0);
        }
        catch (PostgresException e) when (IsEmailConflict(e))
        {
            buffer.Return();
            throw Conflict();
        }
        catch (ApiError)
        {
            buffer.Return();
            throw;
        }
        await buffer.SendAsync(ctx, 200);
    }

    // DELETE /users/{id}: one statement, so the delete and the organizations' updatedAt change are atomic. The
    // membership rows cascade through the foreign key; the remaining members keep their positions (and order).
    public static async Task Delete(HttpContext ctx)
    {
        var id = (string)ctx.Request.RouteValues["id"]!;
        await using var cmd = Program.DataSource.CreateCommand("""
            WITH deleted AS (DELETE FROM users WHERE id = $1 RETURNING id),
            touched AS (
              UPDATE organizations SET updated_at = $2
              WHERE id IN (SELECT m.owner_id FROM organizations__members m JOIN deleted d ON m.target_id = d.id)
            )
            SELECT count(*) FROM deleted
            """);
        cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = id });
        cmd.Parameters.Add(new NpgsqlParameter<DateTime> { TypedValue = Json.Now() });
        var deleted = (long)(await cmd.ExecuteScalarAsync())!;
        if (deleted == 0) throw NotFound();
        ctx.Response.StatusCode = 204;
    }

    private static void Set(StringBuilder sql, NpgsqlCommand cmd, string column, NpgsqlParameter parameter)
    {
        cmd.Parameters.Add(parameter);
        sql.Append(", ").Append(column).Append(" = $").Append(cmd.Parameters.Count);
    }

    private static NpgsqlParameter AgeParameter(double? age) =>
        new() { NpgsqlDbType = NpgsqlDbType.Double, Value = age is { } value ? value : DBNull.Value };

    private static bool IsEmailConflict(PostgresException e) =>
        e.SqlState == PostgresErrorCodes.UniqueViolation && e.ConstraintName == "users_email_uq";

    private static ApiError NotFound() => new(404, "User not found");

    private static ApiError Conflict() =>
        new(409, "Value already exists", [new Detail("email", "Value already exists")]);

    // JavaScript's \s, spelled out (.NET's \s differs on U+0085 and U+FEFF), and \z rather than $ (which in .NET
    // also matches before a final newline).
    [GeneratedRegex(@"^[^\t\n\v\f\r    -     　﻿@]+@[^\t\n\v\f\r    -     　﻿@]+\.[^\t\n\v\f\r    -     　﻿@]+\z", RegexOptions.CultureInvariant)]
    public static partial Regex EmailPattern();
}

/** A validated POST or PATCH body for a user. */
public sealed class UserInput
{
    public bool HasEmail, HasName, HasRole, HasAge;
    public string? Email, Name, Role;
    public double? Age;

    public static UserInput Parse(JsonElement root, bool create)
    {
        JsonElement email = default, name = default, role = default, age = default;
        var details = new List<Detail>();
        List<Detail>? extra = null;
        foreach (var property in root.EnumerateObject())
        {
            switch (property.Name)
            {
                case "email": email = property.Value; break;
                case "name": name = property.Value; break;
                case "role": role = property.Value; break;
                case "age": age = property.Value; break;
                case "id" or "createdAt" or "updatedAt": AddOnce(ref extra, property.Name, "Field is read-only"); break;
                default: AddOnce(ref extra, property.Name, "Unknown field"); break;
            }
        }

        var input = new UserInput();
        // A default JsonElement has ValueKind Undefined: the key was absent.
        if (email.ValueKind == JsonValueKind.Undefined)
        {
            if (create) details.Add(new Detail("email", "Is required"));
        }
        else if (email.ValueKind == JsonValueKind.Null) details.Add(new Detail("email", "Cannot be null"));
        else if (email.ValueKind != JsonValueKind.String) details.Add(new Detail("email", "Must be a string"));
        else
        {
            var value = email.GetString()!;
            if (!Users.EmailPattern().IsMatch(value)) details.Add(new Detail("email", "Must be a valid email"));
            else (input.HasEmail, input.Email) = (true, value);
        }

        if (name.ValueKind == JsonValueKind.Undefined)
        {
            if (create) details.Add(new Detail("name", "Is required"));
        }
        else if (name.ValueKind == JsonValueKind.Null) details.Add(new Detail("name", "Cannot be null"));
        else if (name.ValueKind != JsonValueKind.String) details.Add(new Detail("name", "Must be a string"));
        else
        {
            var value = name.GetString()!;
            if (value.Length < 1) details.Add(new Detail("name", "Must be at least 1 characters"));
            else if (value.Length > 100) details.Add(new Detail("name", "Must be at most 100 characters"));
            else (input.HasName, input.Name) = (true, value);
        }

        if (role.ValueKind == JsonValueKind.Undefined) { }
        else if (role.ValueKind == JsonValueKind.Null) details.Add(new Detail("role", "Cannot be null"));
        else if (role.ValueKind != JsonValueKind.String || Array.IndexOf(Users.Roles, role.GetString()) < 0)
            details.Add(new Detail("role", "Must be one of: member, admin"));
        else (input.HasRole, input.Role) = (true, role.GetString());

        if (age.ValueKind == JsonValueKind.Undefined) { }
        else if (age.ValueKind == JsonValueKind.Null) (input.HasAge, input.Age) = (true, null);
        else if (age.ValueKind != JsonValueKind.Number) details.Add(new Detail("age", "Must be a number"));
        else if (!age.TryGetDouble(out var value) || !double.IsFinite(value) || value != Math.Floor(value))
            details.Add(new Detail("age", "Must be an integer"));
        else if (value < 0) details.Add(new Detail("age", "Must be at least 0"));
        else if (value > 150) details.Add(new Detail("age", "Must be at most 150"));
        else (input.HasAge, input.Age) = (true, value == 0 ? 0 : value);

        if (extra is not null) details.AddRange(extra);
        if (details.Count > 0) throw new ApiError(400, "Invalid body", details);
        return input;
    }

    private static void AddOnce(ref List<Detail>? list, string field, string message)
    {
        list ??= [];
        if (!list.Exists(d => d.Field == field)) list.Add(new Detail(field, message));
    }
}
