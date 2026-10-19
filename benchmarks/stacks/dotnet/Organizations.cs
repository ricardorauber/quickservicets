using System.Text;
using System.Text.Json;
using Npgsql;

namespace QsBench;

public static class Organizations
{
    public static readonly EntityDef Entity = new()
    {
        Table = "organizations",
        Fields =
        [
            new("id", "id", FieldType.Id, 0),
            new("createdAt", "created_at", FieldType.Date, 1),
            new("updatedAt", "updated_at", FieldType.Date, 2),
            new("name", "name", FieldType.String, 3),
            new("slug", "slug", FieldType.String, 4),
            new("members", "members", FieldType.RefArray, 5, Sortable: false),
        ],
        PopulatablePaths = ["members"],
    };

    private const int MembersBit = 1 << 5;
    private const string Columns = "id, created_at, updated_at, name, slug";
    private const string MemberIds = "ARRAY(SELECT m.target_id FROM organizations__members m WHERE m.owner_id = organizations.id ORDER BY m.position)";
    private const string PopulatedColumns = "o.id, o.created_at, o.updated_at, o.name, o.slug, u.id, u.created_at, u.updated_at, u.email, u.name, u.role, u.age";
    // Inner join inside the left join: an organization without members still yields one row (with null user columns).
    private const string PopulatedJoin = "LEFT JOIN (organizations__members m JOIN users u ON u.id = m.target_id) ON m.owner_id = o.id";

    private static readonly JsonEncodedText Id = JsonEncodedText.Encode("id");
    private static readonly JsonEncodedText CreatedAt = JsonEncodedText.Encode("createdAt");
    private static readonly JsonEncodedText UpdatedAt = JsonEncodedText.Encode("updatedAt");
    private static readonly JsonEncodedText Name = JsonEncodedText.Encode("name");
    private static readonly JsonEncodedText Slug = JsonEncodedText.Encode("slug");
    private static readonly JsonEncodedText Members = JsonEncodedText.Encode("members");

    /** Writes the selected scalar fields of the organization in columns 0 to 4. */
    private static void WriteFields(Utf8JsonWriter w, NpgsqlDataReader r, int mask)
    {
        if ((mask & 1) != 0) w.WriteString(Id, r.GetString(0));
        if ((mask & 2) != 0) Json.WriteTimestamp(w, CreatedAt, r.GetDateTime(1));
        if ((mask & 4) != 0) Json.WriteTimestamp(w, UpdatedAt, r.GetDateTime(2));
        if ((mask & 8) != 0) w.WriteString(Name, r.GetString(3));
        if ((mask & 16) != 0) w.WriteString(Slug, r.GetString(4));
    }

    /** Writes the organizations of the current result: one row each, or one row per member when populated. */
    private static async Task<bool> WriteRows(Utf8JsonWriter w, NpgsqlDataReader r, int mask, bool populate)
    {
        var any = false;
        if (!populate)
        {
            while (await r.ReadAsync())
            {
                any = true;
                w.WriteStartObject();
                WriteFields(w, r, mask);
                if ((mask & MembersBit) != 0)
                {
                    w.WriteStartArray(Members);
                    foreach (var member in r.GetFieldValue<string[]>(5)) w.WriteStringValue(member);
                    w.WriteEndArray();
                }
                w.WriteEndObject();
            }
            return any;
        }

        string? current = null;
        while (await r.ReadAsync())
        {
            var id = r.GetString(0);
            if (id != current)
            {
                if (current is not null)
                {
                    w.WriteEndArray();
                    w.WriteEndObject();
                }
                current = id;
                any = true;
                w.WriteStartObject();
                WriteFields(w, r, mask);
                w.WriteStartArray(Members);
            }
            if (!r.IsDBNull(5)) Users.Write(w, r, Users.All, 5);
        }
        if (current is not null)
        {
            w.WriteEndArray();
            w.WriteEndObject();
        }
        return any;
    }

