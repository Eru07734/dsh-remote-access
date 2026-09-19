package ai.deepseek.dshpad;

import android.app.Activity;
import android.os.Bundle;
import android.text.TextUtils;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

/**
 * One-screen connection setup. The user pastes either a bare token or the whole URL printed
 * by {@code dsh web}; a URL also supplies the authority when the server field is left blank.
 */
public class SettingsActivity extends Activity {

    private EditText serverField;
    private EditText tokenField;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        serverField = findViewById(R.id.server);
        tokenField = findViewById(R.id.token);
        Button save = findViewById(R.id.save);
        Button reset = findViewById(R.id.reset);

        serverField.setText(Prefs.server(this));
        tokenField.setText(Prefs.token(this));

        save.setOnClickListener(v -> {
            String raw = tokenField.getText().toString().trim();
            String token = Prefs.extractToken(raw);

            String typedServer = serverField.getText().toString().trim();
            String fromUrl = Prefs.extractAuthority(raw);
            String server = typedServer.isEmpty() ? fromUrl : typedServer;
            if (server.isEmpty()) server = Prefs.DEFAULT_SERVER;

            if (TextUtils.isEmpty(token)) {
                Toast.makeText(this, R.string.token_required, Toast.LENGTH_LONG).show();
                return;
            }

            Prefs.save(this, server, token);
            Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show();
            finish();
        });

        reset.setOnClickListener(v -> {
            serverField.setText(Prefs.DEFAULT_SERVER);
            tokenField.setText("");
        });
    }
}
