package bench;

import java.security.SecureRandom;

/** UUID version 7 (RFC 9562): 48-bit Unix time in milliseconds, then random bits, in lowercase canonical form. */
public final class Uuid7 {
  private Uuid7() {}

  private static final SecureRandom RANDOM = new SecureRandom();
  private static final char[] HEX = "0123456789abcdef".toCharArray();

  public static String generate() {
    byte[] bytes = new byte[16];
    RANDOM.nextBytes(bytes);
    long millis = System.currentTimeMillis();
    for (int i = 0; i < 6; i++) bytes[i] = (byte) (millis >>> (40 - 8 * i));
    bytes[6] = (byte) ((bytes[6] & 0x0f) | 0x70);
    bytes[8] = (byte) ((bytes[8] & 0x3f) | 0x80);
    char[] out = new char[36];
    int position = 0;
    for (int i = 0; i < 16; i++) {
      if (i == 4 || i == 6 || i == 8 || i == 10) out[position++] = '-';
      out[position++] = HEX[(bytes[i] >> 4) & 0x0f];
      out[position++] = HEX[bytes[i] & 0x0f];
    }
    return new String(out);
  }
}
