package org.networksignage.kiosk;

import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Tries to open the kiosk after the device starts.
 *
 * <p>What's expected, none of which has been proven on a device yet:
 * <ul>
 * <li>Android 9 and older, including Fire OS 7 and earlier: this should work.
 * <li>Android 10 and newer, including Fire OS 8 and Google TV: the platform blocks background
 *     apps from opening activities, so startActivity is expected to do nothing unless the person
 *     has granted SYSTEM_ALERT_WINDOW. It usually fails silently, with only a log line from the
 *     system. There's no way to detect it here.
 * <li>Device makers can change any of this, and Android doesn't deliver this broadcast at all
 *     until the app has been opened once by hand.
 * </ul>
 *
 * <p>When blocked, the TV sits on its home screen until someone opens the app.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "SignageBoot";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        // A TV that was never set up shouldn't open to the setup screen by itself.
        if (new ServerStore(context).address() == null) return;
        Intent start = new Intent(context, KioskActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(start);
        } catch (ActivityNotFoundException | SecurityException e) {
            Log.w(TAG, "Couldn't open the kiosk after boot", e);
        }
    }
}
