package bench;

import jakarta.servlet.http.HttpServletRequest;
import java.sql.Array;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrganizationController {
  private static final String COLUMNS = "id, created_at, updated_at, name, slug";

  private static final RowMapper<Map<String, Object>> ROW = (rs, n) -> {
    Map<String, Object> organization = new LinkedHashMap<>(8);
    organization.put("id", rs.getString(1));
    organization.put("createdAt", Values.timestamp(rs, 2));
    organization.put("updatedAt", Values.timestamp(rs, 3));
    organization.put("name", rs.getString(4));
    organization.put("slug", rs.getString(5));
    return organization;
  };

  private final JdbcTemplate jdbc;

  public OrganizationController(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @GetMapping("/organizations")
  public Map<String, Object> list(HttpServletRequest request) {
    Map<String, String[]> params = request.getParameterMap();
    List<String> fields = Query.fields(params, Collection.ORGANIZATIONS);
    Query.ListQuery query = Query.list(params, Collection.ORGANIZATIONS);
    boolean populate = Query.populate(params, Collection.ORGANIZATIONS);
    Long total = jdbc.queryForObject("SELECT count(*) FROM organizations" + query.where(), Long.class, query.args().toArray());
    List<Object> pageArgs = new ArrayList<>(query.args());
    pageArgs.add(query.limit());
    pageArgs.add(query.offset());
    List<Map<String, Object>> organizations = jdbc.query(
        "SELECT " + COLUMNS + " FROM organizations" + query.where() + " ORDER BY " + query.orderBy() + " LIMIT ? OFFSET ?",
        ROW, pageArgs.toArray());
    if (fields == null || fields.contains("members")) addMembers(organizations, populate);
    List<Map<String, Object>> data = new ArrayList<>(organizations.size());
    for (Map<String, Object> organization : organizations) data.add(UserController.select(organization, fields));
    return UserController.page(data, total, query);
  }

  @GetMapping("/organizations/{id}")
  public Map<String, Object> read(@PathVariable String id, HttpServletRequest request) {
    Map<String, String[]> params = request.getParameterMap();
    List<String> fields = Query.fields(params, Collection.ORGANIZATIONS);
    boolean populate = Query.populate(params, Collection.ORGANIZATIONS);
    List<Map<String, Object>> rows = jdbc.query("SELECT " + COLUMNS + " FROM organizations WHERE id = ?", ROW, id);
    if (rows.isEmpty()) throw ApiException.notFound("Organization not found");
    if (fields == null || fields.contains("members")) addMembers(rows, populate);
    return UserController.select(rows.get(0), fields);
  }

  @GetMapping("/organizations/{orgId}/stats")
  public Map<String, Object> stats(@PathVariable String orgId) {
    List<Map<String, Object>> rows = jdbc.query("""
        SELECT count(u.id), count(*) FILTER (WHERE u.role = 'admin'), avg(u.age)
        FROM organizations o
        LEFT JOIN organizations__members m ON m.owner_id = o.id
        LEFT JOIN users u ON u.id = m.target_id
        WHERE o.id = ?
        GROUP BY o.id""", (rs, n) -> {
      Map<String, Object> stats = new LinkedHashMap<>(4);
      stats.put("members", rs.getLong(1));
      stats.put("admins", rs.getLong(2));
      double average = rs.getDouble(3);
      stats.put("averageAge", rs.wasNull() ? null : average);
      return stats;
    }, orgId);
    if (rows.isEmpty()) throw ApiException.notFound("Organization not found");
    return rows.get(0);
  }

  /**
   * Sets {@code members} on every organization with one query for the whole page: the member ids, or with
   * {@code populate} the member records, in position order.
   */
  private void addMembers(List<Map<String, Object>> organizations, boolean populate) {
    if (organizations.isEmpty()) return;
    Map<String, List<Object>> members = new HashMap<>(organizations.size() * 2);
    String[] ids = new String[organizations.size()];
    for (int i = 0; i < ids.length; i++) {
      List<Object> list = new ArrayList<>();
      organizations.get(i).put("members", list);
      ids[i] = (String) organizations.get(i).get("id");
      members.put(ids[i], list);
    }
    String sql = populate
        ? "SELECT m.owner_id, u.id, u.created_at, u.updated_at, u.email, u.name, u.role, u.age"
            + " FROM organizations__members m JOIN users u ON u.id = m.target_id"
            + " WHERE m.owner_id = ANY(?) ORDER BY m.owner_id, m.position"
        : "SELECT owner_id, target_id FROM organizations__members WHERE owner_id = ANY(?) ORDER BY owner_id, position";
    jdbc.query(connection -> {
      PreparedStatement statement = connection.prepareStatement(sql);
      Array array = connection.createArrayOf("text", ids);
      statement.setArray(1, array);
      return statement;
    }, (RowCallbackHandler) rs -> {
      List<Object> list = members.get(rs.getString(1));
      list.add(populate ? UserController.user(rs, 2) : rs.getString(2));
    });
  }
}
