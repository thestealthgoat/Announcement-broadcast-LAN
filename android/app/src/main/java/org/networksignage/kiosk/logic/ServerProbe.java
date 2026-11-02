package org.networksignage.kiosk.logic;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;

/** Whether an address really is an answering server. Blocks, so never call it on the main thread. */
public final class ServerProbe {
    private ServerProbe() {}

    /**
     * NsdManager hands over only one of a host's addresses, and it can be one this TV can't reach,
     * such as a virtual network adapter's. So a discovered address is tried before it's saved.
     */
    public static boolean responds(ServerAddress address, int timeoutMs) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(address.playerUrl()).openConnection();
            connection.setConnectTimeout(timeoutMs);
            connection.setReadTimeout(timeoutMs);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            return connection.getResponseCode() == HttpURLConnection.HTTP_OK;
        } catch (IOException | RuntimeException e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
