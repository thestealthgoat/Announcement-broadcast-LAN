package org.networksignage.kiosk;

import android.content.Context;
import android.content.SharedPreferences;

import org.networksignage.kiosk.logic.ServerAddress;

/** The remembered server. */
final class ServerStore {
    private static final String KEY_ORIGIN = "server_origin";
    private static final String KEY_SERVICE = "server_service_name";

    private final SharedPreferences prefs;

    ServerStore(Context context) {
        prefs = context.getSharedPreferences("kiosk", Context.MODE_PRIVATE);
    }

    ServerAddress address() {
        return ServerAddress.parse(prefs.getString(KEY_ORIGIN, null));
    }

    /** The mDNS service this server was found as. Null if it's unknown. */
    String serviceName() {
        return prefs.getString(KEY_SERVICE, null);
    }

    void save(ServerAddress address, String serviceName) {
        prefs.edit()
            .putString(KEY_ORIGIN, address.origin())
            .putString(KEY_SERVICE, serviceName)
            .apply();
    }
}
