package bench;

import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/** Maps every failure to the contract's error body. */
@RestControllerAdvice
public class ErrorHandler {
  private static final Logger log = LoggerFactory.getLogger(ErrorHandler.class);

  static String codeOf(int status) {
    return switch (status) {
      case 400 -> "VALIDATION_ERROR";
      case 404 -> "NOT_FOUND";
      case 405 -> "METHOD_NOT_ALLOWED";
      case 409 -> "CONFLICT";
      case 413 -> "PAYLOAD_TOO_LARGE";
      case 415 -> "UNSUPPORTED_MEDIA_TYPE";
      default -> "INTERNAL_ERROR";
    };
  }

  static Map<String, Object> errorBody(ApiException e) {
    Map<String, Object> error = new LinkedHashMap<>(4);
    error.put("code", codeOf(e.status()));
    error.put("message", e.getMessage());
    if (e.details() != null) error.put("details", e.details());
    return Map.of("error", error);
  }

  static ResponseEntity<Object> body(ApiException e) {
    return ResponseEntity.status(e.status()).body(errorBody(e));
  }

  @ExceptionHandler(ApiException.class)
  ResponseEntity<Object> api(ApiException e) {
    return body(e);
  }

  @ExceptionHandler({NoHandlerFoundException.class, NoResourceFoundException.class})
  ResponseEntity<Object> noRoute(Exception e) {
    return body(ApiException.notFound("Route not found"));
  }

  @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
  ResponseEntity<Object> method(HttpRequestMethodNotSupportedException e) {
    ResponseEntity.BodyBuilder response = ResponseEntity.status(405);
    if (e.getSupportedHttpMethods() != null) response.allow(e.getSupportedHttpMethods().toArray(HttpMethod[]::new));
    return response.body(errorBody(new ApiException(405, "Method not allowed")));
  }

  @ExceptionHandler(MaxUploadSizeExceededException.class)
  ResponseEntity<Object> tooLarge(MaxUploadSizeExceededException e) {
    return body(new ApiException(413, "File too large"));
  }

  @ExceptionHandler(MultipartException.class)
  ResponseEntity<Object> multipart(MultipartException e) {
    return body(ApiException.invalidBody("", "Invalid multipart body"));
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<Object> internal(Exception e) {
    log.error("Unhandled error", e);
    return body(new ApiException(500, "Internal server error"));
  }
}
