package com.rea.ui.probe;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Self-owned UI oracle; it requests no permissions and performs no network I/O. */
public final class Main extends Activity {
  private int taps = 0;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    EditText input = new EditText(this);
    input.setSingleLine(true);
    input.setContentDescription("rea-input");
    layout.addView(input);
    Button button = new Button(this);
    button.setText("Tap");
    button.setContentDescription("rea-tap");
    layout.addView(button);
    TextView status = new TextView(this);
    status.setContentDescription("rea-status");
    status.setText("Tapped 0");
    layout.addView(status);
    button.setOnClickListener(view -> status.setText("Tapped " + (++taps)));
    ScrollView scroll = new ScrollView(this);
    scroll.setContentDescription("rea-scroll");
    LinearLayout rows = new LinearLayout(this);
    rows.setOrientation(LinearLayout.VERTICAL);
    for (int index = 0; index < 40; index++) {
      TextView row = new TextView(this);
      row.setText("Row " + index);
      row.setTextSize(24);
      row.setPadding(8, 20, 8, 20);
      rows.addView(row);
    }
    scroll.addView(rows);
    layout.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(layout);
  }
}
