package bench;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoUnit;

/** Conversions between database values and their JSON form. */
public final class Values {
  private Values() {}

  /** UTC with exactly three fractional digits, as JavaScript's Date.prototype.toISOString. */
  private static final DateTimeFormatter ISO_MILLIS = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();

  /** The current time, truncated to milliseconds so that what is stored is what is returned. */
  public static OffsetDateTime now() {
    return OffsetDateTime.ofInstant(Instant.now().truncatedTo(ChronoUnit.MILLIS), ZoneOffset.UTC);
  }

  public static String iso(OffsetDateTime time) {
    return ISO_MILLIS.format(time);
  }

  public static String timestamp(ResultSet rs, int column) throws SQLException {
    return iso(rs.getObject(column, OffsetDateTime.class));
  }

  /** A double precision column as a JSON number: integral values become integers. */
  public static Object number(double value) {
    if (value == Math.rint(value) && Math.abs(value) < 9.007199254740992E15) return (long) value;
    return value;
  }

  /** A nullable double precision column. */
  public static Object nullableNumber(ResultSet rs, int column) throws SQLException {
    double value = rs.getDouble(column);
    return rs.wasNull() ? null : number(value);
  }
}
