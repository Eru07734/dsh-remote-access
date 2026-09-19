package ai.deepseek.dshpad;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

/**
 * Persisted connection settings: the DSH server authority and the process launch token.
 *
 * <p>The token is the only credential DSH's browser auth accepts at the application root.
 * Exchanging it once mints a signed HttpOnly cookie bound to the request authority, so the
 * WebView keeps working from the cookie store until DSH is restarted with a new token.
 */
public final class Prefs {

    private static final String FILE = "dshpad";
    private static final String KEY_SERVER = "server";
    private static final String KEY_TOKEN = "token";

    /** Tailnet address of the host running {@code dsh web}. */
    public static final String DEFAULT_SERVER = "<host-tailnet-ip>:3080";

    private Prefs() {
    }

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public static String server(Context c) {
        String v = sp(c).getString(KEY_SERVER, DEFAULT_SERVER);
        return v == null ? DEFAULT_SERVER : v;
    }

    public static String token(Context c) {
        String v = sp(c).getString(KEY_TOKEN, "");
        return v == null ? "" : v;
    }

    public static void save(Context c, String server, String token) {
        sp(c).edit().putString(KEY_SERVER, normalizeServer(server)).putString(KEY_TOKEN, token).apply();
    }

    public static boolean isConfigured(Context c) {
        return !token(c).isEmpty() && !server(c).isEmpty();
    }

    public static void clear(Context c) {
        sp(c).edit().clear().apply();
    }

    /** Reduce a pasted URL or bare authority to a {@code host[:port]} authority. */
    public static String normalizeServer(String raw) {
        if (raw == null) return DEFAULT_SERVER;
        String s = raw.trim();
        if (s.isEmpty()) return DEFAULT_SERVER;
        int scheme = s.indexOf("://");
        if (scheme >= 0) s = s.substring(scheme + 3);
        int slash = s.indexOf('/');
        if (slash >= 0) s = s.substring(0, slash);
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        return s.isEmpty() ? DEFAULT_SERVER : s;
    }

    /**
     * Extract the {@code token} query parameter from anything the user pasted: a full
     * {@code dsh web} URL, or a bare token.
     */
    public static String extractToken(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.isEmpty()) return "";
        if (s.contains("token=")) {
            try {
                String t = Uri.parse(s).getQueryParameter("token");
                if (t != null && !t.isEmpty()) return t;
            } catch (Throwable ignored) {
                // fall through to manual parsing
            }
            int i = s.indexOf("token=");
            String rest = s.substring(i + "token=".length());
            int amp = rest.indexOf('&');
            if (amp >= 0) rest = rest.substring(0, amp);
            int hash = rest.indexOf('#');
            if (hash >= 0) rest = rest.substring(0, hash);
            return rest.trim();
        }
        return s;
    }

    /** Authority carried by a pasted URL, or empty when the text is a bare token. */
    public static String extractAuthority(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (!s.contains("://") && !s.contains(":")) return "";
        if (!s.contains("://")) return "";
        return normalizeServer(s);
    }
}