    // GET /organizations
    public static async Task List(HttpContext ctx)
    {
        var query = Query.Parse(ctx.Request);
        var populate = Query.ParsePopulate(Entity, query);
        var mask = Query.ParseFields(Entity, query);
        var list = Query.ParseList(Entity, query);
        populate &= (mask & MembersBit) != 0;

        var count = new NpgsqlBatchCommand();
        var countSql = new StringBuilder("SELECT count(*) FROM organizations");
        Query.AppendWhere(countSql, list.Where, count);
        count.CommandText = countSql.ToString();

        var page = new NpgsqlBatchCommand();
        var sql = new StringBuilder();
        if (populate)
        {
            sql.Append("SELECT ").Append(PopulatedColumns).Append(" FROM (SELECT ").Append(Columns).Append(" FROM organizations");
            Query.AppendWhere(sql, list.Where, page);
            Query.AppendOrder(sql, list.Sort, "");
            Query.AppendPage(sql, list, page);
            sql.Append(") o ").Append(PopulatedJoin);
            Query.AppendOrder(sql, list.Sort, "o.");
            sql.Append(", m.position");
        }
        else
        {
            sql.Append("SELECT ").Append(Columns);
            if ((mask & MembersBit) != 0) sql.Append(", ").Append(MemberIds);
            sql.Append(" FROM organizations");
            Query.AppendWhere(sql, list.Where, page);
            Query.AppendOrder(sql, list.Sort, "");
            Query.AppendPage(sql, list, page);
        }
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
            await WriteRows(w, reader, mask, populate);
            w.WriteEndArray();
            w.WriteNumber("total"u8, total);
            w.WriteNumber("limit"u8, list.Limit);
            w.WriteNumber("offset"u8, list.Offset);
            w.WriteEndObject();
        }
        await buffer.SendAsync(ctx, 200);
    }

    // GET /organizations/{id}
    public static async Task Get(HttpContext ctx)
    {
        var id = (string)ctx.Request.RouteValues["id"]!;
        var query = Query.Parse(ctx.Request);
        var populate = Query.ParsePopulate(Entity, query);
        var mask = Query.ParseFields(Entity, query);
        populate &= (mask & MembersBit) != 0;

        var sql = populate
            ? $"SELECT {PopulatedColumns} FROM organizations o {PopulatedJoin} WHERE o.id = $1 ORDER BY m.position"
            : (mask & MembersBit) != 0
                ? $"SELECT {Columns}, {MemberIds} FROM organizations WHERE id = $1"
                : $"SELECT {Columns} FROM organizations WHERE id = $1";

        var buffer = JsonBuffer.Rent();
        await using (var cmd = Program.DataSource.CreateCommand(sql))
        {
            cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = id });
            await using var reader = await cmd.ExecuteReaderAsync();
            if (!await WriteRows(buffer.Writer, reader, mask, populate))
            {
                buffer.Return();
                throw NotFound();
            }
        }
        await buffer.SendAsync(ctx, 200);
    }

    // GET /organizations/{orgId}/stats: one aggregate; no row means no such organization.
    public static async Task GetStats(HttpContext ctx)
    {
        var id = (string)ctx.Request.RouteValues["orgId"]!;
        Stats stats;
        await using (var cmd = Program.DataSource.CreateCommand("""
            SELECT count(u.id), count(*) FILTER (WHERE u.role = 'admin'), avg(u.age)
            FROM organizations o
            LEFT JOIN (organizations__members m JOIN users u ON u.id = m.target_id) ON m.owner_id = o.id
            WHERE o.id = $1
            GROUP BY o.id
            """))
        {
            cmd.Parameters.Add(new NpgsqlParameter<string> { TypedValue = id });
            await using var reader = await cmd.ExecuteReaderAsync();
            if (!await reader.ReadAsync()) throw NotFound();
            stats = new Stats(reader.GetInt64(0), reader.GetInt64(1), reader.IsDBNull(2) ? null : reader.GetDouble(2));
        }
        await Json.Send(ctx, 200, stats, AppJson.Default.Stats);
    }

    private static ApiError NotFound() => new(404, "Organization not found");
}
