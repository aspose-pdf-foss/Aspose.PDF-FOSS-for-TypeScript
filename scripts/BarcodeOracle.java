// The decoder half of scripts/gen-barcode-goldens.ts: reads symbols our
// encoders drew and asks ZXing to read them back. Not run by `npm test`.
//
// Input, one symbol per line on stdin:
//   name TAB kind TAB width TAB height TAB rowHeight TAB bits ('0'/'1', row-major)
// Output, one line per symbol on stdout:
//   name TAB OK TAB errorsCorrected TAB base64(UTF-8 text)   or   name TAB FAIL TAB message
//
// A Data Matrix is decoded twice: by the image reader (finding, sampling) for
// the text, and by the module decoder on the exact matrix, whose
// errorsCorrected is the number the goldens must hold at zero. A PDF417 has no
// matrix-level decoder in the public API, so its count comes from the image
// reader's own ERRORS_CORRECTED metadata.
import com.google.zxing.*;
import com.google.zxing.common.*;
import com.google.zxing.datamatrix.DataMatrixReader;
import com.google.zxing.datamatrix.decoder.Decoder;
import com.google.zxing.pdf417.PDF417Reader;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public final class BarcodeOracle {
  public static void main(String[] args) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream out = new PrintStream(System.out, true, "UTF-8");
    for (String line; (line = in.readLine()) != null; ) {
      if (line.isEmpty()) continue;
      String[] f = line.split("\t");
      String name = f[0], kind = f[1];
      if (kind.equals("dmwrite")) {
        // ZXing's OWN encoder, for comparing modules rather than decoded text:
        //   name TAB dmwrite TAB base64(text)  ->  name TAB OK TAB width TAB height TAB bits
        try {
          String text = new String(Base64.getDecoder().decode(f[2]), StandardCharsets.UTF_8);
          Map<EncodeHintType, Object> h = new EnumMap<>(EncodeHintType.class);
          h.put(EncodeHintType.DATA_MATRIX_SHAPE, com.google.zxing.datamatrix.encoder.SymbolShapeHint.FORCE_SQUARE);
          BitMatrix m = new com.google.zxing.datamatrix.DataMatrixWriter().encode(text, BarcodeFormat.DATA_MATRIX, 0, 0, h);
          StringBuilder sb = new StringBuilder();
          for (int y = 0; y < m.getHeight(); y++) for (int x = 0; x < m.getWidth(); x++) sb.append(m.get(x, y) ? '1' : '0');
          out.println(name + "\tOK\t" + m.getWidth() + "\t" + m.getHeight() + "\t" + sb);
        } catch (Exception e) {
          out.println(name + "\tFAIL\t" + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        continue;
      }
      int w = Integer.parseInt(f[2]), h = Integer.parseInt(f[3]), rh = Integer.parseInt(f[4]);
      String bits = f[5];
      try {
        out.println(name + "\tOK\t" + decode(kind, w, h, rh, bits));
      } catch (Exception e) {
        out.println(name + "\tFAIL\t" + e.getClass().getSimpleName() + ": " + e.getMessage());
      }
    }
  }

  static String decode(String kind, int w, int h, int rh, String bits) throws Exception {
    int scale = 4, quiet = 10;
    BitMatrix img = new BitMatrix((w + 2 * quiet) * scale, (h * rh + 2 * quiet) * scale);
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      if (bits.charAt(y * w + x) != '1') continue;
      img.setRegion((quiet + x) * scale, (quiet + y * rh) * scale, scale, rh * scale);
    }
    BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(new BitMatrixSource(img)));
    Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
    Result r;
    int errors;
    if (kind.equals("pdf417")) {
      r = new PDF417Reader().decode(bitmap, hints);
      Object e = r.getResultMetadata() == null ? null : r.getResultMetadata().get(ResultMetadataType.ERRORS_CORRECTED);
      if (e == null) throw new IllegalStateException("no ERRORS_CORRECTED metadata");
      errors = (Integer) e;
    } else {
      hints.put(DecodeHintType.PURE_BARCODE, Boolean.TRUE);
      r = new DataMatrixReader().decode(bitmap, hints);
      boolean[][] m = new boolean[h][w];
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) m[y][x] = bits.charAt(y * w + x) == '1';
      DecoderResult dr = new Decoder().decode(m);
      if (!dr.getText().equals(r.getText())) throw new IllegalStateException("module decoder and reader disagree");
      errors = dr.getErrorsCorrected();
    }
    return errors + "\t" + Base64.getEncoder().encodeToString(r.getText().getBytes(StandardCharsets.UTF_8));
  }

  /** A BitMatrix as a luminance source: set bits black. */
  static final class BitMatrixSource extends LuminanceSource {
    private final BitMatrix m;
    BitMatrixSource(BitMatrix m) { super(m.getWidth(), m.getHeight()); this.m = m; }
    @Override public byte[] getRow(int y, byte[] row) {
      if (row == null || row.length < getWidth()) row = new byte[getWidth()];
      for (int x = 0; x < getWidth(); x++) row[x] = (byte) (m.get(x, y) ? 0 : 255);
      return row;
    }
    @Override public byte[] getMatrix() {
      byte[] out = new byte[getWidth() * getHeight()];
      for (int y = 0; y < getHeight(); y++) for (int x = 0; x < getWidth(); x++)
        out[y * getWidth() + x] = (byte) (m.get(x, y) ? 0 : 255);
      return out;
    }
  }
}
