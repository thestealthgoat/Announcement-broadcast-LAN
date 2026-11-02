package org.networksignage.kiosk;

import android.content.Context;
import android.content.SharedPreferences;

import org.networksignage.kiosk.logic.ServerAddress;

/** The remembered server. */
final class ServerStore {
    private static final String KEY_ORIGIN = "server_origin";
    private static final String KEY_SERVICE = "server_service_name";
    private static final String KEY_ID = "server_id";

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

    /** The server's lasting ID. Null if it's unknown, or the server is too old to have one. */
    String serverId() {
        return prefs.getString(KEY_ID, null);
    }

    void save(ServerAddress address, String serviceName, String serverId) {
        prefs.edit()
            .putString(KEY_ORIGIN, address.origin())
            .putString(KEY_SERVICE, serviceName)
            .putString(KEY_ID, serverId)
            .apply();
    }
}
