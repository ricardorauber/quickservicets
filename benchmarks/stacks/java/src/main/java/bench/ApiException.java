package bench;

import java.util.List;

/** An error answered with {"error":{"code","message","details"?}}; the code follows from the status. */
public class ApiException extends RuntimeException {
  public record Detail(String field, String message) {}

  private final int status;
  private final List<Detail> details;

  public ApiException(int status, String message, List<Detail> details) {
    super(message, null, false, false);
    this.status = status;
    this.details = details;
  }

  public ApiException(int status, String message) {
    this(status, message, null);
  }

  public static ApiException invalidBody(List<Detail> details) {
    return new ApiException(400, "Invalid body", details);
  }

  public static ApiException invalidBody(String field, String message) {
    return invalidBody(List.of(new Detail(field, message)));
  }

  public static ApiException notFound(String message) {
    return new ApiException(404, message);
  }

  public int status() {
    return status;
  }

  public List<Detail> details() {
    return details;
  }
}
